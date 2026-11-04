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
// period's own events come first under `BILLING_RUN_MAX_EVENTS`: the ceiling
// refuses them alone, and the catch-up takes, oldest first by the day its
// window reaches it by, only the room they leave; the rest wait for the next
// run, and the preview lists the lines it catches up and counts those it
// leaves. The blocked and the held of earlier periods are no payer's
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
import { billableEvent, billingRun, billingRunExclusion, invoiceLine } from "../schema/finance"
import { project } from "../schema/organisation"
import { siteVisit } from "../schema/site-visits"
import { exclusionColumns, runColumns, type EventRow, type ExclusionRow, type RunRow } from "./billing-shapes"
import { issueInvoice, type LineDraft } from "./invoice-writes"
import { projectToday, type Scope } from "./project-clock"
import { heldWhenCharged, holdsForReview } from "./billable-writes"
import { mintHireCharges, planHireCharges } from "./hire-charges"
import { mintRecurringCharges, planRecurringCharges } from "./recurring-charges"
import { lockRow, refused, RefusedField } from "./shared"

/** The most ready events one run takes: a run is one transaction, and a thousand invoices is what Postgres is for; past this, narrow the period (§7.2, §7.9). */
export const BILLING_RUN_MAX_EVENTS = 5000

/** A count spelled with its thousands grouped by a space, as the sentence below reads: `5 214`. */
export const grouped = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ")

/** What a run over more ready events than one transaction should take is told. */
export const tooManyEvents = (ready: number): string => `${grouped(ready)} ready events fall in the period; narrow it — a run is one transaction`

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
type EventColumns = { id: PgColumn; companyId: PgColumn; projectId: PgColumn; kind: PgColumn; serviceDate: PgColumn; chargePeriodFrom: PgColumn; chargePeriodTo: PgColumn; cancelledAt: PgColumn; blockReason: PgColumn; heldAt: PgColumn }

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
function ready(tx: Tx, scope: Scope, period: BillingPeriod, on: EventColumns = billableEvent, { held = false, reach = "period" }: { held?: boolean; reach?: Reach } = {}): SQL | undefined {
  const reversal = alias(billableEvent, "reversal")
  return and(
    reach === "period" ? inPeriod(scope, period, on) : beforePeriod(tx, scope, period, on),
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

/** Whether the selection takes the events' row locks — the run does, the preview writes nothing and holds nothing — and how many ready events the caller counts beside the period's own: the preview's planned charges, which the run has minted by the time it selects. */
export type SelectionOptions = { lock?: boolean; reserved?: number }

/**
 * The selection and the grouping, as the run and the preview both make them:
 * the ready count first (the ceiling is a refusal before a single row is read
 * whole, over the period's own and the `reserved`), then how many earlier
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
export async function selectBilling(tx: Tx, scope: Scope, period: BillingPeriod, { lock = false, reserved = 0 }: SelectionOptions = {}): Promise<Selection> {
  const [counted] = await tx.select({ rows: count() }).from(billableEvent).where(ready(tx, scope, period))
  const readyCount = (counted?.rows ?? 0) + reserved
  if (readyCount > BILLING_RUN_MAX_EVENTS) throw refused(409, tooManyEvents(readyCount))
  // The earlier events no run invoiced (#447), in one statement so the count and the rows agree: the ids in the room the period's own leave, oldest first by the day the window reaches each by, and how many there are in all.
  const room = BILLING_RUN_MAX_EVENTS - readyCount
  const behind = await tx
    .select({ id: billableEvent.id, total: sql<number>`count(*) over ()`.mapWith(Number) })
    .from(billableEvent)
    .where(ready(tx, scope, period, billableEvent, { reach: "catch-up" }))
    .orderBy(asc(sql`coalesce(${billableEvent.chargePeriodTo}, ${billableEvent.serviceDate})`), asc(billableEvent.id))
    .limit(Math.max(room, 1))
  const catchUpIds = behind.slice(0, room).map((row) => row.id)
  const catchingUp = new Set(catchUpIds)
  // The agreement and the product every ready event names, joined for the grouping and the line's text.
  const event = alias(billableEvent, "event")
  // The reading is stated again over the locked row beside the ids: a cancellation or a hold that commits while the run waits on an event's lock is judged on the row it wrote (Postgres re-reads the `where` of a locked row that changed), where the ids alone would still name it.
  const caughtUp = catchUpIds.length === 0 ? undefined : and(ready(tx, scope, period, event, { reach: "catch-up" }), inArray(event.id, catchUpIds))
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
    .where(or(ready(tx, scope, period, event), caughtUp))
    .orderBy(asc(agreement.number), asc(event.serviceDate), asc(product.name), asc(event.id))
  const events: ReadyEvent[] = (await (lock ? selected.for("update", { of: event }) : selected)).map((row) => ({ ...row, catchUp: catchingUp.has(row.id) }))
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
  // The planned charges count beside the period's own events under the ceiling, as the run's minted ones do.
  const selection = await selectBilling(tx, scope, period, { reserved: priced.length })
  const readyCount = selection.events.length + priced.length
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
  const passedOver = new Map([...selection.passedOver].map(([customerId, counts]) => [customerId, { ...counts }]))
  for (const charge of planned) if (charge.price === null || charge.held) passOver(passedOver, charge.payerCustomerId, charge.price === null ? "blocked" : "held")
  const held = [...passedOver.values()].reduce((sum, counts) => sum + counts.held, 0)
  const caughtUp = new Map(selection.events.filter((event) => event.catchUp).map((event) => [event.id, event]))
  return {
    eventCount: readyCount,
    invoiceCount: invoices.size,
    heldEventCount: held,
    totals: [...totals.values()].sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0)),
    exclusions: exclusionsOf(passedOver, invoiced),
    // In the selection's oldest-first order; an id the locked reading dropped is neither listed nor counted.
    catchUp: selection.catchUpIds.flatMap((id) => {
      const event = caughtUp.get(id)
      if (event === undefined || event.currency === null || event.netMinor === null || event.vatMinor === null) return []
      return [{ billableEventId: id, kind: event.kind as BillableEventKind, customerId: event.payerCustomerId, description: descriptionOf(event), serviceDate: event.serviceDate, currency: event.currency, netMinor: event.netMinor, vatMinor: event.vatMinor }]
    }),
    catchUpDeferredCount: selection.catchUpDeferredCount,
  }
}

/** Whole kilograms as an invoice reads them: 8,240 kg. */
const kilograms = (kg: number): string => `${String(kg).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} kg`

/** A line's text: the product's invoice name (or its name) and the service date; a recycling-centre visit's, its site and its identifier after them (#393); a weight charge's, the kilograms it charged (O28 of #290); a recurring charge's, its charge period's first and last days and, where it charged fewer, how many of its days. */
function descriptionOf(event: ReadyEvent): string {
  const name = event.invoiceName ?? event.productName
  if (event.visitSite !== null) return [name, event.serviceDate, event.visitSite, event.visitIdentifier].filter((part) => part !== null).join(" · ")
  if (event.weightKg !== null) return `${name} · ${event.serviceDate} · ${kilograms(event.weightKg)}`
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
  const holds = await holdsForReview(tx, scope)
  // A closed period alone, the office's run and the schedule's alike (as the preview's).
  if (input.periodTo > issuedOn) throw new RefusedField("periodTo", PERIOD_ENDS_BY_TODAY)
  // A period and the next charged before the selection, so the run invoices them, and the months of hire due by today (M14 of #293); the second of two runs finds them charged.
  await mintRecurringCharges(tx, scope, input, input.newId)
  await mintHireCharges(tx, scope, input, issuedOn, input.newId, holds)
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
          .values(selection.exclusions.map((payer) => ({ id: input.newId(), companyId, projectId, billingRunId: run.id, customerId: payer.customerId, reason: payer.reason, eventCount: payer.eventCount })))
          .returning(exclusionColumns)
  return { run, exclusions: exclusions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), invoiceIds }
}
