// The billing run, once (Issue #112 §3; lifted here from
// `apps/api/src/routes/billing-runs.ts` with the commands the worker runs,
// part B): "a controlled batch that converts eligible billable events into
// invoices" (CONTEXT.md). `POST /billing-runs` runs it synchronously in the
// request's transaction with the caller's account; the worker's scheduled run
// (`finance.run-billing`) runs the same function on its cadence with `null`
// for the person, so a run is one thing whichever process asks for it.
//
// `runBilling` is shaped for both as `openTicket` is: over a transaction
// opener, a company, a project, the period, the note, who asked, an id minter
// and a clock — never a Principal or a Context. Each of its transactions takes
// `lockRow(project)`, so two runs of one project take turns, and it selects
// every `pickup`, `ticket`, `manual` and
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
// run is not held up; at most `BILLING_RUN_MAX_EVENTS` row locks a batch,
// under the project's. It groups them by payer
// (`agreement.payer_customer_id`) and currency, and for each
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
// invoices for a per-currency figure. A run with nothing ready is a completed
// run of zero invoices. The database's word behind the selection is
// `invoice_line_billable_event_id_idx`, an event on one line of one invoice,
// and its refusal is the backstop for a race the project's lock prevents.
//
// A run goes payer by payer in batches (#329), so a project of any size
// completes and no transaction outgrows the ceiling: the run is one row and
// several short transactions, each under the project's lock.
//
//   the start  — the period is a closed one, no other run of the project is
//                under way, the recurring charges and the hires are minted
//                (their idempotency keys make a second mint a no-op), and the
//                run's row is written `requested`; or, where the project's
//                `requested` run is over this same period, that run is
//                resumed. Another run `requested` and touched within
//                `staleAfterMs` (fifteen minutes) refuses this one
//                (`runUnderWay`, a 409); one left longer is a run whose
//                process died, written `failed` with what it issued, and
//                this one starts;
//   a batch    — the payers of the period with a ready event, in id order,
//                less those this run has already invoiced or excluded (the
//                run's cursor, read off its own invoices and exclusions, so a
//                resumed run starts where it stopped and never invoices a
//                payer twice), taken while their own events fit
//                `BILLING_RUN_MAX_EVENTS` (`nextBatch`), their catch-up in
//                the room left; their invoices issued exactly as above, the
//                run's row touched with its counts so far. A payer whose own
//                ready events alone are more than a batch takes is refused
//                alone, an exclusion of `too-many-events`, never split across
//                invoices;
//   the finish — the payers passed over in the period that the run neither
//                invoiced nor excluded are its exclusions, and the row is
//                written `completed` with its counts and totals read off its
//                invoices.
//
// So a run is resumable rather than all-or-nothing: a failure rolls back the
// batch it happened in, the batches before it stand with their invoices and
// their unbroken numbers, and the row stays `requested` until a run over the
// same period finishes it — the next request, the worker's retry, or any run
// once it is stale.
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
//
// A run catches up too (#447): an event that became ready after its own
// period's run — released from a hold, or a blocked one repriced — is reached
// by no later run over a later period, and nothing reruns a closed one. So the
// selection also takes the ready events from before the period, back to
// `catchUpFrom` (twelve months before its first day, the domain's): by service
// date, a recurring charge or a hire by a charge period that ended before the
// period's reach — and only those a completed run of the project already
// reached, so it was not ready, or not there, when its own period's run
// looked. An event whose period no run has covered — a scheduled run that
// failed, a month the office has not run yet, history from before the project
// billed — waits for that period's own run, so a period's invoices carry its
// own events and periods are still run apart. Only an event no line names is
// ready, so each is invoiced once, by the first run after it became ready. The
// period's own events come first under `BILLING_RUN_MAX_EVENTS` in each
// batch, and the catch-up of the batch's payers takes, oldest first by the
// day its window reaches it by, only the room they leave; the rest wait for
// the next run, and the preview lists the lines it catches up and counts those
// it leaves. The blocked and the held of earlier periods are no payer's
// exclusion here: an exclusion is about the run's own period.
import { PERIOD_ENDS_BY_TODAY, type BillingRunPreview } from "@waste/contracts/billing"
import { dueOn, termsOf } from "@waste/domain/finance/payment"
import { catchUpFrom } from "@waste/domain/finance/periods"
import type { BillableEventKind, ExclusionReason, PaymentReferenceScheme } from "@waste/domain/finance/vocabulary"
import { addDays } from "@waste/domain/route-schemes/recurrence"
import { and, asc, count, eq, exists, getTableColumns, gt, gte, inArray, isNotNull, isNull, lt, lte, notExists, notInArray, or, sql, type SQL } from "drizzle-orm"
import { alias, type PgColumn } from "drizzle-orm/pg-core"

import type { Tx } from "../client"
import type { IdMinter } from "../ids"
import { agreement } from "../schema/agreements"
import { product } from "../schema/catalogue"
import { customer, property } from "../schema/customers"
import { dropOffPoint } from "../schema/drop-off-points"
import { billableEvent, billingRun, billingRunExclusion, invoice, invoiceLine } from "../schema/finance"
import { project } from "../schema/organisation"
import { siteVisit } from "../schema/site-visits"
import { exclusionColumns, runColumns, type EventRow, type ExclusionRow, type RunRow } from "./billing-shapes"
import { issueInvoice, type LineDraft } from "./invoice-writes"
import { projectToday, type Scope } from "./project-clock"
import { heldWhenCharged, holdsForReview } from "./billable-writes"
import { mintHireCharges, planHireCharges } from "./hire-charges"
import { mintRecurringCharges, planRecurringCharges } from "./recurring-charges"
import { lockRow, refused, RefusedField } from "./shared"

/** The most ready events one batch of a run takes (#329): a batch is one transaction, and a thousand invoices is what Postgres is for (§7.2, §7.9); a payer above it alone is excluded, `too-many-events`. */
export const BILLING_RUN_MAX_EVENTS = 5000

/** How long a `requested` run may go untouched before it counts as one whose process died (#329): a batch touches its row, and a batch takes seconds. */
export const BILLING_RUN_STALE_MS = 15 * 60_000

/** A count spelled with its thousands grouped by a space: `5 214`. */
export const grouped = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ")

/** What a run is told while another run of the project, over another period, is still under way. */
export const runUnderWay = (period: BillingPeriod): string => `A billing run of this project over ${period.periodFrom} – ${period.periodTo} is under way; run again once it has completed`

/** The period a run selects: both service dates inclusive. */
export type BillingPeriod = { periodFrom: string; periodTo: string }

/** A ready event with what its lines and its grouping read beside it: the agreement's number and payer, the product's two names, and whether it is from before the period, caught up (#447). */
export type ReadyEvent = EventRow & {
  agreementNumber: string
  payerCustomerId: string
  productName: string
  invoiceName: string | null
  /** A recycling-centre visit's (#393): the site's name, and the plate or the card as read, or the Property's name where the attendant found it by its address; null on every other kind. */
  visitSite: string | null
  visitIdentifier: string | null
  catchUp: boolean
}

/** One invoice to issue: a payer's events in one currency, with their totals. */
export type Group = { payerCustomerId: string; currency: string; events: ReadyEvent[]; netMinor: number; vatMinor: number }

/** A payer with events in the period and nothing to invoice: every one of them blocked, or held for review, or each one or the other (M14 of #293). */
export type Excluded = { customerId: string; eventCount: number; reason: ExclusionReason }

/** How many of a payer's events in the period a run passes over: the blocked and the held. */
type PassedOver = { blocked: number; held: number }

/** The payers a run passes over every event of, in id order, each with its count and the reason its counts give. */
function exclusionsOf(passedOver: ReadonlyMap<string, PassedOver>, invoiced: ReadonlySet<string>): Excluded[] {
  return [...passedOver]
    .filter(([customerId, counts]) => !invoiced.has(customerId) && counts.blocked + counts.held > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([customerId, { blocked, held }]) => ({ customerId, eventCount: blocked + held, reason: held === 0 ? "all-events-blocked" : blocked === 0 ? "all-events-held" : "all-events-blocked-or-held" }))
}

/** One more blocked or held event of a payer. */
function passOver(passedOver: Map<string, PassedOver>, customerId: string, as: keyof PassedOver, events = 1): void {
  const counts = passedOver.get(customerId) ?? { blocked: 0, held: 0 }
  counts[as] += events
  passedOver.set(customerId, counts)
}

/** What a run or a preview finds: the ready events in line order, the groups in numbering order, the payers excluded, each payer's events it passes over, and the ready events from before the period it catches up, oldest first, with how many more it leaves for a later run (#447). */
export type Selection = { events: ReadyEvent[]; groups: Group[]; exclusions: Excluded[]; passedOver: ReadonlyMap<string, PassedOver>; catchUpIds: string[]; catchUpDeferredCount: number }

/** The event columns the selection's predicates read: the `billable_event` table's own, or an alias's. */
type EventColumns = { id: PgColumn; companyId: PgColumn; projectId: PgColumn; agreementId: PgColumn; kind: PgColumn; serviceDate: PgColumn; chargePeriodFrom: PgColumn; chargePeriodTo: PgColumn; cancelledAt: PgColumn; blockReason: PgColumn; heldAt: PgColumn }

/** The kinds a run selects by the period they charge, not by their service date. */
const CHARGED_BY_PERIOD: BillableEventKind[] = ["subscription", "hire"]

/** The events of the project in the period that were not cancelled: by service date, a recurring charge by its charge period, overlapping the period or the day after it, and a hire by its month ending on or after the period's first day (M14 of #293), since a run charges a month whole once due — one it overlaps, or the one before it — its first day charged before the run's. */
const inPeriod = (scope: Scope, period: BillingPeriod, on: EventColumns = billableEvent): SQL | undefined =>
  and(
    eq(on.companyId, scope.companyId),
    eq(on.projectId, scope.projectId),
    or(
      and(notInArray(on.kind, CHARGED_BY_PERIOD), gte(on.serviceDate, period.periodFrom), lte(on.serviceDate, period.periodTo)),
      and(eq(on.kind, "subscription"), lte(on.chargePeriodFrom, addDays(period.periodTo, 1)), gt(on.chargePeriodTo, period.periodFrom)),
      // A month ending on or after the run's first day: the run's own, and the one before, which the run charges when the last left it undue.
      and(eq(on.kind, "hire"), lte(on.chargePeriodFrom, period.periodTo), gte(on.chargePeriodTo, period.periodFrom)),
    ),
    isNull(on.cancelledAt),
  )

/** Whether a completed run of the project reached the event: `inPeriod` over the run's period, the run's columns for the period's days. */
const coveredByRun = (tx: Tx, scope: Scope, on: EventColumns): SQL =>
  exists(
    tx
      .select({ one: sql`1` })
      .from(billingRun)
      .where(
        and(
          eq(billingRun.companyId, scope.companyId),
          eq(billingRun.projectId, scope.projectId),
          eq(billingRun.status, "completed"),
          or(
            and(notInArray(on.kind, CHARGED_BY_PERIOD), lte(billingRun.periodFrom, on.serviceDate), gte(billingRun.periodTo, on.serviceDate)),
            and(eq(on.kind, "subscription"), sql`${on.chargePeriodFrom} <= ${billingRun.periodTo} + 1`, gt(on.chargePeriodTo, billingRun.periodFrom)),
            and(eq(on.kind, "hire"), lte(on.chargePeriodFrom, billingRun.periodTo), gte(on.chargePeriodTo, billingRun.periodFrom)),
          ),
        ),
      ),
  )

/** The events of the project from before the period, back to `catchUpFrom`, that were not cancelled and that a completed run already reached (#447): by service date, and a recurring charge or a hire by a charge period that ended before `inPeriod` reaches it, within the window. */
const beforePeriod = (tx: Tx, scope: Scope, period: BillingPeriod, on: EventColumns = billableEvent): SQL | undefined => {
  const from = catchUpFrom(period.periodFrom)
  return and(
    eq(on.companyId, scope.companyId),
    eq(on.projectId, scope.projectId),
    or(
      and(notInArray(on.kind, CHARGED_BY_PERIOD), gte(on.serviceDate, from), lt(on.serviceDate, period.periodFrom)),
      and(eq(on.kind, "subscription"), gt(on.chargePeriodTo, from), lte(on.chargePeriodTo, period.periodFrom)),
      and(eq(on.kind, "hire"), gt(on.chargePeriodTo, from), lt(on.chargePeriodTo, period.periodFrom)),
    ),
    isNull(on.cancelledAt),
    coveredByRun(tx, scope, on),
  )
}

/** Which events a reading is over: the period's own, or the earlier ones a run catches up (#447). */
type Reach = "period" | "catch-up"

/** The `ready` reading as a `where`: priced, not cancelled, not held, no line naming it, no reversal naming it — or with `held`, the `held` reading, the same but held. `on` is the event row the statement is over, the table or an alias of it; `reach` the events it reads, the period's by default. */
function ready(tx: Tx, scope: Scope, period: BillingPeriod, on: EventColumns = billableEvent, { held = false, reach = "period", payers }: { held?: boolean; reach?: Reach; payers?: readonly string[] } = {}): SQL | undefined {
  const reversal = alias(billableEvent, "reversal")
  return and(
    reach === "period" ? inPeriod(scope, period, on) : beforePeriod(tx, scope, period, on),
    // A batch's payers (#329): the events of the agreements they pay for.
    payers === undefined ? undefined : inArray(on.agreementId, tx.select({ id: agreement.id }).from(agreement).where(and(eq(agreement.companyId, scope.companyId), inArray(agreement.payerCustomerId, [...payers])))),
    isNull(on.blockReason),
    // A hold for review (M14 of #293) keeps an event out of every run until it is released.
    held ? isNotNull(on.heldAt) : isNull(on.heldAt),
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

/**
 * Whether the selection takes the events' row locks — the run does, the
 * preview writes nothing and holds nothing — how many ready events the
 * caller counts beside the period's own (the preview's planned charges,
 * which the run has minted by the time it selects), the payers it is over (a
 * batch's, #329; every payer when absent), and the most ready events it
 * takes, the period's own first and the catch-up in the room they leave
 * (`BILLING_RUN_MAX_EVENTS` unless said; the preview's is unbounded).
 */
export type SelectionOptions = { lock?: boolean; reserved?: number; payers?: readonly string[]; max?: number }

/** Each payer's events in the period a run passes over: the blocked, and the held for review (M14 of #293), so a payer with nothing else is excluded with them. A blocked event with no agreement (`no-subscription`) names no payer and is nobody's. */
async function passedOverIn(tx: Tx, scope: Scope, period: BillingPeriod): Promise<Map<string, PassedOver>> {
  const blocked = await tx
    .select({ customerId: agreement.payerCustomerId, events: count() })
    .from(billableEvent)
    .innerJoin(agreement, and(eq(agreement.companyId, billableEvent.companyId), eq(agreement.id, billableEvent.agreementId)))
    .where(and(inPeriod(scope, period), isNotNull(billableEvent.blockReason)))
    .groupBy(agreement.payerCustomerId)
    .orderBy(asc(agreement.payerCustomerId))
  // The events held for review (M14 of #293): passed over as the blocked are, so a payer with nothing else is excluded with them.
  const held = await tx
    .select({ customerId: agreement.payerCustomerId, events: count() })
    .from(billableEvent)
    .innerJoin(agreement, and(eq(agreement.companyId, billableEvent.companyId), eq(agreement.id, billableEvent.agreementId)))
    .where(ready(tx, scope, period, billableEvent, { held: true }))
    .groupBy(agreement.payerCustomerId)
    .orderBy(asc(agreement.payerCustomerId))
  const passedOver = new Map<string, PassedOver>()
  for (const payer of blocked) passOver(passedOver, payer.customerId, "blocked", payer.events)
  for (const payer of held) passOver(passedOver, payer.customerId, "held", payer.events)
  return passedOver
}

/**
 * The selection and the grouping, as a run's batch and the preview both make
 * them, over the batch's payers or every payer: the ready count first (the
 * ceiling a backstop of the batch's plan, over the period's own and the
 * `reserved`), then how many earlier
 * ready events there are to catch up and how many of them fit under the
 * ceiling beside the period's own, oldest first (#447), then the ready events
 * in line order, the caught up among them — `for update` of the events
 * when `lock` is set, so what the run invoices is what it read and a
 * cancellation waits behind it; the statement runs over an alias, since
 * Postgres wants the locked relation named without its schema — then the
 * blocked events per payer — a blocked event with no agreement
 * (`no-subscription`) names no payer and is nobody's exclusion — and the
 * payers among them with nothing ready. The groups are ordered by payer and
 * then currency, so two runs over the same events number their invoices the
 * same way.
 */
export async function selectBilling(tx: Tx, scope: Scope, period: BillingPeriod, { lock = false, reserved = 0, payers, max = BILLING_RUN_MAX_EVENTS }: SelectionOptions = {}): Promise<Selection> {
  const [counted] = await tx.select({ rows: count() }).from(billableEvent).where(ready(tx, scope, period, billableEvent, { payers }))
  const readyCount = (counted?.rows ?? 0) + reserved
  // A batch is planned under the ceiling (`nextBatch`), so this is the backstop of a plan the project's lock keeps true.
  if (readyCount > max) throw new Error(`selectBilling: ${grouped(readyCount)} ready events over a batch of ${grouped(max)}`)
  // The earlier events no run invoiced (#447), in one statement so the count and the rows agree: the ids in the room the period's own leave, oldest first by the day the window reaches each by, and how many there are in all.
  const room = max - readyCount
  const behindQuery = tx
    .select({ id: billableEvent.id, total: sql<number>`count(*) over ()`.mapWith(Number) })
    .from(billableEvent)
    .where(ready(tx, scope, period, billableEvent, { reach: "catch-up", payers }))
    .orderBy(asc(sql`coalesce(${billableEvent.chargePeriodTo}, ${billableEvent.serviceDate})`), asc(billableEvent.id))
  const behind = await (Number.isFinite(room) ? behindQuery.limit(Math.max(room, 1)) : behindQuery)
  const catchUpIds = behind.slice(0, room).map((row) => row.id)
  const catchingUp = new Set(catchUpIds)
  // The agreement and the product every ready event names, joined for the grouping and the line's text.
  const event = alias(billableEvent, "event")
  // The reading is stated again over the locked row beside the ids: a cancellation or a hold that commits while the run waits on an event's lock is judged on the row it wrote (Postgres re-reads the `where` of a locked row that changed), where the ids alone would still name it.
  const caughtUp = catchUpIds.length === 0 ? undefined : and(ready(tx, scope, period, event, { reach: "catch-up", payers }), inArray(event.id, catchUpIds))
  const { companyId: _companyId, ...columns } = getTableColumns(event)
  const selected = tx
    .select({
      ...columns,
      agreementNumber: agreement.number,
      payerCustomerId: agreement.payerCustomerId,
      productName: product.name,
      invoiceName: product.invoiceName,
      visitSite: dropOffPoint.name,
      visitIdentifier: sql<string | null>`coalesce(${siteVisit.identifierValue}, ${property.name})`,
    })
    .from(event)
    .innerJoin(agreement, and(eq(agreement.companyId, event.companyId), eq(agreement.id, event.agreementId)))
    .innerJoin(product, and(eq(product.companyId, event.companyId), eq(product.id, event.productId)))
    // A visit's line names its site and its identifier (#393): 24.1 asks that the invoice list plate, date and site.
    .leftJoin(siteVisit, and(eq(siteVisit.companyId, event.companyId), eq(siteVisit.id, event.visitId)))
    .leftJoin(dropOffPoint, and(eq(dropOffPoint.companyId, siteVisit.companyId), eq(dropOffPoint.id, siteVisit.siteId)))
    .leftJoin(property, and(eq(property.companyId, siteVisit.companyId), eq(property.id, siteVisit.propertyId)))
    .where(or(ready(tx, scope, period, event, { payers }), caughtUp))
    .orderBy(asc(agreement.number), asc(event.serviceDate), asc(product.name), asc(event.id))
  const events: ReadyEvent[] = (await (lock ? selected.for("update", { of: event }) : selected)).map((row) => ({ ...row, catchUp: catchingUp.has(row.id) }))
  const passedOver = await passedOverIn(tx, scope, period)

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
  return { events, groups: ordered, exclusions: exclusionsOf(passedOver, invoiced), passedOver, catchUpIds, catchUpDeferredCount: (behind[0]?.total ?? 0) - catchUpIds.length }
}

/**
 * What a preview answers: the counts, the totals per currency in currency
 * order, and the payers a run would exclude; nothing written. The recurring
 * charges and the hires (M14 of #293) the run would mint are planned and folded in as the run would
 * select them: a priced one is a ready event of its payer and currency, a
 * blocked one counts toward its payer's exclusion, and a payer with a priced
 * one is invoiced and excluded no more. The earlier events the run would
 * catch up (#447) are listed as their lines, oldest first, and counted in
 * the totals, with how many it would leave for a later run. `now` is the caller's clock: the
 * hires due by the project's today, as a run then would mint them.
 */
export async function previewBilling(tx: Tx, scope: Scope, period: BillingPeriod, now: () => Date): Promise<BillingRunPreview> {
  const today = await projectToday(tx, scope, now)()
  // A run is for a closed period (M14 of #293): no charge reaches a day still to come, and no month is left undue past every later run's reach.
  if (period.periodTo > today) throw new RefusedField("periodTo", PERIOD_ENDS_BY_TODAY)
  // The charges the run would mint, each as the run would write it: blocked without a price, held for review where the project holds its hires (M14 of #293), else ready.
  const holds = await holdsForReview(tx, scope)
  const planned = [...(await planRecurringCharges(tx, scope, period)).map((charge) => ({ ...charge, held: false })), ...(await planHireCharges(tx, scope, period, today)).map((hire) => ({ ...hire, held: heldWhenCharged(holds, "hire", hire.blockReason) }))]
  const priced = planned.flatMap((charge) => (charge.price === null || charge.held ? [] : [{ payerCustomerId: charge.payerCustomerId, ...charge.price }]))
  // The whole period at once, since the preview holds nothing and writes nothing; the run takes it a batch of payers at a time (#329).
  const selection = await selectBilling(tx, scope, period, { reserved: priced.length, max: Number.POSITIVE_INFINITY })
  // A payer whose own ready events alone are more than a batch takes is excluded by the run, `too-many-events`, and so here (#329).
  const own = new Map<string, number>()
  for (const event of selection.events) if (!event.catchUp) own.set(event.payerCustomerId, (own.get(event.payerCustomerId) ?? 0) + 1)
  for (const charge of priced) own.set(charge.payerCustomerId, (own.get(charge.payerCustomerId) ?? 0) + 1)
  const tooMany = new Map([...own].filter(([, events]) => events > BILLING_RUN_MAX_EVENTS))
  const groups = selection.groups.filter((group) => !tooMany.has(group.payerCustomerId))
  const pricedRun = priced.filter((charge) => !tooMany.has(charge.payerCustomerId))
  const readyCount = groups.reduce((sum, group) => sum + group.events.length, 0) + pricedRun.length
  const invoices = new Set(groups.map((group) => `${group.payerCustomerId}/${group.currency}`))
  const totals = new Map<string, { currency: string; netMinor: number; vatMinor: number }>()
  for (const group of [...groups, ...pricedRun]) {
    invoices.add(`${group.payerCustomerId}/${group.currency}`)
    const total = totals.get(group.currency) ?? { currency: group.currency, netMinor: 0, vatMinor: 0 }
    total.netMinor += group.netMinor
    total.vatMinor += group.vatMinor
    totals.set(group.currency, total)
  }
  const invoiced = new Set([...groups, ...pricedRun, ...[...tooMany.keys()].map((payerCustomerId) => ({ payerCustomerId }))].map((group) => group.payerCustomerId))
  const passedOver = new Map([...selection.passedOver].map(([customerId, counts]) => [customerId, { ...counts }]))
  for (const charge of planned) if (charge.price === null || charge.held) passOver(passedOver, charge.payerCustomerId, charge.price === null ? "blocked" : "held")
  const held = [...passedOver.values()].reduce((sum, counts) => sum + counts.held, 0)
  const caughtUp = new Map(selection.events.filter((event) => event.catchUp).map((event) => [event.id, event]))
  return {
    eventCount: readyCount,
    invoiceCount: invoices.size,
    heldEventCount: held,
    totals: [...totals.values()].sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0)),
    exclusions: [...exclusionsOf(passedOver, invoiced), ...[...tooMany].map(([customerId, eventCount]): Excluded => ({ customerId, eventCount, reason: "too-many-events" }))].sort((a, b) => (a.customerId < b.customerId ? -1 : a.customerId > b.customerId ? 1 : 0)),
    // In the selection's oldest-first order; an id the locked reading dropped is neither listed nor counted.
    catchUp: selection.catchUpIds.flatMap((id) => {
      const event = caughtUp.get(id)
      if (event === undefined || tooMany.has(event.payerCustomerId) || event.currency === null || event.netMinor === null || event.vatMinor === null) return []
      return [{ billableEventId: id, kind: event.kind as BillableEventKind, customerId: event.payerCustomerId, description: descriptionOf(event), serviceDate: event.serviceDate, currency: event.currency, netMinor: event.netMinor, vatMinor: event.vatMinor }]
    }),
    catchUpDeferredCount: selection.catchUpDeferredCount,
  }
}

/** A line's text: the product's invoice name (or its name) and the service date; a recycling-centre visit's, its site and its identifier after them (#393); a recurring charge's, its charge period's first and last days and, where it charged fewer, how many of its days. */
function descriptionOf(event: ReadyEvent): string {
  const name = event.invoiceName ?? event.productName
  if (event.visitSite !== null) return [name, event.serviceDate, event.visitSite, event.visitIdentifier].filter((part) => part !== null).join(" · ")
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
  /** The most ready events one batch takes; `BILLING_RUN_MAX_EVENTS` unless a test says. */
  batchMax?: number
  /** How long another `requested` run may stand untouched before this one counts it stopped; `BILLING_RUN_STALE_MS` unless a test says. */
  staleAfterMs?: number
}

/**
 * Opens one of the run's transactions under the caller's fence and its
 * writer — the API's `withCompany` with the Principal named, the worker's
 * under the company alone — and answers what the work answered once it
 * committed. A run is several of them (#329), so the caller hands the opener
 * rather than a transaction.
 */
export type Transact = <T>(work: (tx: Tx) => Promise<T>) => Promise<T>

/** What one batch of a run takes: the payers whose own ready events fit the batch, in id order, and the payers before the first that does not fit whose own alone are more than any batch takes. */
export type BatchPlan = { payers: string[]; tooMany: { customerId: string; eventCount: number }[] }

/**
 * The next batch over the payers still to do, in id order, each with its own
 * ready events and its earlier ones to catch up (#447): payers are taken
 * while their own events fit `max` together, and a payer whose own alone are
 * more than `max` is refused alone (`tooMany`) rather than split across
 * invoices. A batch is never empty while a payer is left: the first that fits
 * an empty batch is taken. The catch-up is not counted here; the selection
 * gives it the room the batch's own leave, as a run over one payer always has.
 */
export function nextBatch(remaining: readonly { customerId: string; own: number }[], max: number): BatchPlan {
  const plan: BatchPlan = { payers: [], tooMany: [] }
  let events = 0
  for (const payer of remaining) {
    if (payer.own > max) {
      plan.tooMany.push({ customerId: payer.customerId, eventCount: payer.own })
      continue
    }
    if (plan.payers.length > 0 && events + payer.own > max) break
    plan.payers.push(payer.customerId)
    events += payer.own
  }
  return plan
}

/** The run's row as the start reads it, with how long ago it was last touched by the database's clock. */
type OpenRun = RunRow & { idleMs: number }

/**
 * The start (#329): the project's lock, the closed period, the run under way
 * — this period's resumed, another's refused while it is fresh and written
 * `failed` once stale — the charges and the hires minted, and the run's row
 * written `requested`, or the resumed run's touched. Answers the run's id.
 */
async function startRun(tx: Tx, input: RunBillingInput, scope: Scope, at: Date): Promise<string> {
  const { companyId, projectId } = scope
  await lockRow(tx, project, { companyId, id: projectId })
  const issuedOn = await projectToday(tx, scope, () => at)()
  // A closed period alone, the office's run and the schedule's alike (as the preview's).
  if (input.periodTo > issuedOn) throw new RefusedField("periodTo", PERIOD_ENDS_BY_TODAY)
  const open: OpenRun[] = await tx
    .select({ ...runColumns, idleMs: sql<number>`(extract(epoch from (now() - ${billingRun.updatedAt})) * 1000)::float8`.mapWith(Number) })
    .from(billingRun)
    .where(and(eq(billingRun.companyId, companyId), eq(billingRun.projectId, projectId), eq(billingRun.status, "requested")))
    .orderBy(asc(billingRun.id))
  const staleAfterMs = input.staleAfterMs ?? BILLING_RUN_STALE_MS
  let resumed: OpenRun | undefined
  for (const run of open) {
    if (run.periodFrom === input.periodFrom && run.periodTo === input.periodTo) {
      resumed ??= run
      continue
    }
    if (run.idleMs < staleAfterMs) throw refused(409, runUnderWay(run))
    // A run whose process died over another period: what it issued stands, and the row says it never finished.
    await tx.update(billingRun).set({ status: "failed" }).where(and(eq(billingRun.companyId, companyId), eq(billingRun.id, run.id)))
  }
  // A period and the next charged before the selection, so the run invoices them, and the months of hire due by today (M14 of #293); the second of two runs, or a resumed one, finds them charged.
  const holds = await holdsForReview(tx, scope)
  await mintRecurringCharges(tx, scope, input, input.newId)
  await mintHireCharges(tx, scope, input, issuedOn, input.newId, holds)
  if (resumed !== undefined) {
    await touch(tx, scope, resumed.id)
    return resumed.id
  }
  const [run] = await tx
    .insert(billingRun)
    .values({ id: input.newId(), companyId, projectId, periodFrom: input.periodFrom, periodTo: input.periodTo, status: "requested", requestedBy: input.requestedBy, note: input.note })
    .returning({ id: billingRun.id })
  return run.id
}

/** Whether a payer is done in the run: it holds an invoice of the run, or an exclusion. The run's cursor (#329). */
const doneInRun = (tx: Tx, scope: Scope, runId: string, payer: PgColumn): SQL | undefined =>
  and(
    notInArray(payer, tx.select({ id: invoice.customerId }).from(invoice).where(and(eq(invoice.companyId, scope.companyId), eq(invoice.billingRunId, runId)))),
    notInArray(payer, tx.select({ id: billingRunExclusion.customerId }).from(billingRunExclusion).where(and(eq(billingRunExclusion.companyId, scope.companyId), eq(billingRunExclusion.billingRunId, runId)))),
  )

/** The payers the run has still to do, in id order, each with its own ready events in the period; a payer with earlier events to catch up alone counts none of its own. */
async function remainingPayers(tx: Tx, scope: Scope, period: BillingPeriod, runId: string): Promise<{ customerId: string; own: number }[]> {
  const counted = (reach: Reach) =>
    tx
      .select({ customerId: agreement.payerCustomerId, events: count() })
      .from(billableEvent)
      .innerJoin(agreement, and(eq(agreement.companyId, billableEvent.companyId), eq(agreement.id, billableEvent.agreementId)))
      .where(and(ready(tx, scope, period, billableEvent, { reach }), doneInRun(tx, scope, runId, agreement.payerCustomerId)))
      .groupBy(agreement.payerCustomerId)
  const [own, behind] = await Promise.all([counted("period"), counted("catch-up")])
  const payers = new Map<string, number>()
  for (const row of behind) payers.set(row.customerId, 0)
  for (const row of own) payers.set(row.customerId, row.events)
  return [...payers].map(([customerId, events]) => ({ customerId, own: events })).sort((a, b) => (a.customerId < b.customerId ? -1 : a.customerId > b.customerId ? 1 : 0))
}

/** Touches the run's row, its counts so far read off its invoices and exclusions: what a batch leaves, and what the stale rule reads. */
async function touch(tx: Tx, scope: Scope, runId: string, completedAt?: Date): Promise<RunRow> {
  const [totals] = await tx
    .select({ invoices: count(), netMinor: sql<number>`coalesce(sum(${invoice.netMinor}), 0)`.mapWith(Number), vatMinor: sql<number>`coalesce(sum(${invoice.vatMinor}), 0)`.mapWith(Number) })
    .from(invoice)
    .where(and(eq(invoice.companyId, scope.companyId), eq(invoice.billingRunId, runId)))
  const [lines] = await tx
    .select({ rows: count() })
    .from(invoiceLine)
    .innerJoin(invoice, and(eq(invoice.companyId, invoiceLine.companyId), eq(invoice.id, invoiceLine.invoiceId)))
    .where(and(eq(invoice.companyId, scope.companyId), eq(invoice.billingRunId, runId)))
  const [excluded] = await tx
    .select({ rows: count() })
    .from(billingRunExclusion)
    .where(and(eq(billingRunExclusion.companyId, scope.companyId), eq(billingRunExclusion.billingRunId, runId)))
  const [run] = await tx
    .update(billingRun)
    .set({
      eventCount: lines?.rows ?? 0,
      invoiceCount: totals?.invoices ?? 0,
      excludedCustomerCount: excluded?.rows ?? 0,
      netMinor: totals?.netMinor ?? 0,
      vatMinor: totals?.vatMinor ?? 0,
      ...(completedAt === undefined ? {} : { status: "completed", completedAt }),
    })
    .where(and(eq(billingRun.companyId, scope.companyId), eq(billingRun.id, runId)))
    .returning(runColumns)
  return run
}

/** The run's row, read under the project's lock; undefined when it is no longer `requested` (another caller finished it). */
async function stillRequested(tx: Tx, scope: Scope, runId: string): Promise<RunRow | undefined> {
  await lockRow(tx, project, { companyId: scope.companyId, id: scope.projectId })
  const [run] = await tx
    .select(runColumns)
    .from(billingRun)
    .where(and(eq(billingRun.companyId, scope.companyId), eq(billingRun.id, runId)))
  return run?.status === "requested" ? run : undefined
}

/**
 * One batch (#329): under the project's lock, the next payers still to do,
 * those refused alone written as `too-many-events` exclusions, the rest's
 * events selected `for update` and invoiced exactly as one run always did,
 * and the run's row touched. Answers whether the batch did anything: a batch
 * that found nothing to do, or did nothing, ends the loop.
 */
async function runBatch(tx: Tx, input: RunBillingInput, scope: Scope, runId: string, at: Date): Promise<boolean> {
  const run = await stillRequested(tx, scope, runId)
  if (run === undefined) return false
  const max = input.batchMax ?? BILLING_RUN_MAX_EVENTS
  const plan = nextBatch(await remainingPayers(tx, scope, input, runId), max)
  if (plan.payers.length === 0 && plan.tooMany.length === 0) return false
  if (plan.tooMany.length > 0) {
    await tx.insert(billingRunExclusion).values(plan.tooMany.map((payer) => ({ id: input.newId(), companyId: scope.companyId, projectId: scope.projectId, billingRunId: runId, customerId: payer.customerId, reason: "too-many-events", eventCount: payer.eventCount })))
  }
  let issued = 0
  if (plan.payers.length > 0) {
    const issuedOn = await projectToday(tx, scope, () => at)()
    const selection = await selectBilling(tx, scope, input, { lock: true, payers: plan.payers, max })
    issued = (await issueGroups(tx, input, scope, runId, issuedOn, selection.groups, at)).length
  }
  await touch(tx, scope, runId)
  return issued > 0 || plan.tooMany.length > 0
}

/** One invoice per group, in numbering order, under the run: the project's terms and scheme, each payer's own terms (#291 C4). Answers the invoices' ids. */
async function issueGroups(tx: Tx, input: RunBillingInput, scope: Scope, runId: string, issuedOn: string, groups: readonly Group[], at: Date): Promise<string[]> {
  if (groups.length === 0) return []
  const [settings] = await tx.select({ terms: project.paymentTermsDays, scheme: project.paymentReferenceScheme }).from(project).where(and(eq(project.companyId, scope.companyId), eq(project.id, scope.projectId)))
  if (settings === undefined) throw new Error(`runBilling: project ${scope.projectId} is not in company ${scope.companyId}`)
  const payers = [...new Set(groups.map((group) => group.payerCustomerId))]
  const payerTerms = new Map((await tx.select({ id: customer.id, terms: customer.paymentTermsDays }).from(customer).where(and(eq(customer.companyId, scope.companyId), inArray(customer.id, payers)))).map((row) => [row.id, row.terms]))
  const invoiceIds: string[] = []
  for (const group of groups) {
    const issued = await issueInvoice(tx, {
      companyId: scope.companyId,
      draft: {
        projectId: scope.projectId,
        kind: "invoice",
        customerId: group.payerCustomerId,
        currency: group.currency,
        issuedOn,
        dueOn: dueOn(issuedOn, termsOf(payerTerms.get(group.payerCustomerId) ?? null, settings.terms)),
        periodFrom: input.periodFrom,
        periodTo: input.periodTo,
        billingRunId: runId,
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
  return invoiceIds
}

/**
 * The finish (#329): under the project's lock, the payers the period passed
 * over that the run neither invoiced nor excluded written as its exclusions,
 * and the row `completed` with its counts and totals read off its invoices.
 * A run another caller finished meanwhile is answered as it stands.
 */
async function finishRun(tx: Tx, scope: Scope, period: BillingPeriod, runId: string, newId: IdMinter, at: Date): Promise<{ run: RunRow; exclusions: ExclusionRow[]; invoiceIds: string[] }> {
  const open = await stillRequested(tx, scope, runId)
  let run: RunRow
  if (open === undefined) {
    const [finished] = await tx.select(runColumns).from(billingRun).where(and(eq(billingRun.companyId, scope.companyId), eq(billingRun.id, runId)))
    run = finished
  } else {
    const done = new Set([
      ...(await tx.select({ id: invoice.customerId }).from(invoice).where(and(eq(invoice.companyId, scope.companyId), eq(invoice.billingRunId, runId)))).map((row) => row.id),
      ...(await tx.select({ id: billingRunExclusion.customerId }).from(billingRunExclusion).where(and(eq(billingRunExclusion.companyId, scope.companyId), eq(billingRunExclusion.billingRunId, runId)))).map((row) => row.id),
    ])
    const passedOver = await passedOverIn(tx, scope, period)
    const excluded = exclusionsOf(passedOver, done)
    if (excluded.length > 0) {
      await tx.insert(billingRunExclusion).values(excluded.map((payer) => ({ id: newId(), companyId: scope.companyId, projectId: scope.projectId, billingRunId: runId, customerId: payer.customerId, reason: payer.reason, eventCount: payer.eventCount })))
    }
    run = await touch(tx, scope, runId, at)
  }
  const exclusions = await tx
    .select(exclusionColumns)
    .from(billingRunExclusion)
    .where(and(eq(billingRunExclusion.companyId, scope.companyId), eq(billingRunExclusion.billingRunId, runId)))
    .orderBy(asc(billingRunExclusion.id))
  const invoices = await tx
    .select({ id: invoice.id })
    .from(invoice)
    .where(and(eq(invoice.companyId, scope.companyId), eq(invoice.billingRunId, runId)))
    .orderBy(asc(invoice.number))
  return { run, exclusions, invoiceIds: invoices.map((row) => row.id) }
}

/**
 * Runs billing for a project over a period, a batch of payers at a time
 * (#329): the start, the batches, the finish, each in a transaction of its
 * own the caller's opener makes. Answers the run's row, its exclusions and
 * the ids of the invoices it issued, in numbering order. A refusal at the
 * start — the period, another run under way — writes nothing; a failure
 * later leaves the batches before it standing and the run `requested`, for
 * the next run over the period to finish.
 */
export async function runBilling(transact: Transact, input: RunBillingInput): Promise<{ run: RunRow; exclusions: ExclusionRow[]; invoiceIds: string[] }> {
  const scope: Scope = { companyId: input.companyId, projectId: input.projectId }
  const at = input.now()
  const runId = await transact((tx) => startRun(tx, input, scope, at))
  while (await transact((tx) => runBatch(tx, input, scope, runId, at))) {
    // Each batch did something: a payer invoiced or excluded, so the loop ends once none is left.
  }
  return await transact((tx) => finishRun(tx, scope, input, runId, input.newId, at))
}
