// The Price Engine's money on the adapter (#185, slice 10 of #81, for #148):
// Billable Events over `/billable-events`, with the office's manual event
// and the `reprice` and `cancel` commands; Billing Runs over `/billing-runs`,
// previewed through the client and run through the store; and Invoices with
// their Credit Notes over `/invoices`, a credit note a create posted under
// the invoice it corrects. The bodies are held against the contracts' own zod
// schemas; money is minor units on the wire, shown in the row's currency.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Agreement } from "@waste/contracts/agreements"
import { BillableEventCancel, BillableEventCreate, BillableEventHold, BillableEventReprice, OVERRIDE_WITH_A_REASON as WIRE_OVERRIDE_WITH_A_REASON, type BillableEvent } from "@waste/contracts/billable-events"
import { BillingRunCreate, PERIOD_ENDS_BY_TODAY as WIRE_PERIOD_ENDS_BY_TODAY, PERIOD_ORDERED as WIRE_PERIOD_ORDERED, type BillingRun, type BillingRunDetail, type BillingRunPreview } from "@waste/contracts/billing"
import type { Product } from "@waste/contracts/catalogue"
import type { Customer } from "@waste/contracts/customers"
import { CreditNoteCreate, type Invoice, type InvoiceDetail, type InvoiceLine } from "@waste/contracts/invoices"
import type { Project } from "@waste/contracts/organisation"

import { FIXTURE_COMPANY_ID, getModuleDefinition, type BusinessRecord } from "../../data/business-modules"
import { problemSentence } from "../problem"
import { NOTHING_RESOLVED, type MappingContext } from "../records/adapter"
import { agreementAdapter } from "../records/agreements"
import {
  billableEventAdapter,
  billingModule,
  billingRunAdapter,
  billingRunBody,
  eventCommandsOffered,
  eventPricedByList,
  eventQuestion,
  eventsModule,
  exclusionWords,
  invoiceAdapter,
  invoicesModule,
  OVERRIDE_WITH_A_REASON,
  PERIOD_ENDS_BY_TODAY,
  PERIOD_ORDERED,
  previewBillingRun,
} from "../records/billing"
import { isServerBacked, SERVER_MODULE_KEYS } from "../records/modules"
import { projectAdapter } from "../records/organisation"
import { productAdapter } from "../records/pricing"
import { customerAdapter } from "../records/registry"
import { commandRecord, loaded, loadModule, resolverOver, spellsStatus, writeRecord, type ServerRecordsState } from "../records/server-records"
import { bodyOf, clientOver, json, problem, scripted } from "./scripted-fetch"

const NOW = new Date("2026-09-30T12:00:00Z")
const STAMPS = { createdAt: "2026-09-24T09:00:00.000Z", updatedAt: "2026-09-25T09:30:00.000Z" }
const RECORDED = { recordedAt: "2026-09-30T08:00:00.000Z" }

const fixturesOf = (workspaceId: Parameters<typeof getModuleDefinition>[0]["workspaceId"], moduleId: string) => getModuleDefinition({ workspaceId, moduleId })?.records ?? []
const eventFixtures = fixturesOf("commercial", "events")
const runFixtures = fixturesOf("commercial", "billing")
const invoiceFixtures = fixturesOf("commercial", "invoices")

const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays", publicSlug: null, weightTolerancePercent: 5, paymentTermsDays: 30, paymentReferenceScheme: "none", holdForReview: false }
const osterbro: Customer = { id: "01a0d2a4-a280-700b-8000-000000000002", ...STAMPS, kind: "organisation", name: "Østerbro Housing", registrationNumber: "38112009", email: null, phone: null, billingAddress: null, serviceMessagesAllowed: true, paymentTermsDays: null, status: "active" }
const agr2408: Agreement = { id: "01a0d2a4-a280-7012-8000-000000000001", ...STAMPS, projectId: copenhagen.id, number: "AGR-2408", customerId: osterbro.id, payerCustomerId: osterbro.id, status: "active", billingCadence: "monthly", currency: "DKK", notes: null, priceListId: null, validFrom: "2026-01-01", validTo: null }
// An agreement of one party billed to another (#256), as the seed's AGR-2607 is.
const kab: Customer = { ...osterbro, id: "01a0d2a4-a280-700b-8000-000000000003", name: "KAB Bolig", registrationNumber: "38112010" }
const kommune: Customer = { ...osterbro, id: "01a0d2a4-a280-700b-8000-000000000004", name: "Københavns Kommune", registrationNumber: "64942212" }
const agr2607: Agreement = { ...agr2408, id: "01a0d2a4-a280-7012-8000-000000000002", number: "AGR-2607", customerId: kab.id, payerCustomerId: kommune.id }
const res240: Product = { id: "01a0d2a4-a280-700a-8000-000000000001", ...STAMPS, projectId: copenhagen.id, name: "Residual waste · 240L bin", kind: "container-collection", status: "active", unit: "pickup", containerTypeId: null, wasteFractionId: null, serviceFrequencyId: null, invoiceName: "Residual waste collection 240L", invoiceCode: "RES-240", vatPercent: 25, freeDays: null }
const bulky: Product = { ...res240, id: "01a0d2a4-a280-700a-8000-000000000005", name: "Bulky waste pickup", kind: "additional-service", unit: "job" }
const ROUTE = "01a0d2a4-a280-7030-8000-000000000001"
const PICKUP = "01a0d2a4-a280-7031-8000-000000000001"
const TICKET = "01a0d2a4-a280-7040-8000-000000000001"
const ADMIN = "01a0d2a4-a280-7003-8000-000000000001"

const ready: BillableEvent = {
  id: "01a0d2a4-a280-7050-8000-000000000001",
  ...STAMPS,
  projectId: copenhagen.id,
  kind: "pickup",
  status: "ready",
  serviceDate: "2026-09-29",
  agreementId: agr2408.id,
  subscriptionId: null,
  productId: res240.id,
  quantity: 1,
  unitPriceMinor: 1650,
  netMinor: 1650,
  vatPercent: 25,
  vatMinor: 413,
  currency: "DKK",
  priceListRowId: "01a0d2a4-a280-7029-8000-000000000003",
  blockReason: null,
  links: { routeId: ROUTE, pickupId: PICKUP, ticketId: null, reversesEventId: null, proofId: null },
  charge: null,
  sourceEventId: "01a0d2a4-a280-7060-8000-000000000001",
  createdBy: null,
  overrideReason: null,
  note: null,
  cancelledAt: null,
  cancelledBy: null,
  cancelReason: null,
  hold: null,
  invoiceLineId: null,
}
const blocked: BillableEvent = { ...ready, id: "01a0d2a4-a280-7050-8000-000000000002", kind: "ticket", status: "blocked", productId: null, unitPriceMinor: null, netMinor: null, vatPercent: null, vatMinor: null, currency: null, priceListRowId: null, blockReason: "no-product", links: { routeId: ROUTE, pickupId: null, ticketId: TICKET, reversesEventId: null, proofId: null } }
const manual: BillableEvent = { ...ready, id: "01a0d2a4-a280-7050-8000-000000000003", kind: "manual", productId: bulky.id, quantity: 2, unitPriceMinor: 30000, netMinor: 60000, vatMinor: 15000, priceListRowId: null, links: { routeId: null, pickupId: null, ticketId: null, reversesEventId: null, proofId: null }, sourceEventId: null, createdBy: ADMIN, overrideReason: "Agreed on the phone", note: "Two sofas" }

const NO_CONTEXT = (fixtures: readonly BusinessRecord[]): MappingContext => ({ fixtures, resolve: NOTHING_RESOLVED, companyRecordId: FIXTURE_COMPANY_ID, now: NOW })
const copenhagenRecord = projectAdapter.toRecord(copenhagen, NO_CONTEXT(fixturesOf("configure", "organization")))
const osterbroRecord = customerAdapter.toRecord(osterbro, NO_CONTEXT(fixturesOf("customers", "contacts")))
const [kabRecord, kommuneRecord] = [kab, kommune].map((customer) => customerAdapter.toRecord(customer, NO_CONTEXT([])))
const moduleOf = (records: BusinessRecord[], ids: string[]) => loaded({ records, serverIds: new Map(records.map((record, index) => [record.id, ids[index]])) }, 1)
const base: ServerRecordsState = new Map([
  ["configure.organization", moduleOf([copenhagenRecord], [copenhagen.id])],
  ["configure.access", moduleOf([{ ...copenhagenRecord, id: `user-${ADMIN}`, name: "Fares Abdelghany", recordKind: "User" }], [ADMIN])],
  ["customers.contacts", moduleOf([osterbroRecord, kabRecord, kommuneRecord], [osterbro.id, kab.id, kommune.id])],
])
const agreementRecords = [agr2408, agr2607].map((agreement) => agreementAdapter.toRecord(agreement, { ...NO_CONTEXT(fixturesOf("customers", "agreements")), resolve: resolverOver(base) }))
const withAgreement = new Map([...base, ["customers.agreements", moduleOf(agreementRecords, [agr2408.id, agr2607.id])]])
const productRecords = [res240, bulky].map((product) => productAdapter.toRecord(product, { ...NO_CONTEXT([]), resolve: resolverOver(withAgreement) }))
const routeRecord: BusinessRecord = { ...copenhagenRecord, id: `route-${ROUTE}`, name: "RC-1042 · 2026-09-29", recordKind: "Route" }
const state: ServerRecordsState = new Map([
  ...withAgreement,
  ["commercial.products", moduleOf(productRecords, [res240.id, bulky.id])],
  ["route-studio.routes", moduleOf([routeRecord], [ROUTE])],
])
const context = (fixtures: readonly BusinessRecord[], at: ServerRecordsState = state): MappingContext => ({ fixtures, resolve: resolverOver(at), companyRecordId: FIXTURE_COMPANY_ID, now: NOW })
const agreementWebId = (state.get("customers.agreements")!.records[0]).id

const pageOf = (items: unknown[]) => json({ items, nextCursor: null })

function made(id: string, recordKind: string, values: Record<string, string | boolean>, status = "Ready"): BusinessRecord {
  return { id, name: id, context: "", status, owner: "", value: "", updated: "Now", description: "", facts: {}, related: [], source: "Waste API", freshness: "Now", companyId: FIXTURE_COMPANY_ID, projectIds: ["project-copenhagen"], recordKind, submittedValues: values }
}

describe("the billable events module", () => {
  test("is switched after the agreements, the products and the routes an event names", () => {
    assert.ok(isServerBacked("commercial", "events"))
    for (const before of ["customers.agreements", "commercial.products", "route-studio.routes"]) assert.ok(SERVER_MODULE_KEYS.indexOf("commercial.events") > SERVER_MODULE_KEYS.indexOf(before), before)
    assert.deepEqual(eventsModule.resources, [billableEventAdapter])
  })

  test("shows a priced event with its agreement, customer, payer, product and route by name, its money in its own currency", () => {
    const record = billableEventAdapter.toRecord(ready, context(eventFixtures))
    assert.equal(record.id, `event-${ready.id}`)
    assert.equal(record.name, "Pickup · Residual waste · 240L bin")
    assert.equal(record.context, "Østerbro Housing · 2026-09-29")
    assert.equal(record.status, "Ready")
    assert.equal(record.value, "DKK 16.50")
    assert.deepEqual(record.allowedTransitions, [])
    assert.equal(record.recordKind, "Billable event")
    assert.equal(record.facts.Agreement, "AGR-2408")
    assert.equal(record.facts.Customer, "Østerbro Housing")
    assert.equal(record.facts.Payer, "Østerbro Housing", "the agreement's customer pays for itself")
    assert.equal(record.facts.Route, "RC-1042 · 2026-09-29")
    assert.equal(record.facts["Unit price"], "DKK 16.50")
    assert.equal(record.facts.VAT, "25% · DKK 4.13")
    assert.equal(record.facts.Origin, "Completed pickup")
    assert.equal(record.facts.Invoiced, "Not yet")
    assert.deepEqual(record.submittedValues, {
      projectId: "project-copenhagen",
      kind: "pickup",
      agreementId: agreementWebId,
      customerId: osterbroRecord.id,
      payerId: osterbroRecord.id,
      productId: `product-${res240.id}`,
      routeId: `route-${ROUTE}`,
      pickupId: `pickup-${PICKUP}`,
      priceListRowId: `price-row-${ready.priceListRowId}`,
      quantity: "1",
      serviceDate: "2026-09-29",
      status: "ready",
    })
  })

  test("names the agreement's customer and its payer each by their own fact, the customer leading the row (#256)", () => {
    const record = billableEventAdapter.toRecord({ ...ready, agreementId: agr2607.id }, context(eventFixtures))
    assert.equal(record.facts.Agreement, "AGR-2607")
    assert.equal(record.facts.Customer, "KAB Bolig")
    assert.equal(record.facts.Payer, "Københavns Kommune", "invoiced to the payer, and said so under its own name")
    assert.equal(record.context, "KAB Bolig · 2026-09-29", "the Customer · origin column")
    assert.equal(record.submittedValues?.customerId, kabRecord.id)
    assert.equal(record.submittedValues?.payerId, kommuneRecord.id)
  })

  test("shows a blocked event by what blocks it, and a manual one with the person's price and reason", () => {
    const stuck = billableEventAdapter.toRecord(blocked, context(eventFixtures))
    assert.equal(stuck.status, "Blocked")
    assert.equal(stuck.name, "Ticket · no product")
    assert.equal(stuck.value, "No product")
    assert.equal(stuck.facts["Block reason"], "No product")
    assert.equal(stuck.facts.Ticket, `ticket-${TICKET}`)
    const dropped = billableEventAdapter.toRecord({ ...blocked, status: "cancelled", cancelledAt: "2026-09-30T10:00:00.000Z", cancelledBy: ADMIN, cancelReason: "duplicate" }, context(eventFixtures))
    assert.equal(dropped.value, "", "a cancelled event is blocked by nothing any more")
    assert.equal(dropped.facts.Cancelled, "2026-09-30 12:00 · Duplicate")
    const entered = billableEventAdapter.toRecord(manual, context(eventFixtures))
    assert.equal(entered.value, "DKK 600.00")
    assert.equal(entered.facts["Override reason"], "Agreed on the phone")
    assert.equal(entered.facts.Origin, "Entered by Fares Abdelghany")
  })

  test("shows a recurring charge by its charge period's first and last days and the days it charged, a run's and nobody's (#291 C2)", () => {
    const charge: BillableEvent = { ...ready, id: "01a0d2a4-a280-7050-8000-000000000004", kind: "subscription", serviceDate: "2026-11-16", subscriptionId: "01a0d2a4-a280-7013-8000-000000000001", unitPriceMinor: 5500, netMinor: 5500, vatMinor: 1375, links: { routeId: null, pickupId: null, ticketId: null, reversesEventId: null, proofId: null }, charge: { periodFrom: "2026-11-01", periodTo: "2026-12-01", chargedDays: 15, periodDays: 30 }, sourceEventId: null }
    const record = billableEventAdapter.toRecord(charge, context(eventFixtures))
    assert.equal(record.name, "Recurring charge · Residual waste · 240L bin")
    assert.equal(record.facts.Kind, "Recurring charge")
    assert.equal(record.facts["Charge period"], "2026-11-01 – 2026-11-30", "the last day in, where the wire's end is the first day out")
    assert.equal(record.facts["Days charged"], "15 of 30")
    assert.equal(record.facts.Origin, "Charged by a billing run")
    assert.equal(billableEventAdapter.toRecord(ready, context(eventFixtures)).facts["Charge period"], undefined, "a pickup's event charges no period")
    const tooMuch = billableEventAdapter.toRecord({ ...charge, status: "blocked", unitPriceMinor: null, netMinor: null, vatPercent: null, vatMinor: null, currency: null, priceListRowId: null, blockReason: "amount-too-large" }, context(eventFixtures))
    assert.equal(tooMuch.facts["Block reason"], "Amount too large")
  })

  test("makes the manual event's body: the project the agreement's, a person's price in the agreement's currency with its reason", () => {
    const record = made("events-billable-event-1", "Billable event", { agreementId: agreementWebId, productId: `product-${bulky.id}`, quantity: "2", serviceDate: "2026-09-29", note: "Two sofas", unitPrice: "300", overrideReason: "Agreed on the phone" })
    const body = billableEventAdapter.toCreateBody!(record, context(eventFixtures))
    assert.deepEqual(body, { projectId: copenhagen.id, agreementId: agr2408.id, productId: bulky.id, quantity: 2, serviceDate: "2026-09-29", note: "Two sofas", unitPriceMinor: 30000, overrideReason: "Agreed on the phone" })
    assert.ok(BillableEventCreate.safeParse(body).success)
    const priced = billableEventAdapter.toCreateBody!(made("events-billable-event-2", "Billable event", { agreementId: agreementWebId, productId: `product-${bulky.id}`, quantity: "1", serviceDate: "2026-09-29" }), context(eventFixtures))
    assert.deepEqual(priced, { projectId: copenhagen.id, agreementId: agr2408.id, productId: bulky.id, quantity: 1, serviceDate: "2026-09-29" })
    assert.ok(BillableEventCreate.safeParse(priced).success)
  })

  test("refuses a manual event the API would: a price without its reason, a quantity of none, an agreement or a product it does not hold", () => {
    assert.equal(OVERRIDE_WITH_A_REASON, WIRE_OVERRIDE_WITH_A_REASON, "the contract's sentence, spelled again since the web imports the contracts as types")
    const refusalOf = (values: Record<string, string>) => billableEventAdapter.toCreateBody!(made("events-billable-event-1", "Billable event", { agreementId: agreementWebId, productId: `product-${bulky.id}`, quantity: "1", serviceDate: "2026-09-29", ...values }), context(eventFixtures))
    assert.deepEqual(refusalOf({ unitPrice: "300" }), { path: "overrideReason", message: OVERRIDE_WITH_A_REASON })
    assert.deepEqual(refusalOf({ overrideReason: "Phone" }), { path: "overrideReason", message: OVERRIDE_WITH_A_REASON })
    assert.deepEqual(refusalOf({ unitPrice: "3.005", overrideReason: "Phone" }), { path: "unitPrice", message: "An amount in DKK, such as 18.50" })
    assert.deepEqual(refusalOf({ quantity: "0" }), { path: "quantity", message: "A quantity is a whole number, 1 or more" })
    assert.deepEqual(refusalOf({ agreementId: "agreement-9999" }), { path: "agreementId", message: "Pick an agreement the API holds" })
    assert.deepEqual(refusalOf({ productId: "product-bulky" }), { path: "productId", message: "Pick a product the API holds" })
    assert.deepEqual(refusalOf({ serviceDate: "" }), { path: "serviceDate", message: "Pick the service date" })
  })

  test("moves by its two commands alone: no status on a patch, no edit", () => {
    const record = billableEventAdapter.toRecord(ready, context(eventFixtures))
    for (const status of ["Ready", "Blocked", "Cancelled", "Invoiced"]) assert.ok(!spellsStatus(eventsModule, record, status), status)
    assert.deepEqual(billableEventAdapter.toPatchBody(record, { ...record, submittedValues: { ...record.submittedValues, quantity: "3" } }, context(eventFixtures)), { path: "quantity", message: "A billable event moves by its commands: reprice a blocked one, cancel one that should not be invoiced" })
  })

  test("offers a command only where the API moves the event by it: reprice a blocked one, hold a ready one, release a held one, cancel any of them, never a reversal (#281, M14 of #293)", () => {
    const offered = (event: BillableEvent) => eventCommandsOffered(billableEventAdapter.toRecord(event, context(eventFixtures)))
    assert.deepEqual(offered(blocked), ["reprice", "cancel"])
    assert.deepEqual(offered(ready), ["hold", "cancel"], "a priced event is not repriced")
    assert.deepEqual(offered({ ...ready, status: "held", hold: { at: "2026-09-10T08:00:00.000Z", by: null, reason: "Checked with the customer" } }), ["release", "cancel"])
    for (const status of ["invoiced", "cancelled", "reversed"] as const) assert.deepEqual(offered({ ...ready, status }), [], `${status}: a credit note corrects it, or there is nothing left to do`)
    assert.deepEqual(offered({ ...ready, kind: "reversal" }), [], "a reversal is the correction, never cancelled")
    assert.deepEqual(eventCommandsOffered({ ...billableEventAdapter.toRecord(ready, context(eventFixtures)), submittedValues: {} }), [], "a record that does not say its status is offered nothing")
  })

  test("reprices a blocked ticket's event with the product the office picked, and cancels one with the office's reason", async () => {
    const record = billableEventAdapter.toRecord(blocked, context(eventFixtures))
    const current = moduleOf([record], [blocked.id])
    const repriced: BillableEvent = { ...blocked, status: "ready", productId: bulky.id, unitPriceMinor: 4500, netMinor: 4500, vatPercent: 25, vatMinor: 1125, currency: "DKK", blockReason: null }
    // The API names the event by its id; the office is told the row by the name it reads (#281).
    const { fetch, calls } = scripted([() => json(repriced), () => problem(409, `Billable event ${blocked.id} is ready; a priced event is not repriced — cancel it and enter it again`), () => json({ ...repriced, status: "cancelled", cancelReason: "duplicate", cancelledAt: "2026-09-30T12:00:00.000Z", cancelledBy: ADMIN })])
    const options = { fixtures: eventFixtures, state }
    const done = await commandRecord(clientOver(fetch), eventsModule, current, record, "reprice", { productId: `product-${bulky.id}` }, options)
    assert.equal(done.kind, "done")
    assert.equal(calls[0].url, `http://api.test/billable-events/${blocked.id}/reprice`)
    assert.deepEqual(bodyOf(calls[0]), { productId: bulky.id })
    assert.ok(BillableEventReprice.safeParse(bodyOf(calls[0])).success)
    if (done.kind === "done") assert.equal(done.record.status, "Ready")
    const again = await commandRecord(clientOver(fetch), eventsModule, current, record, "reprice", {}, options)
    assert.equal(again.kind, "refused")
    if (again.kind === "refused") {
      assert.equal(again.what, `${record.name} was not repriced`)
      assert.equal(problemSentence(again.problem), "Billable event Ticket · no product is ready; a priced event is not repriced — cancel it and enter it again")
    }
    assert.deepEqual(bodyOf(calls[1]), {}, "a pickup's event is repriced with no product")
    const cancelled = await commandRecord(clientOver(fetch), eventsModule, current, record, "cancel", { reason: "duplicate", note: "" }, options)
    assert.equal(cancelled.kind, "done")
    assert.deepEqual(bodyOf(calls[2]), { reason: "duplicate" })
    assert.ok(BillableEventCancel.safeParse(bodyOf(calls[2])).success)
    const unsaid = await commandRecord(clientOver(fetch), eventsModule, current, record, "cancel", { reason: "pickup-corrected" }, options)
    assert.equal(unsaid.kind, "refused", "the consumer's reason is never a person's")
    assert.equal(calls.length, 3)
  })

  test("holds a ready event for review with the office's reason, and releases a held one with no body (M14 of #293)", async () => {
    const record = billableEventAdapter.toRecord(ready, context(eventFixtures))
    const current = moduleOf([record], [ready.id])
    const held: BillableEvent = { ...ready, status: "held", hold: { at: "2026-09-30T12:00:00.000Z", by: ADMIN, reason: "Checked with the customer" } }
    const { fetch, calls } = scripted([() => json(held), () => json(ready)])
    const options = { fixtures: eventFixtures, state }
    const unsaid = await commandRecord(clientOver(fetch), eventsModule, current, record, "hold", { reason: "" }, options)
    assert.equal(unsaid.kind, "refused", "a hold says why")
    const done = await commandRecord(clientOver(fetch), eventsModule, current, record, "hold", { reason: "Checked with the customer" }, options)
    assert.equal(done.kind, "done")
    assert.equal(calls[0].url, `http://api.test/billable-events/${ready.id}/hold`)
    assert.deepEqual(bodyOf(calls[0]), { reason: "Checked with the customer" })
    assert.ok(BillableEventHold.safeParse(bodyOf(calls[0])).success)
    if (done.kind === "done") assert.equal(done.record.facts?.["Held for review"], "2026-09-30 14:00 · Checked with the customer")
    const released = await commandRecord(clientOver(fetch), eventsModule, current, billableEventAdapter.toRecord(held, context(eventFixtures)), "release", {}, options)
    assert.equal(released.kind, "done")
    assert.equal(calls[1].url, `http://api.test/billable-events/${ready.id}/release`)
    assert.equal(calls.length, 2)
  })
})

describe("Explain price on a billable event's own question (#259)", () => {
  const OWN_LIST = "01a0d2a4-a280-7028-8000-000000000002"
  const DEFAULT_LIST = "01a0d2a4-a280-7028-8000-000000000001"
  const agreement = state.get("customers.agreements")!.records[0]
  // The rows the question is read through, as their adapters make them: the row that won and its list, the project's default list, the route's scheme in its area, the pickup's container of its type.
  const winningRow = made(`price-row-${ready.priceListRowId}`, "Price row", { priceListId: `price-list-${OWN_LIST}`, productId: `product-${res240.id}` })
  const ownList = made(`price-list-${OWN_LIST}`, "Price list", { isDefault: false })
  const defaultList = made(`price-list-${DEFAULT_LIST}`, "Price list", { isDefault: true })
  const route = made(`route-${ROUTE}`, "Route", { schemeId: "scheme-01a0d2a4-a280-7022-8000-000000000001" })
  const scheme = made("scheme-01a0d2a4-a280-7022-8000-000000000001", "Route scheme", { planningAreaId: "area-01a0d2a4-a280-7009-8000-000000000001" })
  const pickup = made(`pickup-${PICKUP}`, "Pickup", { containerId: "asset-01a0d2a4-a280-7020-8000-000000000001", wasteFractionId: "waste-fraction-01a0d2a4-a280-7007-8000-000000000001" })
  const container = made("asset-01a0d2a4-a280-7020-8000-000000000001", "Container", { containerType: "container-type-01a0d2a4-a280-7008-8000-000000000001" })
  const everything = [agreement, osterbroRecord, winningRow, ownList, defaultList, route, scheme, pickup, container]
  /** The store holding `rows`, each under the server id its web id carries, as the surface's resolver reads it. */
  const holding = (rows: readonly BusinessRecord[]) => resolverOver(new Map([["held", moduleOf([...rows], rows.map((row) => row.id.slice(-36)))]]))
  const pricedEvent = billableEventAdapter.toRecord(ready, context(eventFixtures))
  const manualEvent = billableEventAdapter.toRecord({ ...manual, overrideReason: null }, context(eventFixtures))

  test("a priced pickup's: the list its row won in, its product and service date, its agreement's customer and kind, its route's zone and its pickup's fraction and container type", () => {
    assert.deepEqual(eventQuestion(pricedEvent, holding(everything)), {
      priceListId: ownList.id,
      productId: `product-${res240.id}`,
      on: "2026-09-29",
      planningAreaId: "area-01a0d2a4-a280-7009-8000-000000000001",
      customerKind: "organisation",
      containerType: "container-type-01a0d2a4-a280-7008-8000-000000000001",
      wasteFraction: "waste-fraction-01a0d2a4-a280-7007-8000-000000000001",
      customerId: osterbroRecord.id,
    })
  })

  test("the winning row's conditions first, which the event matched: an event whose route and pickup are no longer read still names its winner", () => {
    const zoned = { ...winningRow, submittedValues: { ...winningRow.submittedValues, planningAreaId: "area-01a0d2a4-a280-7009-8000-000000000002", wasteFraction: "waste-fraction-01a0d2a4-a280-7007-8000-000000000002" } }
    assert.deepEqual(eventQuestion(pricedEvent, holding([agreement, osterbroRecord, zoned, ownList])), {
      priceListId: ownList.id,
      productId: `product-${res240.id}`,
      on: "2026-09-29",
      planningAreaId: "area-01a0d2a4-a280-7009-8000-000000000002",
      customerKind: "organisation",
      wasteFraction: "waste-fraction-01a0d2a4-a280-7007-8000-000000000002",
      customerId: osterbroRecord.id,
    })
    assert.equal(eventQuestion(pricedEvent, holding([...everything.filter((row) => row !== winningRow), zoned])).planningAreaId, "area-01a0d2a4-a280-7009-8000-000000000002", "over what its rows say now")
  })

  test("an event no row priced asks its agreement's own list, else its project's default, and none while its agreement is not read; a ticket's event asks no product", () => {
    assert.deepEqual(eventQuestion(manualEvent, holding(everything)), { priceListId: defaultList.id, productId: `product-${bulky.id}`, on: "2026-09-29", customerKind: "organisation", customerId: osterbroRecord.id }, "AGR-2408 names no list of its own: the project's default")
    const pricedUnder = { ...agreement, facts: { ...agreement.facts, "Price list": ownList.id } }
    assert.equal(eventQuestion(manualEvent, holding([pricedUnder, ownList, defaultList])).priceListId, ownList.id, "the agreement's own list, by the id chip its fact names it by")
    const named = { ...agreement, facts: { ...agreement.facts, "Price list": "PL-Østerbro-2026" } }
    const otherProjects = { ...ownList, id: "price-list-01a0d2a4-a280-7028-8000-000000000003", name: "PL-Østerbro-2026", projectIds: ["project-harbor"] }
    assert.equal(eventQuestion(manualEvent, holding([named, otherProjects, { ...ownList, name: "PL-Østerbro-2026" }, defaultList])).priceListId, ownList.id, "or by its name, among its project's lists")
    assert.equal(eventQuestion(manualEvent, holding([ownList, defaultList])).priceListId, undefined, "the agreement not read: no list guessed")
    const ticketEvent = billableEventAdapter.toRecord(blocked, context(eventFixtures))
    assert.equal(eventQuestion(ticketEvent, holding(everything)).productId, undefined)
  })

  test("asks only what the store holds the rows of: nothing loaded leaves the product and the day", () => {
    assert.deepEqual(eventQuestion(pricedEvent, NOTHING_RESOLVED), { productId: `product-${res240.id}`, on: "2026-09-29" })
  })

  test("is offered where the event's price is a list's: priced or blocked, never a person's own price nor a reversal's copy", () => {
    assert.ok(eventPricedByList(pricedEvent))
    assert.ok(eventPricedByList(billableEventAdapter.toRecord(blocked, context(eventFixtures))))
    assert.ok(eventPricedByList(manualEvent), "a manual event the list priced")
    assert.ok(!eventPricedByList(billableEventAdapter.toRecord(manual, context(eventFixtures))), "a manual event at a price of the person's own, with its reason")
    assert.ok(!eventPricedByList(billableEventAdapter.toRecord({ ...ready, kind: "reversal", priceListRowId: null }, context(eventFixtures))))
  })
})

describe("the billing runs module", () => {
  const run: BillingRun = { id: "01a0d2a4-a280-7070-8000-000000000001", ...STAMPS, projectId: copenhagen.id, periodFrom: "2026-09-01", periodTo: "2026-09-30", status: "completed", requestedBy: ADMIN, completedAt: "2026-09-30T10:00:00.000Z", eventCount: 3, invoiceCount: 1, excludedCustomerCount: 1, netMinor: 66650, vatMinor: 16663, note: "September" }
  const detail: BillingRunDetail = { ...run, exclusions: [{ ...RECORDED, id: "01a0d2a4-a280-7071-8000-000000000001", billingRunId: run.id, customerId: osterbro.id, reason: "all-events-blocked", eventCount: 1 }], invoiceIds: ["01a0d2a4-a280-7080-8000-000000000001"] }

  test("is switched after the events a run invoices", () => {
    assert.ok(isServerBacked("commercial", "billing"))
    assert.ok(SERVER_MODULE_KEYS.indexOf("commercial.billing") > SERVER_MODULE_KEYS.indexOf("commercial.events"))
    assert.deepEqual(billingModule.resources, [billingRunAdapter])
  })

  test("shows a run by its period, its counts and who asked for it", () => {
    const record = billingRunAdapter.toRecord(run, context(runFixtures))
    assert.equal(record.id, `billing-run-${run.id}`)
    assert.equal(record.name, "Billing run 2026-09-01 – 2026-09-30")
    assert.equal(record.status, "Completed")
    assert.equal(record.value, "1 invoice")
    assert.equal(record.facts.Events, "3")
    assert.equal(record.facts["Excluded customers"], "1")
    assert.equal(record.facts["Requested by"], "Fares Abdelghany")
    assert.equal(record.facts.Net, "DKK 666.50")
    assert.deepEqual(billingRunAdapter.toRecord({ ...run, requestedBy: null, invoiceCount: 2 }, context(runFixtures)).facts["Requested by"], "The monthly schedule")
  })

  test("shows no total where it cannot say the project's currency: the run's details read its invoices' totals per currency", () => {
    const unknown = billingRunAdapter.toRecord(run, { ...context(runFixtures), resolve: resolverOver(new Map()) })
    assert.equal(unknown.facts.Net, undefined)
    assert.equal(unknown.facts.VAT, undefined)
    assert.equal(unknown.value, "1 invoice")
  })

  test("makes one body for the preview and the run, and refuses a period that runs backwards in the contract's words", () => {
    assert.equal(PERIOD_ORDERED, WIRE_PERIOD_ORDERED)
    assert.equal(PERIOD_ENDS_BY_TODAY, WIRE_PERIOD_ENDS_BY_TODAY)
    const values = { projectId: "project-copenhagen", periodFrom: "2026-09-01", periodTo: "2026-09-30", note: "September" }
    const body = billingRunBody(values, resolverOver(state))
    assert.deepEqual(body, { projectId: copenhagen.id, periodFrom: "2026-09-01", periodTo: "2026-09-30", note: "September" })
    assert.ok(BillingRunCreate.safeParse(body).success)
    assert.deepEqual(billingRunBody({ ...values, periodTo: "2026-08-31" }, resolverOver(state)), { path: "periodTo", message: PERIOD_ORDERED })
    assert.deepEqual(billingRunBody(values, resolverOver(state), "2026-09-29"), { path: "periodTo", message: PERIOD_ENDS_BY_TODAY }, "a period still running on the project's today")
    assert.deepEqual(billingRunBody(values, resolverOver(state), "2026-09-30"), body, "a period ending today is closed by the run")
    assert.deepEqual(billingRunBody({ ...values, projectId: "" }, resolverOver(state)), { path: "projectId", message: "Pick a project" })
    assert.deepEqual(billingRunBody({ ...values, periodFrom: "" }, resolverOver(state)), { path: "periodFrom", message: "Pick the first day of the period" })
  })

  test("says why a run passed over a payer: every event blocked, or held for review, or each one or the other (M14 of #293)", () => {
    assert.equal(exclusionWords({ eventCount: 1, reason: "all-events-blocked" }), "1 event, all blocked")
    assert.equal(exclusionWords({ eventCount: 4, reason: "all-events-held" }), "4 events, all held for review")
    assert.equal(exclusionWords({ eventCount: 3, reason: "all-events-blocked-or-held" }), "3 events, each blocked or held for review")
  })

  test("previews through the client, writing nothing, and runs through the store's create", async () => {
    const preview: BillingRunPreview = { eventCount: 3, invoiceCount: 1, totals: [{ currency: "DKK", netMinor: 66650, vatMinor: 16663 }], exclusions: [{ customerId: osterbro.id, reason: "all-events-blocked", eventCount: 1 }], heldEventCount: 0, catchUp: [], catchUpDeferredCount: 0 }
    const { fetch, calls } = scripted([() => json(preview), () => json(detail, 201, { location: `/billing-runs/${run.id}` })])
    const body = billingRunBody({ projectId: "project-copenhagen", periodFrom: "2026-09-01", periodTo: "2026-09-30" }, resolverOver(state))
    if ("message" in (body as object)) throw new Error("refused")
    const answered = await previewBillingRun(clientOver(fetch), body as never)
    assert.equal(calls[0].url, "http://api.test/billing-runs/preview")
    assert.equal(calls[0].init.method, "POST")
    assert.deepEqual(answered, preview)
    const current = moduleOf([], [])
    const outcome = await writeRecord(clientOver(fetch), billingModule, current, made("billing-billing-run-1", "Billing run", { projectId: "project-copenhagen", periodFrom: "2026-09-01", periodTo: "2026-09-30" }, "Requested"), { fixtures: runFixtures, state })
    assert.equal(outcome.kind, "created")
    assert.equal(calls[1].url, "http://api.test/billing-runs")
    assert.ok(BillingRunCreate.safeParse(bodyOf(calls[1])).success)
    if (outcome.kind === "created") assert.equal(outcome.record.status, "Completed")
  })

  test("is a record of what it did: no status move, no edit", () => {
    const record = billingRunAdapter.toRecord(run, context(runFixtures))
    assert.ok(!spellsStatus(billingModule, record, "Failed"))
    assert.deepEqual(billingRunAdapter.toPatchBody(record, { ...record, submittedValues: { ...record.submittedValues, note: "Moved" } }, context(runFixtures)), { path: "note", message: "A billing run is a record of what it did: nothing on it changes" })
  })
})

describe("the invoices module", () => {
  const invoice: Invoice = { ...RECORDED, id: "01a0d2a4-a280-7080-8000-000000000001", projectId: copenhagen.id, number: 26007188, label: "INV-26007188", kind: "invoice", customerId: osterbro.id, currency: "DKK", issuedOn: "2026-09-30", dueOn: "2026-10-30", periodFrom: "2026-09-01", periodTo: "2026-09-30", billingRunId: "01a0d2a4-a280-7070-8000-000000000001", creditsInvoiceId: null, creditReason: null, creditNote: null, netMinor: 66650, vatMinor: 16663, grossMinor: 83313, issuedBy: ADMIN, paymentReference: null, paidMinor: 0, outstandingMinor: 83313, paymentStatus: "open" }
  const creditNote: Invoice = { ...invoice, id: "01a0d2a4-a280-7080-8000-000000000002", number: 26007189, label: "CN-26007189", kind: "credit-note", dueOn: "2026-09-30", periodFrom: null, periodTo: null, billingRunId: null, creditsInvoiceId: invoice.id, creditReason: "quantity-correction", creditNote: "One sofa", netMinor: -30000, vatMinor: -7500, grossMinor: -37500 }
  const line: InvoiceLine = { ...RECORDED, id: "01a0d2a4-a280-7081-8000-000000000001", invoiceId: invoice.id, position: 1, billableEventId: manual.id, creditsLineId: null, description: "Bulky waste pickup 2026-09-29", productId: bulky.id, serviceDate: "2026-09-29", quantity: 2, unitPriceMinor: 30000, netMinor: 60000, vatPercent: 25, vatMinor: 15000 }

  test("is switched after the billing runs that issue invoices", () => {
    assert.ok(isServerBacked("commercial", "invoices"))
    assert.ok(SERVER_MODULE_KEYS.indexOf("commercial.invoices") > SERVER_MODULE_KEYS.indexOf("commercial.billing"))
    assert.deepEqual(invoicesModule.resources, [invoiceAdapter])
  })

  test("lists invoices and credit notes in one read, an invoice read as credited by the credit notes naming it", async () => {
    const { fetch, calls } = scripted([() => pageOf([invoice, creditNote])])
    const result = await loadModule(clientOver(fetch), invoicesModule, { fixtures: invoiceFixtures, state, now: NOW })
    assert.deepEqual(calls.map((call) => call.url), ["http://api.test/invoices?limit=200"])
    const [shown, credit] = result.records
    assert.equal(shown.id, `invoice-${invoice.id}`)
    assert.equal(shown.name, "INV-26007188")
    assert.equal(shown.context, "Østerbro Housing · 2026-09-01 – 2026-09-30")
    assert.equal(shown.status, "Partially credited")
    assert.equal(shown.value, "DKK 833.13")
    assert.equal(shown.facts["Credit notes"], "1")
    assert.equal(credit.id, `credit-note-${creditNote.id}`)
    assert.equal(credit.name, "CN-26007189")
    assert.equal(credit.status, "Credit note")
    assert.equal(credit.recordKind, "Credit note")
    assert.equal(credit.facts.Credits, "INV-26007188")
    assert.equal(credit.facts["Credit reason"], "Quantity correction")
    assert.equal(credit.value, "-DKK 375.00")
    const asRead = (document: Invoice) => ({ ...document, createdAt: document.recordedAt, updatedAt: document.recordedAt })
    const whole = invoiceAdapter.toRecord({ ...asRead(invoice), creditedGrossMinor: -83313, creditNoteCount: 2 }, context(invoiceFixtures))
    assert.equal(whole.status, "Credited")
    assert.equal(invoiceAdapter.toRecord({ ...asRead(invoice), creditedGrossMinor: 0, creditNoteCount: 0 }, context(invoiceFixtures)).status, "Issued")
  })

  test("issues a credit note as a create under the invoice it corrects: every line, or the named lines by quantity", async () => {
    const shown = invoiceAdapter.toRecord({ ...invoice, createdAt: invoice.recordedAt, updatedAt: invoice.recordedAt, creditedGrossMinor: 0, creditNoteCount: 0 }, context(invoiceFixtures))
    const current = moduleOf([shown], [invoice.id])
    const withInvoice = new Map([...state, ["commercial.invoices", current]])
    const all = invoiceAdapter.toCreateBody!(made("invoices-credit-note-1", "Credit note", { creditsInvoiceId: shown.id, reason: "service-not-delivered", note: "", scope: "all" }, "Issued"), context(invoiceFixtures, withInvoice))
    assert.deepEqual(all, { invoiceId: invoice.id, body: { reason: "service-not-delivered", lines: "all" } })
    assert.ok(CreditNoteCreate.safeParse((all as { body: unknown }).body).success)
    const partial = invoiceAdapter.toCreateBody!(made("invoices-credit-note-2", "Credit note", { creditsInvoiceId: shown.id, reason: "quantity-correction", note: "One sofa", scope: "lines", [`line:${line.id}`]: "1", "line:01a0d2a4-a280-7081-8000-000000000002": "" }, "Issued"), context(invoiceFixtures, withInvoice))
    assert.deepEqual(partial, { invoiceId: invoice.id, body: { reason: "quantity-correction", note: "One sofa", lines: [{ lineId: line.id, quantity: 1 }] } })
    assert.ok(CreditNoteCreate.safeParse((partial as { body: unknown }).body).success)
    assert.deepEqual(invoiceAdapter.toCreateBody!(made("invoices-credit-note-3", "Credit note", { creditsInvoiceId: shown.id, reason: "quantity-correction", scope: "lines" }, "Issued"), context(invoiceFixtures, withInvoice)), { path: "lines", message: "Name a line and the quantity to credit, or credit every line" })
    assert.deepEqual(invoiceAdapter.toCreateBody!(made("invoices-credit-note-4", "Credit note", { creditsInvoiceId: shown.id, reason: "quantity-correction", scope: "lines", [`line:${line.id}`]: "1.5" }, "Issued"), context(invoiceFixtures, withInvoice)), { path: `line:${line.id}`, message: "A quantity is a whole number, 1 or more" })
    assert.deepEqual(invoiceAdapter.toCreateBody!(made("invoices-credit-note-5", "Credit note", { creditsInvoiceId: shown.id, reason: "", scope: "all" }, "Issued"), context(invoiceFixtures, withInvoice)), { path: "reason", message: "Pick a reason" })

    const issued: InvoiceDetail = { ...creditNote, lines: [{ ...line, id: "01a0d2a4-a280-7081-8000-000000000009", invoiceId: creditNote.id, billableEventId: null, creditsLineId: line.id, quantity: 1, netMinor: -30000, vatMinor: -7500 }], creditNotes: [] }
    const { fetch, calls } = scripted([() => json(issued, 201, { location: `/invoices/${creditNote.id}` }), () => problem(409, "Invoice INV-26007188 is fully credited")])
    const outcome = await writeRecord(clientOver(fetch), invoicesModule, current, made("invoices-credit-note-6", "Credit note", { creditsInvoiceId: shown.id, reason: "quantity-correction", note: "One sofa", scope: "lines", [`line:${line.id}`]: "1" }, "Issued"), { fixtures: invoiceFixtures, state: withInvoice })
    assert.equal(calls[0].url, `http://api.test/invoices/${invoice.id}/credit-notes`)
    assert.equal(outcome.kind, "created")
    if (outcome.kind === "created") assert.equal(outcome.record.name, "CN-26007189")
    const refused = await writeRecord(clientOver(fetch), invoicesModule, current, made("invoices-credit-note-7", "Credit note", { creditsInvoiceId: shown.id, reason: "duplicate", scope: "all" }, "Issued"), { fixtures: invoiceFixtures, state: withInvoice })
    assert.equal(refused.kind, "refused")
    if (refused.kind === "refused") assert.equal(problemSentence(refused.problem), "Invoice INV-26007188 is fully credited")
  })

  test("refuses a credit note against a credit note, and every edit of an issued document", () => {
    const credit = invoiceAdapter.toRecord({ ...creditNote, createdAt: creditNote.recordedAt, updatedAt: creditNote.recordedAt }, context(invoiceFixtures))
    const withCredit = new Map([...state, ["commercial.invoices", moduleOf([credit], [creditNote.id])]])
    assert.deepEqual(invoiceAdapter.toCreateBody!(made("invoices-credit-note-1", "Credit note", { creditsInvoiceId: credit.id, reason: "duplicate", scope: "all" }, "Issued"), context(invoiceFixtures, withCredit)), { path: "creditsInvoiceId", message: "Pick an invoice the API holds: a credit note is not credited" })
    assert.deepEqual(invoiceAdapter.toPatchBody(credit, { ...credit, name: "CN-1" }, context(invoiceFixtures)), { path: "status", message: "An issued document never changes: correct an invoice with a credit note" })
    assert.ok(!spellsStatus(invoicesModule, credit, "Credited"))
  })
})
