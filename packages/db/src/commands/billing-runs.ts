// The billing run, once (Issue #112 §3; lifted here from
// `apps/api/src/routes/billing-runs.ts` with the commands the worker runs,
// part B): "a controlled batch that converts eligible billable events into
// invoices" (CONTEXT.md). `POST /billing-runs` runs it synchronously in the
// request's transaction with the caller's account; the worker's scheduled run
// (`finance.run-billing`) runs the same function on its cadence with `null`
// for the person, so a run is one thing whichever process asks for it.
//
// `runBilling` is shaped for both as `openTicket` is: over `tx`, a company, a
// project, the period, the note, who asked, an id minter and a clock — never a
// Principal or a Context. Under `lockRow(project)`, so two runs of one
// project take turns, it selects every `pickup`, `ticket`, `manual` and
// `reversal` event of the project whose service date lies in the period and
// whose reading is `ready` — priced, not cancelled, not on an invoice line,
// not reversed (a reversed original stays on its invoice; the reversal is
// what is selected) — and reads them `for update`, since a cancellation
// (`POST /billable-events/:id/cancel`) takes the event's row lock before it
// reads and would otherwise stamp `cancelled_at` on an event the run is
// invoicing, a line the customer pays for a row the office thinks is gone:
// locked at the selection, the cancellation waits for the run and is then
// refused as invoiced. The lock is `of` the event alone, not the agreement
// and product it joins, so a pickup recorded under the agreement during the
// run is not held up; at most `BILLING_RUN_MAX_EVENTS` row locks, under the
// project's. It refuses a selection above `BILLING_RUN_MAX_EVENTS` (a
// `CommandRefused` the API answers 409: a run is one transaction), groups the
// rest by payer (`agreement.payer_customer_id`) and currency, and for each
// group issues one invoice through invoice-writes.ts: the next number of the
// company's series, `issued_on` today on the project's clock, `due_on`
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
// an event on one line of one invoice, and its refusal is the backstop for a
// race the project's lock prevents.
import type { BillingRunPreview } from "@waste/contracts/billing"
import { PAYMENT_TERMS_DAYS } from "@waste/domain/finance/money"
import { addDays } from "@waste/domain/route-schemes/recurrence"
import { and, asc, count, eq, getTableColumns, gte, isNotNull, isNull, lte, notExists, sql, type SQL } from "drizzle-orm"
import { alias, type PgColumn } from "drizzle-orm/pg-core"

import type { Tx } from "../client"
import type { IdMinter } from "../ids"
import { agreement } from "../schema/agreements"
import { product } from "../schema/catalogue"
import { billableEvent, billingRun, billingRunExclusion, invoiceLine } from "../schema/finance"
import { project } from "../schema/organisation"
import { exclusionColumns, runColumns, type EventRow, type ExclusionRow, type RunRow } from "./billing-shapes"
import { issueInvoice, type LineDraft } from "./invoice-writes"
import { projectToday, type Scope } from "./project-clock"
import { CommandRefused, lockRow } from "./shared"

/** The most ready events one run takes: a run is one transaction, and a thousand invoices is what Postgres is for; past this, narrow the period (§7.2, §7.9). */
export const BILLING_RUN_MAX_EVENTS = 5000

/** A count spelled with its thousands grouped by a space, as the sentence below reads: `5 214`. */
export const grouped = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ")

/** What a run over more ready events than one transaction should take is told. */
export const tooManyEvents = (ready: number): string => `${grouped(ready)} ready events fall in the period; narrow it — a run is one transaction`

/** The period a run selects: both service dates inclusive. */
export type BillingPeriod = { periodFrom: string; periodTo: string }

/** A ready event with what its lines and its grouping read beside it: the agreement's number and payer, the product's two names. */
export type ReadyEvent = EventRow & { agreementNumber: string; payerCustomerId: string; productName: string; invoiceName: string | null }

/** One invoice to issue: a payer's events in one currency, with their totals. */
export type Group = { payerCustomerId: string; currency: string; events: ReadyEvent[]; netMinor: number; vatMinor: number }

/** A payer with events in the period and nothing to invoice: every one of them blocked. */
export type Excluded = { customerId: string; eventCount: number }

/** What a run or a preview finds: the ready events in line order, the groups in numbering order, and the payers excluded. */
export type Selection = { events: ReadyEvent[]; groups: Group[]; exclusions: Excluded[] }

/** The event columns the selection's predicates read: the `billable_event` table's own, or an alias's. */
type EventColumns = { id: PgColumn; companyId: PgColumn; projectId: PgColumn; serviceDate: PgColumn; cancelledAt: PgColumn; blockReason: PgColumn }

/** The events of the project whose service date lies in the period and that were not cancelled. */
const inPeriod = (scope: Scope, period: BillingPeriod, on: EventColumns = billableEvent): SQL | undefined =>
  and(eq(on.companyId, scope.companyId), eq(on.projectId, scope.projectId), gte(on.serviceDate, period.periodFrom), lte(on.serviceDate, period.periodTo), isNull(on.cancelledAt))

/** The `ready` reading as a `where`: priced, not cancelled, no line naming it, no reversal naming it. `on` is the event row the statement is over, the table or an alias of it. */
function ready(tx: Tx, scope: Scope, period: BillingPeriod, on: EventColumns = billableEvent): SQL | undefined {
  const reversal = alias(billableEvent, "reversal")
  return and(
    inPeriod(scope, period, on),
    isNull(on.blockReason),
    notExists(
      tx
        .select({ one: sql`1` })
        .from(invoiceLine)
        .where(and(eq(invoiceLine.companyId, scope.companyId), eq(invoiceLine.billableEventId, on.id))),
    ),
    notExists(
      tx
        .select({ one: sql`1` })
        .from(reversal)
        .where(and(eq(reversal.companyId, scope.companyId), eq(reversal.reversesEventId, on.id))),
    ),
  )
}

/** Whether the selection takes the events' row locks: the run does, the preview writes nothing and holds nothing. */
export type SelectionOptions = { lock?: boolean }

/**
 * The selection and the grouping, as the run and the preview both make them:
 * the ready count first (the ceiling is a refusal before a single row is read
 * whole), then the ready events in line order — `for update` of the events
 * when `lock` is set, so what the run invoices is what it read and a
 * cancellation waits behind it; the statement runs over an alias, since
 * Postgres wants the locked relation named without its schema — then the
 * blocked events per payer — a blocked event with no agreement
 * (`no-subscription`) names no payer and is nobody's exclusion — and the
 * payers among them with nothing ready. The groups are ordered by payer and
 * then currency, so two runs over the same events number their invoices the
 * same way.
 */
export async function selectBilling(tx: Tx, scope: Scope, period: BillingPeriod, { lock = false }: SelectionOptions = {}): Promise<Selection> {
  const [counted] = await tx.select({ rows: count() }).from(billableEvent).where(ready(tx, scope, period))
  const readyCount = counted?.rows ?? 0
  if (readyCount > BILLING_RUN_MAX_EVENTS) throw new CommandRefused(tooManyEvents(readyCount))
  // The agreement and the product every ready event names, joined for the grouping and the line's text.
  const event = alias(billableEvent, "event")
  const { companyId: _companyId, ...columns } = getTableColumns(event)
  const selected = tx
    .select({ ...columns, agreementNumber: agreement.number, payerCustomerId: agreement.payerCustomerId, productName: product.name, invoiceName: product.invoiceName })
    .from(event)
    .innerJoin(agreement, and(eq(agreement.companyId, event.companyId), eq(agreement.id, event.agreementId)))
    .innerJoin(product, and(eq(product.companyId, event.companyId), eq(product.id, event.productId)))
    .where(ready(tx, scope, period, event))
    .orderBy(asc(agreement.number), asc(event.serviceDate), asc(product.name), asc(event.id))
  const events: ReadyEvent[] = await (lock ? selected.for("update", { of: event }) : selected)
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
  /** The caller's clock: today on the project's clock, the run's `completedAt`, and every `invoice-issued`'s `occurredAt`. */
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
  const selection = await selectBilling(tx, scope, input, { lock: true })
  const at = input.now()
  const issuedOn = await projectToday(tx, scope, () => at)()
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
