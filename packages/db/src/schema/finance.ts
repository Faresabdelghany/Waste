// Finance & Contracting (Issue #112, ADR-0001, ADR-0003, ADR-0005): what the
// work is worth and to whom. The Price List a customer is priced under and
// its rows; the Service Area a provider is awarded, with its two sets and the
// Assignment that says who holds it when, and the provider's prices under an
// assignment; the Billable Event a completed pickup or a resolved ticket
// becomes; the Billing Run that turns the ready ones into Invoices, the
// payers it excluded, the invoices and their lines; the Settlement that says
// what the company owes a provider for a period, its lines and its history;
// and the weight review, the judgement of an Unload's weight that Execution
// deferred here. Sixteen tables, every one a Project's (a Company prices,
// awards and invoices inside a Project, whose currency and timezone the rows
// read), every one fenced; eleven spread `timestamps` and carry the trigger,
// five — the exclusions, the invoice, its lines, the settlement's history and
// the weight review — spread `recorded` and are ledgers whose file revokes
// UPDATE and DELETE from the API role (sql/append-only.ts). Every enum column
// is text under `oneOf` over a tuple of @waste/domain/finance/vocabulary, or,
// where the value is the Registry's — a customer kind — over its tuple.
//
// Six tables are effective-dated, with `validity`, `validPeriod` and one
// `excludeOverlapping` each in the migration: one list of a code in force at
// a time (`price_list_no_overlap` over the project and the code), one row of
// a list, a product and a condition set (`price_list_row_no_overlap`, keyed
// on `condition_key`, the generated column that makes the five nullable
// conditions one NOT NULL value the constraint can hold — `subscription.
// location_id`'s device — so a scheduled price change is the next row and a
// default row and a zone row of one product coexist), one area of a code
// (`service_area_no_overlap`), one provider holding an area
// (`service_area_assignment_no_overlap`), one price of an assignment and a
// product (`service_provider_price_no_overlap`, an indexation being a new row
// the fee on a day is a `validOn` read of, the chain through
// `indexed_from_id`), and one settlement of an assignment over a period
// (`settlement_no_overlap`: a settlement's period is the `validity` set, its
// end required by `settlement_period_closed`, since a settlement without an
// end is not a period). Containment — a row inside its list, an assignment
// inside its area, a price inside its assignment — is the API's, under the
// parent's row lock (routes/periods.ts), since Postgres cannot say it across
// rows without a trigger; a settlement's period is not held inside its
// assignment's (§7.16).
//
// `billable_event` is current state and deliberately not a ledger: a blocked
// event is repriced in place once the office has mended the list, and a
// ready one is cancelled by stamping it. Its status is a reading and never a
// column (@waste/domain/finance/readings): blocked is a block reason,
// cancelled a stamp, invoiced an `invoice_line` naming it, reversed a
// `reversal` event naming it, ready none of those. Ten shape checks hold the
// columns to what the row is — the price frozen as resolved on `service_date`
// and its five columns null together or none (`_priced_shape`), the net the
// unit price times the quantity with a reversal's sign (`_amounts_shape`),
// the VAT the domain's `vatOf` as SQL (`_vat_shape`, `round(net * pct /
// 100.0)`, held to the domain by a test), the winning row traceable unless
// blocked or a manual or a reversal (`_row_shape`), a manual event with a
// person's price carrying the reason (`_override_shape`), a pickup naming its
// route (`_pickup_shape`, since Postgres leaves a composite key with a null
// member unchecked), what each kind names (`_kind_shape`, one CASE), a
// person's or an event's (`_origin_shape`), a cancellation's stamps together
// (`_cancel_shape`) — and `billable_event_source_event_id_idx` is the
// consumer's idempotency key, one row per outbox event, a soft uuid on the
// ticket's precedent.
//
// `invoice` is a ledger because "invoice number and original issued content
// are immutable": the row is written once by the run or the credit command
// and nothing updates it, a credit note being an invoice of `kind =
// credit-note` naming the invoice it credits, and "sent" the export's own
// row. Its `number` comes from the company's third counter
// (`organisation.ts`, `next_invoice_number`), one number per document under
// the company's row lock, so the series is unbroken; `INV-26007188` is the
// contracts' presentation. `invoice_line_billable_event_id_idx` is the
// database's word behind the run's selection: an event is on one line of one
// invoice. A credit line names the line it credits (`invoice_line_source_
// exactly_one`), copies its product, unit price and rate, and is never
// positive; an event's line may be negative, since a reversal is one.
//
// `settlement` is the row the database holds and `settlement_event` the
// ledger nobody rewrites — the Vehicle Allocation's pattern — with
// `settlement_stamps_shape` holding the instants to the status and
// `settlement_event_reason_shape` giving a reopening its reason.
// `settlement_line` is the calculation, replaced whole on every `calculate`,
// an unpriced line (no provider price covering the product on the day)
// blocking `close`. `weight_review` is one row per decision on an Unload's
// weight through `unload_project_key`, which this migration adds; a
// correction names the new Unload row it wrote and never the reviewed one.
import { BILLABLE_EVENT_KINDS, BILLING_RUN_STATUSES, BLOCK_REASONS, CANCEL_REASONS, CREDIT_REASONS, EXCLUSION_REASONS, INDEX_BASES, INVOICE_KINDS, SETTLEMENT_EVENT_KINDS, SETTLEMENT_STATUSES, WEIGHT_REVIEW_DECISIONS } from "@waste/domain/finance/vocabulary"
import { CUSTOMER_KINDS } from "@waste/domain/registry/vocabulary"
import { sql } from "drizzle-orm"
import { bigint, boolean, check, date, index, integer, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { userAccount } from "./access"
import { agreement, subscription } from "./agreements"
import { containerType, product, wasteFraction } from "./catalogue"
import { exactlyOne, oneOf, positive } from "./checks"
import { id, projectScoped, recorded, timestamps, validity, validPeriod } from "./columns"
import { customer } from "./customers"
import { pickup, route, unload } from "./execution"
import { company, project, serviceProvider } from "./organisation"
import { planningArea } from "./planning-areas"
import { companyReference, projectKey, projectReference, tenantIndex, tenantReference, tenantUnique, type ProjectTable } from "./references"
import { ticket } from "./resolution"
import { wms } from "./wms"

const instant = () => timestamp({ withTimezone: true })
/** A document's or a settlement's total: a `bigint` read as a number, since twenty-one million kroner a line is enough for a line and not for a year's invoices. */
const total = () => bigint({ mode: "number" })

export const priceList = wms.table(
  "price_list",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    ...validity,
    /** The stable code a person quotes: `PL-CPH-2026`. Set once; one list of a code in force at a time. */
    code: text().notNull(),
    name: text().notNull(),
    /** ISO 4217; every row's amount is in it. A default list is in its project's currency and an agreement's list in the agreement's. */
    currency: text().notNull(),
    /** The list an agreement without one is priced under: one per project, whatever its period. */
    isDefault: boolean().notNull().default(false),
    notes: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectKey(t),
    validPeriod(t),
    // One default list per project, whatever its period: a new tariff year is new rows in it, not a second default list.
    uniqueIndex(tableObjectName(t.companyId.table, "default_idx", "priceList")).on(t.companyId, t.projectId).where(sql`${t.isDefault}`),
    // A name may return with a later period, so it is indexed and not unique.
    tenantIndex(t, t.projectId, t.name),
  ],
)

export const priceListRow = wms.table(
  "price_list_row",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    ...validity,
    priceListId: uuid().notNull(),
    productId: uuid().notNull(),
    /** Per the product's unit, in the list's currency; a free service is a price of zero, not a missing row. */
    unitPriceMinor: integer().notNull(),
    /** The prototype's Zone: a price that holds inside one operational area, matched against the route's scheme's planning area. */
    planningAreaId: uuid(),
    /** The prototype's Customer type, as the Registry spells it; matched against the agreement's customer. */
    customerKind: text(),
    containerTypeId: uuid(),
    wasteFractionId: uuid(),
    /** The negotiated row: it matches its customer alone and always wins for them. */
    customerId: uuid(),
    note: text(),
    /** The condition set as one NOT NULL value the exclusion constraint can key on, since a nullable column may not be in its key. Never on the wire. */
    conditionKey: text()
      .notNull()
      .generatedAlwaysAs(sql`coalesce("planning_area_id"::text, '') || '/' || coalesce("customer_kind", '') || '/' || coalesce("container_type_id"::text, '') || '/' || coalesce("waste_fraction_id"::text, '') || '/' || coalesce("customer_id"::text, '')`),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.priceListId], priceList),
    projectReference(t, [t.productId], product),
    projectReference(t, [t.planningAreaId], planningArea),
    tenantReference(t, [t.containerTypeId], containerType),
    tenantReference(t, [t.wasteFractionId], wasteFraction),
    tenantReference(t, [t.customerId], customer),
    projectKey(t),
    validPeriod(t),
    oneOf(t.customerKind, CUSTOMER_KINDS),
    check(tableObjectName(t.id.table, "unit_price_not_negative", "priceListRow"), sql`${t.unitPriceMinor} >= 0`),
    // The resolver's read: the rows of a list for a product.
    tenantIndex(t, t.priceListId, t.productId),
    tenantIndex(t, t.productId),
    tenantIndex(t, t.planningAreaId),
    tenantIndex(t, t.containerTypeId),
    tenantIndex(t, t.wasteFractionId),
    tenantIndex(t, t.customerId),
  ],
)

export const serviceArea = wms.table(
  "service_area",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    ...validity,
    /** The award's code as the contract spells it: `CA-Ø-2`. Set once; one area of a code in force at a time. */
    code: text().notNull(),
    name: text().notNull(),
    /** The contract's own boundary text: the authoritative legal boundary, where the planning areas are the operational geography. */
    boundaryText: text().notNull(),
    notes: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectKey(t),
    validPeriod(t),
    tenantIndex(t, t.projectId, t.name),
  ],
)

export const serviceAreaPlanningArea = wms.table(
  "service_area_planning_area",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    serviceAreaId: uuid().notNull(),
    planningAreaId: uuid().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.serviceAreaId], serviceArea),
    projectReference(t, [t.planningAreaId], planningArea),
    // One membership per planning area in an area; named for what it holds, like the other sets.
    unique(tableObjectName(t.companyId.table, "membership_key", "serviceAreaPlanningArea")).on(t.companyId, t.serviceAreaId, t.planningAreaId),
    tenantIndex(t, t.projectId),
    // The provider predicate's probe: which areas name this planning area.
    tenantIndex(t, t.planningAreaId),
  ],
)

export const serviceAreaWasteFraction = wms.table(
  "service_area_waste_fraction",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    serviceAreaId: uuid().notNull(),
    wasteFractionId: uuid().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.serviceAreaId], serviceArea),
    tenantReference(t, [t.wasteFractionId], wasteFraction),
    unique(tableObjectName(t.companyId.table, "membership_key", "serviceAreaWasteFraction")).on(t.companyId, t.serviceAreaId, t.wasteFractionId),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.wasteFractionId),
  ],
)

export const serviceAreaAssignment = wms.table(
  "service_area_assignment",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    ...validity,
    serviceAreaId: uuid().notNull(),
    /** The company's provider that holds the area over the period; a transfer is a new row. */
    serviceProviderId: uuid().notNull(),
    notes: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.serviceAreaId], serviceArea),
    tenantReference(t, [t.serviceProviderId], serviceProvider),
    projectKey(t),
    validPeriod(t),
    // The provider's own read, and the predicate's probe.
    tenantIndex(t, t.serviceProviderId),
  ],
)

export const serviceProviderPrice = wms.table(
  "service_provider_price",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    ...validity,
    /** The award priced: provider and area at once. */
    serviceAreaAssignmentId: uuid().notNull(),
    productId: uuid().notNull(),
    /** The contractually locked bid: set on the first row of a chain, copied onto every indexed row, never patched. */
    bidMinor: integer().notNull(),
    /** The current fee, per the product's unit, in the project's currency. */
    unitPriceMinor: integer().notNull(),
    /** ISO 4217, the project's; set once on the first row of a chain and copied onto every indexed row. */
    currency: text().notNull(),
    /** The row this one was indexed from; null on the first row of a chain. */
    indexedFromId: uuid(),
    /** What the indexation was: `CPI`. */
    indexLabel: text(),
    /** 500 for +5 %; a negative figure is a deflator. */
    indexBasisPoints: integer(),
    /** What was multiplied: the bid, or the fee it replaced. */
    indexBase: text(),
    notes: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.serviceAreaAssignmentId], serviceAreaAssignment),
    projectReference(t, [t.productId], product),
    // The row this one was indexed from is a row of the same project, through the table's own project key.
    projectReference(t, [t.indexedFromId], t as ProjectTable),
    projectKey(t),
    validPeriod(t),
    oneOf(t.indexBase, INDEX_BASES),
    check(tableObjectName(t.id.table, "bid_not_negative", "serviceProviderPrice"), sql`${t.bidMinor} >= 0`),
    check(tableObjectName(t.id.table, "unit_price_not_negative", "serviceProviderPrice"), sql`${t.unitPriceMinor} >= 0`),
    // The four index columns are null together or none of them, and a row is not indexed from itself; a null passes the last, like a ticket's parent.
    check(
      tableObjectName(t.id.table, "index_shape", "serviceProviderPrice"),
      sql`(${t.indexedFromId} is null) = (${t.indexLabel} is null) and (${t.indexedFromId} is null) = (${t.indexBasisPoints} is null) and (${t.indexedFromId} is null) = (${t.indexBase} is null) and ${t.indexedFromId} <> ${t.id}`,
    ),
    // The settlement's read: the prices of an assignment for a product. `tenantIndex` would derive a name of 64 bytes, which names.ts refuses, so it is named for what it holds.
    index(tableObjectName(t.companyId.table, "assignment_product_idx", "serviceProviderPrice")).on(t.companyId, t.serviceAreaAssignmentId, t.productId),
    tenantIndex(t, t.productId),
    tenantIndex(t, t.indexedFromId),
  ],
)

export const billableEvent = wms.table(
  "billable_event",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    kind: text().notNull(),
    /** The day the occurrence is priced and billed on: the pickup's route's service date, the ticket's closing day on the project's clock, the person's word on a manual event. */
    serviceDate: date().notNull(),
    /** What the occurrence was under; null where the block reason says why. The customer and the payer are reached through the agreement, never copied. */
    agreementId: uuid(),
    subscriptionId: uuid(),
    productId: uuid(),
    /** In the product's unit; 1 for a pickup and a ticket. */
    quantity: integer().notNull(),
    /** The price as resolved on the service date, frozen: a row repriced later does not move an event already priced. */
    unitPriceMinor: integer(),
    netMinor: integer(),
    vatPercent: integer(),
    vatMinor: integer(),
    currency: text(),
    /** The row that won, so the selected price stays traceable; none on a manual event with a person's price, and none on a reversal. */
    priceListRowId: uuid(),
    /** Why the event is not ready; cleared by `reprice`. */
    blockReason: text(),
    /** The pickup of the route, for a `pickup` event. */
    routeId: uuid(),
    pickupId: uuid(),
    /** The resolved ticket a `ticket` event charges for. */
    ticketId: uuid(),
    /** On a `reversal`: the invoiced event it undoes. */
    reversesEventId: uuid(),
    /** The outbox event the consumer made it from: a soft uuid, and the idempotency key. */
    sourceEventId: uuid(),
    /** The person on a manual event; null on the consumer's. */
    createdBy: uuid(),
    /** Required with a person's price and no row. */
    overrideReason: text(),
    note: text(),
    /** The cancellation: the instant, the person (none for the consumer's), the reason. */
    cancelledAt: instant(),
    cancelledBy: uuid(),
    cancelReason: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.agreementId], agreement),
    projectReference(t, [t.subscriptionId], subscription),
    projectReference(t, [t.productId], product),
    projectReference(t, [t.priceListRowId], priceListRow),
    projectReference(t, [t.routeId], route),
    // The pickup of the route the event names: the key carries the route on both sides, the proof's and the ticket's shape.
    projectReference(t, [t.routeId, t.pickupId], pickup, [pickup.routeId, pickup.id]),
    projectReference(t, [t.ticketId], ticket),
    // The reversed event is one of the same project, through the table's own project key.
    projectReference(t, [t.reversesEventId], t as ProjectTable),
    tenantReference(t, [t.createdBy], userAccount),
    tenantReference(t, [t.cancelledBy], userAccount),
    projectKey(t),
    oneOf(t.kind, BILLABLE_EVENT_KINDS),
    oneOf(t.blockReason, BLOCK_REASONS),
    oneOf(t.cancelReason, CANCEL_REASONS),
    positive(t.quantity),
    // A priced event names what it was under; a blocked one may leave them null where the reason says why.
    check(tableObjectName(t.id.table, "priced_references", "billableEvent"), sql`${t.blockReason} is not null or (${t.agreementId} is not null and ${t.productId} is not null)`),
    // Blocked is unpriced and priced is unblocked, and the five price columns are null together or none.
    check(
      tableObjectName(t.id.table, "priced_shape", "billableEvent"),
      sql`(${t.blockReason} is null) = (${t.netMinor} is not null) and (${t.netMinor} is null) = (${t.unitPriceMinor} is null) and (${t.netMinor} is null) = (${t.vatPercent} is null) and (${t.netMinor} is null) = (${t.vatMinor} is null) and (${t.netMinor} is null) = (${t.currency} is null)`,
    ),
    // The net is the unit price times the quantity, negated on a reversal.
    check(tableObjectName(t.id.table, "amounts_shape", "billableEvent"), sql`${t.netMinor} is null or ${t.netMinor} = (case ${t.kind} when 'reversal' then -1 else 1 end) * ${t.unitPriceMinor} * ${t.quantity}`),
    // The VAT is the domain's vatOf as SQL: half away from zero, per line.
    check(tableObjectName(t.id.table, "vat_shape", "billableEvent"), sql`${t.vatMinor} is null or ${t.vatMinor} = round(${t.netMinor} * ${t.vatPercent} / 100.0)`),
    // The winning row is traceable unless the event is blocked, a person's, or a reversal.
    check(tableObjectName(t.id.table, "row_shape", "billableEvent"), sql`${t.priceListRowId} is not null or ${t.blockReason} is not null or ${t.kind} in ('manual', 'reversal')`),
    // A manual event with a person's price and no row carries the reason, and nothing else does.
    check(tableObjectName(t.id.table, "override_shape", "billableEvent"), sql`(${t.kind} = 'manual' and ${t.priceListRowId} is null and ${t.blockReason} is null) = (${t.overrideReason} is not null)`),
    // A pickup names its route: Postgres leaves a composite key with a null member unchecked.
    check(tableObjectName(t.id.table, "pickup_shape", "billableEvent"), sql`${t.pickupId} is null or ${t.routeId} is not null`),
    // What each kind names: a pickup its pickup, a ticket its ticket, a manual event neither and its person, a reversal the event it undoes and nothing of its own, with a net of zero or less.
    check(
      tableObjectName(t.id.table, "kind_shape", "billableEvent"),
      sql`case ${t.kind} when 'pickup' then ${t.pickupId} is not null and ${t.ticketId} is null and ${t.reversesEventId} is null when 'ticket' then ${t.ticketId} is not null and ${t.pickupId} is null and ${t.reversesEventId} is null when 'manual' then ${t.pickupId} is null and ${t.ticketId} is null and ${t.reversesEventId} is null and ${t.createdBy} is not null when 'reversal' then ${t.reversesEventId} is not null and ${t.pickupId} is null and ${t.ticketId} is null and ${t.netMinor} <= 0 else false end`,
    ),
    // An event is a person's or the consumer's, never both and never neither.
    check(tableObjectName(t.id.table, "origin_shape", "billableEvent"), sql`(${t.createdBy} is null) = (${t.sourceEventId} is not null)`),
    // A cancellation's instant and reason come together, and a person only with them: the consumer cancels with no person.
    check(tableObjectName(t.id.table, "cancel_shape", "billableEvent"), sql`(${t.cancelledAt} is null) = (${t.cancelReason} is null) and (${t.cancelledBy} is null or ${t.cancelledAt} is not null)`),
    // The consumer's idempotency key: one row per outbox event, whatever the row is.
    uniqueIndex(tableObjectName(t.companyId.table, "source_event_id_idx", "billableEvent")).on(t.companyId, t.sourceEventId).where(sql`${t.sourceEventId} is not null`),
    // The run's selection: a project's events by service date.
    tenantIndex(t, t.projectId, t.serviceDate),
    tenantIndex(t, t.agreementId),
    tenantIndex(t, t.subscriptionId),
    tenantIndex(t, t.productId),
    tenantIndex(t, t.routeId),
    tenantIndex(t, t.pickupId),
    tenantIndex(t, t.ticketId),
    tenantIndex(t, t.priceListRowId),
    tenantIndex(t, t.reversesEventId),
    tenantIndex(t, t.createdBy),
    tenantIndex(t, t.cancelledBy),
  ],
)

export const billingRun = wms.table(
  "billing_run",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    /** The service dates selected, both inclusive. */
    periodFrom: date().notNull(),
    periodTo: date().notNull(),
    /** Part A writes the row `completed` in the transaction that made its invoices; `requested` and `failed` are the worker's. */
    status: text().notNull().default("requested"),
    /** The caller; null for the worker's scheduled run. */
    requestedBy: uuid(),
    completedAt: instant(),
    /** The counts as completed. */
    eventCount: integer().notNull().default(0),
    invoiceCount: integer().notNull().default(0),
    excludedCustomerCount: integer().notNull().default(0),
    /** The totals as completed, over every currency the run touched summed as integers; a report reads the invoices for a per-currency figure. */
    netMinor: total().notNull().default(0),
    vatMinor: total().notNull().default(0),
    note: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    tenantReference(t, [t.requestedBy], userAccount),
    projectKey(t),
    oneOf(t.status, BILLING_RUN_STATUSES),
    check(tableObjectName(t.id.table, "period_shape", "billingRun"), sql`${t.periodTo} >= ${t.periodFrom}`),
    check(tableObjectName(t.id.table, "stamps_shape", "billingRun"), sql`(${t.status} = 'completed') = (${t.completedAt} is not null)`),
    tenantIndex(t, t.projectId, t.periodFrom),
    tenantIndex(t, t.requestedBy),
  ],
)

export const billingRunExclusion = wms.table(
  "billing_run_exclusion",
  {
    ...id,
    ...projectScoped,
    ...recorded,
    billingRunId: uuid().notNull(),
    /** The payer the run found events for and invoiced nothing. */
    customerId: uuid().notNull(),
    reason: text().notNull(),
    /** How many of its events the run found. */
    eventCount: integer().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.billingRunId], billingRun),
    tenantReference(t, [t.customerId], customer),
    tenantUnique(t, t.billingRunId, t.customerId),
    oneOf(t.reason, EXCLUSION_REASONS),
    positive(t.eventCount),
    tenantIndex(t, t.customerId),
    tenantIndex(t, t.projectId),
  ],
)

export const invoice = wms.table(
  "invoice",
  {
    ...id,
    ...projectScoped,
    ...recorded,
    /** The document number from the company's counter, `INV-26007188` on the wire; the company's series, unbroken. */
    number: integer().notNull(),
    kind: text().notNull(),
    /** The payer: `agreement.payer_customer_id` of every line's event. */
    customerId: uuid().notNull(),
    /** One per document; a payer with agreements in two currencies gets two invoices. */
    currency: text().notNull(),
    /** The run's day in the project's timezone, and thirty days on; a credit note is due on issue. */
    issuedOn: date().notNull(),
    dueOn: date().notNull(),
    /** The run's period on an invoice; null on a credit note. */
    periodFrom: date(),
    periodTo: date(),
    /** The run that issued an invoice; null on a credit note. */
    billingRunId: uuid(),
    /** What a credit note corrects and why; null on an invoice. */
    creditsInvoiceId: uuid(),
    creditReason: text(),
    creditNote: text(),
    /** The totals as issued; a credit note's zero or negative. */
    netMinor: total().notNull(),
    vatMinor: total().notNull(),
    grossMinor: total().notNull(),
    /** The caller; null for the worker's run. */
    issuedBy: uuid(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    tenantReference(t, [t.customerId], customer),
    projectReference(t, [t.billingRunId], billingRun),
    // The invoice a credit note corrects is one of the same project, through the table's own project key.
    projectReference(t, [t.creditsInvoiceId], t as ProjectTable),
    tenantReference(t, [t.issuedBy], userAccount),
    tenantUnique(t, t.number),
    projectKey(t),
    oneOf(t.kind, INVOICE_KINDS),
    oneOf(t.creditReason, CREDIT_REASONS),
    check(tableObjectName(t.id.table, "due_shape", "invoice"), sql`${t.dueOn} >= ${t.issuedOn}`),
    // An invoice bills a period and a credit note none; the two bounds come together.
    check(tableObjectName(t.id.table, "period_shape", "invoice"), sql`(${t.periodFrom} is null) = (${t.periodTo} is null) and (${t.kind} = 'invoice') = (${t.periodFrom} is not null)`),
    // An invoice comes from a run and a credit note corrects an invoice for a reason.
    check(
      tableObjectName(t.id.table, "kind_shape", "invoice"),
      sql`(${t.kind} = 'invoice') = (${t.billingRunId} is not null) and (${t.kind} = 'credit-note') = (${t.creditsInvoiceId} is not null) and (${t.kind} = 'credit-note') = (${t.creditReason} is not null)`,
    ),
    // A credit note does not credit itself; a null passes.
    check(tableObjectName(t.id.table, "credits_shape", "invoice"), sql`${t.creditsInvoiceId} <> ${t.id}`),
    // The gross is the net and the VAT; an invoice's net is zero or more and a credit note's zero or less.
    check(tableObjectName(t.id.table, "totals_shape", "invoice"), sql`${t.grossMinor} = ${t.netMinor} + ${t.vatMinor} and (${t.kind} <> 'invoice' or ${t.netMinor} >= 0) and (${t.kind} <> 'credit-note' or ${t.netMinor} <= 0)`),
    tenantIndex(t, t.customerId),
    tenantIndex(t, t.billingRunId),
    tenantIndex(t, t.creditsInvoiceId),
    tenantIndex(t, t.projectId, t.issuedOn),
    tenantIndex(t, t.issuedBy),
  ],
)

export const invoiceLine = wms.table(
  "invoice_line",
  {
    ...id,
    ...projectScoped,
    ...recorded,
    invoiceId: uuid().notNull(),
    position: integer().notNull(),
    /** On an invoice's line: the event it charges for, on one line of one invoice. */
    billableEventId: uuid(),
    /** On a credit note's line: the invoice line credited. */
    creditsLineId: uuid(),
    /** Frozen text: the product's invoice name and the service date as they stood when issued. */
    description: text().notNull(),
    productId: uuid(),
    serviceDate: date(),
    /** On a credit line, the quantity credited. */
    quantity: integer().notNull(),
    unitPriceMinor: integer().notNull(),
    netMinor: integer().notNull(),
    vatPercent: integer().notNull(),
    vatMinor: integer().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.invoiceId], invoice),
    projectReference(t, [t.billableEventId], billableEvent),
    // The line a credit line credits is one of the same project, through the table's own project key.
    projectReference(t, [t.creditsLineId], t as ProjectTable),
    projectReference(t, [t.productId], product),
    tenantUnique(t, t.invoiceId, t.position),
    projectKey(t),
    positive(t.position),
    positive(t.quantity),
    // A line charges for an event or credits a line, never both and never neither.
    exactlyOne(t, "source", [t.billableEventId, t.creditsLineId]),
    // The net's magnitude is the unit price times the quantity; a credit line is never positive, and an event's line may be negative, since a reversal is one.
    check(tableObjectName(t.id.table, "amounts_shape", "invoiceLine"), sql`abs(${t.netMinor}) = ${t.unitPriceMinor} * ${t.quantity} and (${t.creditsLineId} is null or ${t.netMinor} <= 0)`),
    // The VAT is the domain's vatOf as SQL, per line.
    check(tableObjectName(t.id.table, "vat_shape", "invoiceLine"), sql`${t.vatMinor} = round(${t.netMinor} * ${t.vatPercent} / 100.0)`),
    // An event is on one line of one invoice: the database's word behind the run's selection.
    uniqueIndex(tableObjectName(t.companyId.table, "billable_event_id_idx", "invoiceLine")).on(t.companyId, t.billableEventId).where(sql`${t.billableEventId} is not null`),
    tenantIndex(t, t.creditsLineId),
    tenantIndex(t, t.productId),
  ],
)

export const settlement = wms.table(
  "settlement",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    ...validity,
    /** Whose period it settles; the provider and the area through it. */
    serviceAreaAssignmentId: uuid().notNull(),
    status: text().notNull().default("open"),
    /** ISO 4217, the project's. */
    currency: text().notNull(),
    /** The stamps the status carries: calculated once, closed with the person who closed it. */
    calculatedAt: instant(),
    closedAt: instant(),
    closedBy: uuid(),
    /** The calculation's totals; frozen at close by the lines standing still. */
    lineCount: integer().notNull().default(0),
    netMinor: total().notNull().default(0),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.serviceAreaAssignmentId], serviceAreaAssignment),
    tenantReference(t, [t.closedBy], userAccount),
    projectKey(t),
    validPeriod(t),
    oneOf(t.status, SETTLEMENT_STATUSES),
    // Which stamps each status carries: open none, calculated the first, closed both and the person.
    check(
      tableObjectName(t.id.table, "stamps_shape", "settlement"),
      sql`case ${t.status} when 'open' then ${t.calculatedAt} is null and ${t.closedAt} is null and ${t.closedBy} is null when 'calculated' then ${t.calculatedAt} is not null and ${t.closedAt} is null and ${t.closedBy} is null when 'closed' then ${t.calculatedAt} is not null and ${t.closedAt} is not null and ${t.closedBy} is not null else false end`,
    ),
    // A settlement without an end is not a period.
    check(tableObjectName(t.id.table, "period_closed", "settlement"), sql`${t.validTo} is not null`),
    // An assignment's settlements: the read beside the exclusion constraint's own index.
    tenantIndex(t, t.serviceAreaAssignmentId),
    tenantIndex(t, t.projectId, t.status),
    tenantIndex(t, t.closedBy),
  ],
)

export const settlementLine = wms.table(
  "settlement_line",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    settlementId: uuid().notNull(),
    billableEventId: uuid().notNull(),
    /** The provider price valid on the event's service date; null when none covers the product on the day, which blocks `close`. */
    serviceProviderPriceId: uuid(),
    quantity: integer().notNull(),
    unitPriceMinor: integer(),
    netMinor: integer(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.settlementId], settlement),
    projectReference(t, [t.billableEventId], billableEvent),
    projectReference(t, [t.serviceProviderPriceId], serviceProviderPrice),
    tenantUnique(t, t.settlementId, t.billableEventId),
    positive(t.quantity),
    // A priced line has its price and its amount, an unpriced one neither.
    check(tableObjectName(t.id.table, "priced_shape", "settlementLine"), sql`(${t.serviceProviderPriceId} is null) = (${t.netMinor} is null) and (${t.netMinor} is null) = (${t.unitPriceMinor} is null)`),
    tenantIndex(t, t.billableEventId),
    tenantIndex(t, t.serviceProviderPriceId),
    tenantIndex(t, t.projectId),
  ],
)

export const settlementEvent = wms.table(
  "settlement_event",
  {
    ...id,
    ...projectScoped,
    ...recorded,
    settlementId: uuid().notNull(),
    kind: text().notNull(),
    /** The settlement's status after the event: a snapshot, so the history reads without the row. */
    status: text().notNull(),
    lineCount: integer().notNull(),
    netMinor: total().notNull(),
    /** On a reopening: why. */
    reason: text(),
    recordedBy: uuid().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.settlementId], settlement),
    tenantReference(t, [t.recordedBy], userAccount),
    oneOf(t.kind, SETTLEMENT_EVENT_KINDS),
    oneOf(t.status, SETTLEMENT_STATUSES),
    // Reopening requires a reason, and nothing else carries one.
    check(tableObjectName(t.id.table, "reason_shape", "settlementEvent"), sql`(${t.kind} = 'reopened') = (${t.reason} is not null)`),
    // A settlement's history in recording order: leads with the settlement, so it is the reference's index too.
    index(tableObjectName(t.companyId.table, "settlement_id_idx", "settlementEvent")).on(t.companyId, t.settlementId, t.id),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.recordedBy),
  ],
)

export const weightReview = wms.table(
  "weight_review",
  {
    ...id,
    ...projectScoped,
    ...recorded,
    unloadId: uuid().notNull(),
    decision: text().notNull(),
    /** A rejection says why. */
    note: text(),
    /** On a correction: the new Unload row it wrote, never the reviewed one. */
    correctionUnloadId: uuid(),
    reviewedBy: uuid().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.unloadId], unload),
    projectReference(t, [t.correctionUnloadId], unload),
    tenantReference(t, [t.reviewedBy], userAccount),
    oneOf(t.decision, WEIGHT_REVIEW_DECISIONS),
    check(tableObjectName(t.id.table, "note_shape", "weightReview"), sql`${t.decision} <> 'rejected' or ${t.note} is not null`),
    check(tableObjectName(t.id.table, "correction_shape", "weightReview"), sql`(${t.decision} = 'corrected') = (${t.correctionUnloadId} is not null) and (${t.correctionUnloadId} is null or ${t.correctionUnloadId} <> ${t.unloadId})`),
    // The fold's one backward probe per unload, leading with the unload so it is the reference's index too.
    index(tableObjectName(t.companyId.table, "unload_id_idx", "weightReview")).on(t.companyId, t.unloadId, t.id),
    tenantIndex(t, t.correctionUnloadId),
    tenantIndex(t, t.reviewedBy),
    tenantIndex(t, t.projectId),
  ],
)
