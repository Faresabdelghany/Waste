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
// `Refused` 409 the API's error handler answers as such: a run is one
// transaction), groups the
// rest by payer (`agreement.payer_customer_id`) and currency, and for each
// group issues one invoice through invoice-writes.ts: the next number of the
// company's series, `issued_on` today on the project's clock, `due_on` the
// payer's terms on — its own, else the project's (#291 C4) — the payment
// reference under the project's scheme, the lines in a fixed order —
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
//
// A run charges subscriptions too (#291 slice 2, #292 C2): under the
// project's lock and before it selects, it mints the recurring charges its
// period calls for (recurring-charges.ts) — a month-sold subscription's next
// charge period in advance, and one in its period never charged — as
// `subscription` events, which it then selects as it selects every other. A
// recurring charge is selected by its charge period, not its service date:
// one overlapping the run's period or the day after it, so the run over
// October invoices November's charges it minted with October's pickups. Its
// line reads the product, the charge period's first and last days, and how
// many of its days were charged where that is not all of them. The preview
// plans the charges and writes none, folding the plan into what it counts,
// so it answers what the run would.
import type { BillingRunPreview } from "@waste/contracts/billing"
import { dueOn, termsOf } from "@waste/domain/finance/payment"
import type { BillableEventKind, PaymentReferenceScheme } from "@waste/domain/finance/vocabulary"
import { addDays } from "@waste/domain/route-schemes/recurrence"
import { and, asc, count, eq, getTableColumns, gt, gte, inArray, isNotNull, isNull, lte, notExists, notInArray, or, sql, type SQL } from "drizzle-orm"
import { alias, type PgColumn } from "drizzle-orm/pg-core"

import type { Tx } from "../client"
import type { IdMinter } from "../ids"
import { agreement } from "../schema/agreements"
import { product } from "../schema/catalogue"
import { customer } from "../schema/customers"
import { billableEvent, billingRun, billingRunExclusion, invoiceLine } from "../schema/finance"
import { project } from "../schema/organisation"
import { exclusionColumns, runColumns, type EventRow, type ExclusionRow, type RunRow } from "./billing-shapes"
import { issueInvoice, type LineDraft } from "./invoice-writes"
import { projectToday, type Scope } from "./project-clock"
import { mintHireCharges, planHireCharges } from "./hire-charges"
import { mintRecurringCharges, planRecurringCharges } from "./recurring-charges"
import { lockRow, refused } from "./shared"

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
type EventColumns = { id: PgColumn; companyId: PgColumn; projectId: PgColumn; kind: PgColumn; serviceDate: PgColumn; chargePeriodFrom: PgColumn; chargePeriodTo: PgColumn; cancelledAt: PgColumn; blockReason: PgColumn }

/** The kinds a run selects by the period they charge, not by their service date. */
const CHARGED_BY_PERIOD: BillableEventKind[] = ["subscription", "hire"]

/** The events of the project in the period that were not cancelled: by service date, a recurring charge by its charge period, overlapping the period or the day after it, and a hire by its month overlapping the period (M14 of #293), since a run over part of a month charges it whole once due, its first day charged before the run's. */
const inPeriod = (scope: Scope, period: BillingPeriod, on: EventColumns = billableEvent): SQL | undefined =>
  and(
    eq(on.companyId, scope.companyId),
    eq(on.projectId, scope.projectId),
    or(
      and(notInArray(on.kind, CHARGED_BY_PERIOD), gte(on.serviceDate, period.periodFrom), lte(on.serviceDate, period.periodTo)),
      and(eq(on.kind, "subscription"), lte(on.chargePeriodFrom, addDays(period.periodTo, 1)), gt(on.chargePeriodTo, period.periodFrom)),
      and(eq(on.kind, "hire"), lte(on.chargePeriodFrom, period.periodTo), gt(on.chargePeriodTo, period.periodFrom)),
    ),
    isNull(on.cancelledAt),
  )

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
  if (readyCount > BILLING_RUN_MAX_EVENTS) throw refused(409, tooManyEvents(readyCount))
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

/**
 * What a preview answers: the counts, the totals per currency in currency
 * order, and the payers a run would exclude; nothing written. The recurring
 * charges and the hires (M14 of #293) the run would mint are planned and folded in as the run would
 * select them: a priced one is a ready event of its payer and currency, a
 * blocked one counts toward its payer's exclusion, and a payer with a priced
 * one is invoiced and excluded no more. `now` is the caller's clock: the
 * hires due by the project's today, as a run then would mint them.
 */
export async function previewBilling(tx: Tx, scope: Scope, period: BillingPeriod, now: () => Date): Promise<BillingRunPreview> {
  const selection = await selectBilling(tx, scope, period)
  const today = await projectToday(tx, scope, now)()
  const planned = [...(await planRecurringCharges(tx, scope, period)), ...(await planHireCharges(tx, scope, period, today))]
  const priced = planned.flatMap((charge) => (charge.price === null ? [] : [{ payerCustomerId: charge.payerCustomerId, ...charge.price }]))
  const readyCount = selection.events.length + priced.length
  if (readyCount > BILLING_RUN_MAX_EVENTS) throw refused(409, tooManyEvents(readyCount))
  const invoices = new Set(selection.groups.map((group) => `${group.payerCustomerId}/${group.currency}`))
  const totals = new Map<string, { currency: string; netMinor: number; vatMinor: number }>()
  for (const group of [...selection.groups, ...priced]) {
    invoices.add(`${group.payerCustomerId}/${group.currency}`)
    const total = totals.get(group.currency) ?? { currency: group.currency, netMinor: 0, vatMinor: 0 }
    total.netMinor += group.netMinor
    total.vatMinor += group.vatMinor
    totals.set(group.currency, total)
  }
  const invoiced = new Set([...selection.groups, ...priced].map((group) => group.payerCustomerId))
  const excluded = new Map(selection.exclusions.map((payer) => [payer.customerId, payer.eventCount]))
  for (const charge of planned) if (charge.price === null) excluded.set(charge.payerCustomerId, (excluded.get(charge.payerCustomerId) ?? 0) + 1)
  return {
    eventCount: readyCount,
    invoiceCount: invoices.size,
    totals: [...totals.values()].sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0)),
    exclusions: [...excluded]
      .filter(([customerId]) => !invoiced.has(customerId))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([customerId, eventCount]) => ({ customerId, eventCount, reason: "all-events-blocked" as const })),
  }
}

/** A line's text: the product's invoice name (or its name) and the service date; a recurring charge's, its charge period's first and last days and, where it charged fewer, how many of its days. */
function descriptionOf(event: ReadyEvent): string {
  const name = event.invoiceName ?? event.productName
  if (event.chargePeriodFrom === null || event.chargePeriodTo === null || event.chargedDays === null || event.periodDays === null) return `${name} · ${event.serviceDate}`
  const days = event.chargedDays === event.periodDays ? "" : ` · ${event.chargedDays} of ${event.periodDays} days`
  return `${name} · ${event.chargePeriodFrom} – ${addDays(event.chargePeriodTo, -1)}${days}`
}

/** One event as its line: the frozen text, the product, the day, the amounts as the event froze them — a reversal's negative. */
function lineOfEvent(event: ReadyEvent): LineDraft {
  if (event.unitPriceMinor === null || event.netMinor === null || event.vatPercent === null || event.vatMinor === null) throw new Error(`billable event ${event.id} is ready and carries no price`)
  return {
    billableEventId: event.id,
    creditsLineId: null,
    description: descriptionOf(event),
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
 * the project's lock, the recurring charges and the hires the period calls for, the
 * selection, the run's row `completed` with its
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
  const at = input.now()
  const issuedOn = await projectToday(tx, scope, () => at)()
  // A period and the next charged before the selection, so the run invoices them, and the months of hire due by today (M14 of #293); the second of two runs finds them charged.
  await mintRecurringCharges(tx, scope, input, input.newId)
  await mintHireCharges(tx, scope, input, issuedOn, input.newId)
  const selection = await selectBilling(tx, scope, input, { lock: true })
  // The project's terms and scheme, and each payer's own terms (#291 C4): a payer's invoice is due by its own where it has them.
  const [settings] = await tx.select({ terms: project.paymentTermsDays, scheme: project.paymentReferenceScheme }).from(project).where(and(eq(project.companyId, companyId), eq(project.id, projectId)))
  if (settings === undefined) throw new Error(`runBilling: project ${projectId} is not in company ${companyId}`)
  const payers = [...new Set(selection.groups.map((group) => group.payerCustomerId))]
  const payerTerms = new Map(
    payers.length === 0 ? [] : (await tx.select({ id: customer.id, terms: customer.paymentTermsDays }).from(customer).where(and(eq(customer.companyId, companyId), inArray(customer.id, payers)))).map((row) => [row.id, row.terms]),
  )
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
        dueOn: dueOn(issuedOn, termsOf(payerTerms.get(group.payerCustomerId) ?? null, settings.terms)),
        periodFrom: input.periodFrom,
        periodTo: input.periodTo,
        billingRunId: run.id,
        creditsInvoiceId: null,
        creditReason: null,
        creditNote: null,
        issuedBy: input.requestedBy,
        paymentReferenceScheme: settings.scheme as PaymentReferenceScheme,
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
