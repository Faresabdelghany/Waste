// The Billing Run as the office asks for it and reads it (Issue #112 §3,
// §5; ADR-0005): "a controlled batch that converts eligible billable events
// into invoices" (CONTEXT.md). `POST /billing-runs` runs one, synchronously
// in the request's transaction; `POST /billing-runs/preview` runs the same
// selection and grouping and writes nothing; `GET /billing-runs` lists the
// runs and `GET /billing-runs/:id` reads one with the payers it excluded and
// the invoices it issued. No patch and no delete: a run is the record of
// what it did, frozen once `completed`.
//
// `runBilling` is the run, shaped for the worker as `openTicket` is: over
// `tx`, a company, a project, the period, the note, who asked and an id
// minter and a clock — never a Principal or a Context — so the scheduled run
// of part B calls it with `null` for the person. Under `lockRow(project)`,
// so two runs of one project take turns, it selects every `pickup`, `ticket`,
// `manual` and `reversal` event of the project whose service date lies in
// the period and whose reading is `ready` — priced, not cancelled, not on an
// invoice line, not reversed (a reversed original stays on its invoice; the
// reversal is what is selected) — refuses a selection above
// `BILLING_RUN_MAX_EVENTS` (409: a run is one transaction), groups the rest
// by payer (`agreement.payer_customer_id`) and currency, and for each group
// issues one invoice through routes/invoice-writes.ts: the next number of
// the company's series, `issued_on` today on the project's clock, `due_on`
// thirty days on (`PAYMENT_TERMS_DAYS`), the lines in a fixed order —
// agreement number, service date, product name, event id — each one event,
// its description the product's invoice name (or its name) and the service
// date, a reversal a negative line, and one `invoice-issued` per document in
// the same transaction. A payer whose events in the period are all blocked
// gets a `billing_run_exclusion` row and no invoice, so no customer is
// silently skipped; a blocked event is never invoiced and never re-evaluated
// here — `reprice` is its door. No status gates the payer (§7.15): an
// invoice records delivered work, and a customer gone inactive is invoiced
// for it. The run's row is written `completed` with its counts and totals —
// the totals over every currency summed as integers; a report reads the
// invoices for a per-currency figure — before the invoices, since they name
// it. A run with nothing ready is a completed run of zero invoices. The
// database's word behind the selection is `invoice_line_billable_event_id_idx`,
// an event on one line of one invoice, and its 409 is the backstop for a
// race the project's lock prevents.
//
// Every statement carries the tenant and `inProjects`; the grant is
// `commercial.billing`, `view` to read and to preview, `create` to run.
import { BillingRun, BillingRunCreate, BillingRunDetail, BillingRunListQuery, BillingRunPreview } from "@waste/contracts/billing"
import { Page } from "@waste/contracts/pagination"
import type { Tx } from "@waste/db/client"
import { agreement } from "@waste/db/schema/agreements"
import { product } from "@waste/db/schema/catalogue"
import { billableEvent, billingRun, billingRunExclusion, invoiceLine } from "@waste/db/schema/finance"
import { project } from "@waste/db/schema/organisation"
import { PAYMENT_TERMS_DAYS } from "@waste/domain/finance/money"
import { addDays } from "@waste/domain/route-schemes/recurrence"
import { and, asc, count, eq, gt, gte, isNotNull, isNull, lte, notExists, sql, type SQL } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv } from "../auth/principal"
import { requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId, type IdMinter } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, problem, validate } from "../problem"
import { eventColumns, exclusionColumns, exclusionOf, findRun, noSuchRun, runColumns, runDetailOf, runOf, runScope, type EventRow, type ExclusionRow, type RunRow } from "./billing-shapes"
import { dayInTimezone } from "./days"
import { projectTimezone } from "./fleet-lookups"
import { issueInvoice, type LineDraft } from "./invoice-writes"
import type { Scope } from "./references"
import type { ClockOptions } from "./scheme-groups"
import { created, describeCreated, describeJson, IdParam, lockRow } from "./shared"

const MODULE = "commercial.billing"

const RunPage = Page(BillingRun)

/** The most ready events one run takes: a run is one transaction, and a thousand invoices is what Postgres is for; past this, narrow the period (§7.2, §7.9). */
export const BILLING_RUN_MAX_EVENTS = 5000

/** A count spelled with its thousands grouped by a space, as the sentence below reads: `5 214`. */
const grouped = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ")

/** What a run over more ready events than one transaction should take is told. */
export const tooManyEvents = (ready: number): string => `${grouped(ready)} ready events fall in the period; narrow it — a run is one transaction`

/** The period a run selects: both service dates inclusive. */
export type BillingPeriod = { periodFrom: string; periodTo: string }

/** A ready event with what its lines and its grouping read beside it: the agreement's number and payer, the product's two names. */
type ReadyEvent = EventRow & { agreementNumber: string; payerCustomerId: string; productName: string; invoiceName: string | null }

/** One invoice to issue: a payer's events in one currency, with their totals. */
type Group = { payerCustomerId: string; currency: string; events: ReadyEvent[]; netMinor: number; vatMinor: number }

/** A payer with events in the period and nothing to invoice: every one of them blocked. */
type Excluded = { customerId: string; eventCount: number }

/** What a run or a preview finds: the ready events in line order, the groups in numbering order, and the payers excluded. */
export type Selection = { events: ReadyEvent[]; groups: Group[]; exclusions: Excluded[] }

/** The events of the project whose service date lies in the period and that were not cancelled. */
const inPeriod = (scope: Scope, period: BillingPeriod): SQL | undefined =>
  and(
    eq(billableEvent.companyId, scope.companyId),
    eq(billableEvent.projectId, scope.projectId),
    gte(billableEvent.serviceDate, period.periodFrom),
    lte(billableEvent.serviceDate, period.periodTo),
    isNull(billableEvent.cancelledAt),
  )

/** The `ready` reading as a `where`: priced, not cancelled, no line naming it, no reversal naming it. */
function ready(tx: Tx, scope: Scope, period: BillingPeriod): SQL | undefined {
  const reversal = alias(billableEvent, "reversal")
  return and(
    inPeriod(scope, period),
    isNull(billableEvent.blockReason),
    notExists(
      tx
        .select({ one: sql`1` })
        .from(invoiceLine)
        .where(and(eq(invoiceLine.companyId, scope.companyId), eq(invoiceLine.billableEventId, billableEvent.id))),
    ),
    notExists(
      tx
        .select({ one: sql`1` })
        .from(reversal)
        .where(and(eq(reversal.companyId, scope.companyId), eq(reversal.reversesEventId, billableEvent.id))),
    ),
  )
}

/**
 * The selection and the grouping, as the run and the preview both make them:
 * the ready count first (the ceiling is a 409 before a single row is read
 * whole), then the ready events in line order, then the blocked events per
 * payer — a blocked event with no agreement (`no-subscription`) names no
 * payer and is nobody's exclusion — and the payers among them with nothing
 * ready. The groups are ordered by payer and then currency, so two runs over
 * the same events number their invoices the same way.
 */
export async function selectBilling(tx: Tx, scope: Scope, period: BillingPeriod): Promise<Selection> {
  const [counted] = await tx.select({ rows: count() }).from(billableEvent).where(ready(tx, scope, period))
  const readyCount = counted?.rows ?? 0
  if (readyCount > BILLING_RUN_MAX_EVENTS) throw problem(409, { detail: tooManyEvents(readyCount) })
  // The agreement and the product every ready event names, joined for the grouping and the line's text.
  const events: ReadyEvent[] = await tx
    .select({ ...eventColumns, agreementNumber: agreement.number, payerCustomerId: agreement.payerCustomerId, productName: product.name, invoiceName: product.invoiceName })
    .from(billableEvent)
    .innerJoin(agreement, and(eq(agreement.companyId, billableEvent.companyId), eq(agreement.id, billableEvent.agreementId)))
    .innerJoin(product, and(eq(product.companyId, billableEvent.companyId), eq(product.id, billableEvent.productId)))
    .where(ready(tx, scope, period))
    .orderBy(asc(agreement.number), asc(billableEvent.serviceDate), asc(product.name), asc(billableEvent.id))
  const blocked = await tx
    .select({ customerId: agreement.payerCustomerId, events: count() })
    .from(billableEvent)
    .innerJoin(agreement, and(eq(agreement.companyId, billableEvent.companyId), eq(agreement.id, billableEvent.agreementId)))
    .where(and(inPeriod(scope, period), isNotNull(billableEvent.blockReason)))
    .groupBy(agreement.payerCustomerId)
    .orderBy(asc(agreement.payerCustomerId))

  const groups = new Map<string, Group>()
  for (const event of events) {
    // A ready event is priced, so its currency, unit price, net and VAT are there; the shape check holds them together.
    if (event.currency === null || event.netMinor === null || event.vatMinor === null) throw new Error(`billable event ${event.id} is ready and carries no price`)
    const key = `${event.payerCustomerId}/${event.currency}`
    const group = groups.get(key) ?? { payerCustomerId: event.payerCustomerId, currency: event.currency, events: [], netMinor: 0, vatMinor: 0 }
    group.events.push(event)
    group.netMinor += event.netMinor
    group.vatMinor += event.vatMinor
    groups.set(key, group)
  }
  const invoiced = new Set([...groups.values()].map((group) => group.payerCustomerId))
  const ordered = [...groups.values()].sort((a, b) => (a.payerCustomerId < b.payerCustomerId ? -1 : a.payerCustomerId > b.payerCustomerId ? 1 : a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0))
  return {
    events,
    groups: ordered,
    exclusions: blocked.filter((payer) => !invoiced.has(payer.customerId)).map((payer) => ({ customerId: payer.customerId, eventCount: payer.events })),
  }
}

/** What a preview answers: the counts, the totals per currency in currency order, and the payers a run would exclude; nothing written. */
export async function previewBilling(tx: Tx, scope: Scope, period: BillingPeriod): Promise<BillingRunPreview> {
  const selection = await selectBilling(tx, scope, period)
  const totals = new Map<string, { currency: string; netMinor: number; vatMinor: number }>()
  for (const group of selection.groups) {
    const total = totals.get(group.currency) ?? { currency: group.currency, netMinor: 0, vatMinor: 0 }
    total.netMinor += group.netMinor
    total.vatMinor += group.vatMinor
    totals.set(group.currency, total)
  }
  return {
    eventCount: selection.events.length,
    invoiceCount: selection.groups.length,
    totals: [...totals.values()].sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0)),
    exclusions: selection.exclusions.map((payer) => ({ ...payer, reason: "all-events-blocked" as const })),
  }
}

/** One event as its line: the frozen text, the product, the day, the amounts as the event froze them — a reversal's negative. */
function lineOfEvent(event: ReadyEvent): LineDraft {
  if (event.unitPriceMinor === null || event.netMinor === null || event.vatPercent === null || event.vatMinor === null) throw new Error(`billable event ${event.id} is ready and carries no price`)
  return {
    billableEventId: event.id,
    creditsLineId: null,
    description: `${event.invoiceName ?? event.productName} · ${event.serviceDate}`,
    productId: event.productId,
    serviceDate: event.serviceDate,
    quantity: event.quantity,
    unitPriceMinor: event.unitPriceMinor,
    netMinor: event.netMinor,
    vatPercent: event.vatPercent,
    vatMinor: event.vatMinor,
  }
}

export type RunBillingInput = BillingPeriod & {
  companyId: string
  projectId: string
  note: string | null
  /** The caller's account, or null for the worker's scheduled run; the invoices' `issuedBy` too. */
  requestedBy: string | null
  /** Mints the run's, the invoices', the lines' and the exclusions' ids. */
  newId: IdMinter
  /** The request's clock: today on the project's clock, the run's `completedAt`, and every `invoice-issued`'s `occurredAt`. */
  now: () => Date
}

/**
 * Runs billing for a project over a period, in the caller's transaction:
 * the project's lock, the selection, the run's row `completed` with its
 * counts and totals, one invoice per payer and currency with its lines and
 * its `invoice-issued`, and one exclusion per payer with nothing to invoice.
 * A refusal anywhere — the ceiling, a line another run wrote — leaves
 * nothing behind, the numbers included. Answers the run's row, its
 * exclusions and the ids of the invoices it issued, in numbering order.
 */
export async function runBilling(tx: Tx, input: RunBillingInput): Promise<{ run: RunRow; exclusions: ExclusionRow[]; invoiceIds: string[] }> {
  const { companyId, projectId } = input
  const scope: Scope = { companyId, projectId }
  await lockRow(tx, project, { companyId, id: projectId })
  const timezone = await projectTimezone(tx, companyId, projectId)
  const selection = await selectBilling(tx, scope, input)
  const at = input.now()
  const issuedOn = dayInTimezone(at, timezone)
  const dueOn = addDays(issuedOn, PAYMENT_TERMS_DAYS)
  const [run] = await tx
    .insert(billingRun)
    .values({
      id: input.newId(),
      companyId,
      projectId,
      periodFrom: input.periodFrom,
      periodTo: input.periodTo,
      status: "completed",
      requestedBy: input.requestedBy,
      completedAt: at,
      eventCount: selection.events.length,
      invoiceCount: selection.groups.length,
      excludedCustomerCount: selection.exclusions.length,
      netMinor: selection.groups.reduce((sum, group) => sum + group.netMinor, 0),
      vatMinor: selection.groups.reduce((sum, group) => sum + group.vatMinor, 0),
      note: input.note,
    })
    .returning(runColumns)
  const invoiceIds: string[] = []
  for (const group of selection.groups) {
    const issued = await issueInvoice(tx, {
      companyId,
      draft: {
        projectId,
        kind: "invoice",
        customerId: group.payerCustomerId,
        currency: group.currency,
        issuedOn,
        dueOn,
        periodFrom: input.periodFrom,
        periodTo: input.periodTo,
        billingRunId: run.id,
        creditsInvoiceId: null,
        creditReason: null,
        creditNote: null,
        issuedBy: input.requestedBy,
      },
      lines: group.events.map(lineOfEvent),
      newId: input.newId,
      now: () => at,
    })
    invoiceIds.push(issued.id)
  }
  const exclusions =
    selection.exclusions.length === 0
      ? []
      : await tx
          .insert(billingRunExclusion)
          .values(selection.exclusions.map((payer) => ({ id: input.newId(), companyId, projectId, billingRunId: run.id, customerId: payer.customerId, reason: "all-events-blocked", eventCount: payer.eventCount })))
          .returning(exclusionColumns)
  return { run, exclusions: exclusions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), invoiceIds }
}

const problems = (action: "view" | "create") => ({
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(`No active account here, or the caller's role does not allow \`${action}\` on \`${MODULE}\`.`),
})

const RUN_RULES =
  "The selection is every `pickup`, `ticket`, `manual` and `reversal` event of the project whose `serviceDate` lies in the period, both days inclusive, and whose reading is `ready` — priced, not cancelled, on no invoice line, not reversed (a reversed original stays on its invoice; the reversal is what is selected). A blocked event is never invoiced and never re-evaluated here; `reprice` is its door. The events are grouped by payer (`agreement.payerCustomerId`) and currency, one invoice per group, and a payer whose events in the period are all blocked is an exclusion with the reason `all-events-blocked` and the count, so no customer is silently skipped. No status gates the payer: an invoice records delivered work, and a customer gone inactive is invoiced for it."

export function billingRunRoutes(guard: MiddlewareHandler<AuthEnv>, { now = () => new Date() }: ClockOptions = {}) {
  return new Hono<AuthEnv>()
    .get(
      "/billing-runs",
      describeRoute({
        operationId: "listBillingRuns",
        summary: "The billing runs of the caller's projects",
        description:
          "One page of runs, oldest first (ids are time-ordered, so a cursor over them is a cursor over time), from the projects the caller works in — an account that works in none reads an empty page. `projectId` narrows it to one of those projects; naming another is refused. `status` is one of the three; `from` and `to` a window over `periodFrom`, both inclusive (`to` on or after `from`). Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of runs.", RunPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, a filter is malformed, the window runs backwards, or `projectId` is not a project this account works in."),
          ...problems("view"),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", BillingRunListQuery),
      async (c) => {
        const { limit, cursor, projectId, status, from, to } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await tx
          .select(runColumns)
          .from(billingRun)
          .where(
            and(
              runScope(principal),
              projectId === undefined ? undefined : eq(billingRun.projectId, projectId),
              status === undefined ? undefined : eq(billingRun.status, status),
              from === undefined ? undefined : gte(billingRun.periodFrom, from),
              to === undefined ? undefined : lte(billingRun.periodFrom, to),
              after === undefined ? undefined : gt(billingRun.id, after),
            ),
          )
          .orderBy(asc(billingRun.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(runOf), limit))
      },
    )
    .post(
      "/billing-runs",
      describeRoute({
        operationId: "createBillingRun",
        summary: "Run billing for a project over a period",
        description:
          "Runs billing synchronously, in the request's transaction, for a project the caller works in (400 at `projectId` otherwise) over the service dates `periodFrom` to `periodTo` (`periodTo` on or after `periodFrom`, 400 at `periodTo`). " +
          RUN_RULES +
          ` A selection above ${grouped(BILLING_RUN_MAX_EVENTS)} ready events is refused (409, \`5 214 ready events fall in the period; narrow it — a run is one transaction\`). Under the project's row lock, so two runs of one project take turns and the second finds only what the first left; two runs over overlapping periods are allowed for the same reason. For each group the run takes the next number of the company's series (\`INV-<n>\`, unbroken: a run that fails rolls its numbers back with its rows), writes the invoice — \`issuedOn\` today on the project's clock, \`dueOn\` ${PAYMENT_TERMS_DAYS} days on, the period, the totals summed from the lines — and its lines in a fixed order, agreement number, service date, product name, event id, each line one event with the product's invoice name (or its name) and the service date as its frozen text and the event's amounts, a reversal a negative line, and emits one \`invoice-issued\` per invoice in the same transaction, carrying the invoice with its lines as \`GET /invoices/{id}\` answers it. The run's row is written \`completed\` with its counts and its totals over every currency summed as integers; a run with nothing ready is a completed run of zero invoices. An event another run invoiced under this one is the backstop the project's lock makes unreachable (409, \`An event in the selection was invoiced by another run; run again\`).`,
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The run as completed, with its exclusions and the ids of the invoices it issued.", BillingRunDetail),
          400: describeProblem("The body is missing a field, names a member the server owns, runs its period backwards, or names a project this account does not work in — each at the field that is wrong."),
          ...problems("create"),
          409: describeProblem("More ready events fall in the period than one run takes, or another run invoiced an event of the selection; the detail says which."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", BillingRunCreate),
      async (c) => {
        const body: BillingRunCreate = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireProject(principal, body.projectId)
        const { run, exclusions, invoiceIds } = await runBilling(tx, {
          companyId: principal.companyId,
          projectId: body.projectId,
          periodFrom: body.periodFrom,
          periodTo: body.periodTo,
          note: body.note ?? null,
          requestedBy: principal.user.id,
          newId,
          now,
        })
        const detail: BillingRunDetail = { ...runOf(run), exclusions: exclusions.map(exclusionOf), invoiceIds }
        return created(c, "/billing-runs", detail)
      },
    )
    .post(
      "/billing-runs/preview",
      describeRoute({
        operationId: "previewBillingRun",
        summary: "What a run over a period would do, without doing it",
        description:
          "The dry run: the same body as `POST /billing-runs` — a POST because the body is a `BillingRunCreate` — the same selection and grouping, and nothing written: no run, no invoice, no number taken, no event emitted. Answers the count of ready events, the count of invoices a run would issue, the totals per currency, and the payers a run would exclude with the reason and how many of their events it found. " +
          RUN_RULES +
          ` A selection above ${grouped(BILLING_RUN_MAX_EVENTS)} ready events is refused as the run refuses it (409).`,
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The counts, the totals per currency and the exclusions a run would produce.", BillingRunPreview),
          400: describeProblem("The body is missing a field, names a member the server owns, runs its period backwards, or names a project this account does not work in — each at the field that is wrong."),
          ...problems("view"),
          409: describeProblem("More ready events fall in the period than one run takes."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("json", BillingRunCreate),
      async (c) => {
        const body: BillingRunCreate = c.req.valid("json")
        const principal = c.get("principal")
        requireProject(principal, body.projectId)
        return c.json(await previewBilling(c.get("tx"), { companyId: principal.companyId, projectId: body.projectId }, body))
      },
    )
    .get(
      "/billing-runs/:id",
      describeRoute({
        operationId: "getBillingRun",
        summary: "One billing run with its exclusions and its invoices",
        description:
          "One run of a project the caller works in, as completed: the period, who asked, the counts and the totals, the payers it excluded with the reason and how many of their events it found, and the ids of the invoices it issued in numbering order. A run of another company, or of a project this account does not work in, is a run that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The run, its exclusions and its invoice ids.", BillingRunDetail),
          400: describeProblem("The path does not hold an id."),
          ...problems("view"),
          404: describeProblem("No billing run with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await findRun(tx, principal, id)
        if (row === undefined) throw noSuchRun(id)
        return c.json(await runDetailOf(tx, principal.companyId, row))
      },
    )
}
