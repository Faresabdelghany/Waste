// The Finance & Contracting tables against Postgres (Issue #112, slice 1),
// on a fresh database of this file's own so that "migration 0010 applies to
// a clean database" is proved — the third `ALTER TABLE company`, the
// product's and the agreement's new columns, the unload's project key and the
// outbox's replaced checks included — and nothing depends on what the shared
// local database holds: the composite keys refuse another company's customer,
// container type, waste fraction, provider and account and another project's
// list, product, planning area, agreement, route, pickup, ticket, assignment,
// invoice and unload, and a pickup of another route of the same project; each
// of the six exclusion constraints refuses two of one thing at a time and
// accepts the second once the first has ended, the generated condition key
// telling two condition sets apart; the partial uniques hold one default list
// per project, one line per event and one event per outbox event; each shape
// check refuses its pair; the domain's `vatOf` agrees with the two `_vat_shape`
// checks over odd amounts of both signs; the API role can append to the five
// ledgers and update or delete nothing there while the owner can; the
// counter's `update … returning` answers disjoint numbers under two concurrent
// transactions; the weight-review lookup folds the latest row; and the fence
// shows the API role exactly its company's rows in each of the sixteen. Every
// test but the counter's runs as the owner in a transaction that is rolled
// back, so nothing needs cleaning up; the counter's commits, and the database
// is dropped after.
import assert from "node:assert/strict"
import { performance } from "node:perf_hooks"
import { after, before, describe, test } from "node:test"

import type { Point } from "@waste/contracts/geojson"
import { vatOf } from "@waste/domain/finance/money"
import { SETTLEMENT_STATUSES, type SettlementStatus } from "@waste/domain/finance/vocabulary"
import { and, eq, getTableName, sql } from "drizzle-orm"
import type { PgTable } from "drizzle-orm/pg-core"

import { createDb, type Database, type Tx } from "../client"
import { migrateDatabase } from "../migrate"
import { reviewStatus, weightReviewOf } from "../query/weight-review"
import { API_ROLE } from "../roles"
import { role, userAccount } from "../schema/access"
import { agreement, subscription } from "../schema/agreements"
import { containerType, product, wasteFraction } from "../schema/catalogue"
import { container } from "../schema/containers"
import { customer, property } from "../schema/customers"
import { outboxEvent, pickup, route, unload } from "../schema/execution"
import {
  billableEvent,
  billingRun,
  billingRunExclusion,
  invoice,
  invoiceLine,
  priceList,
  priceListRow,
  serviceArea,
  serviceAreaAssignment,
  serviceAreaPlanningArea,
  serviceAreaWasteFraction,
  serviceProviderPrice,
  settlement,
  settlementEvent,
  settlementLine,
  weightReview,
} from "../schema/finance"
import { driver, vehicle } from "../schema/fleet"
import { vehicleType } from "../schema/fleet-types"
import { company, project, serviceProvider } from "../schema/organisation"
import { depot, unloadingStation } from "../schema/places"
import { planningArea } from "../schema/planning-areas"
import { ticket } from "../schema/resolution"
import { collectionGroup, routeScheme } from "../schema/route-schemes"
import { withCompany } from "../tenant"
import { databaseUnderTest, freshDatabase, type FreshDatabase } from "./database"
import { refusedWith, rolledBack, rolledBackIn } from "./specimen"

const database = databaseUnderTest()

/** One company's fixture ids, a nibble telling the companies apart; this file's own bucket, on its own database. */
const ids = (n: "a" | "b") => ({
  company: `018f7c35-${n}000-7000-8000-000000000001`,
  project: `018f7c35-${n}000-7000-8000-000000000002`,
  role: `018f7c35-${n}000-7000-8000-000000000003`,
  account: `018f7c35-${n}000-7000-8000-000000000004`,
  wasteFraction: `018f7c35-${n}000-7000-8000-000000000005`,
  containerType: `018f7c35-${n}000-7000-8000-000000000006`,
  container: `018f7c35-${n}000-7000-8000-000000000007`,
  customer: `018f7c35-${n}000-7000-8000-000000000008`,
  /** A second customer, the one the run excluded. */
  secondCustomer: `018f7c35-${n}000-7000-8000-000000000009`,
  property: `018f7c35-${n}000-7000-8000-00000000000a`,
  product: `018f7c35-${n}000-7000-8000-00000000000b`,
  agreement: `018f7c35-${n}000-7000-8000-00000000000c`,
  subscription: `018f7c35-${n}000-7000-8000-00000000000d`,
  planningArea: `018f7c35-${n}000-7000-8000-00000000000e`,
  serviceProvider: `018f7c35-${n}000-7000-8000-00000000000f`,
  vehicleType: `018f7c35-${n}000-7000-8000-000000000010`,
  depot: `018f7c35-${n}000-7000-8000-000000000011`,
  station: `018f7c35-${n}000-7000-8000-000000000012`,
  vehicle: `018f7c35-${n}000-7000-8000-000000000013`,
  driver: `018f7c35-${n}000-7000-8000-000000000014`,
  scheme: `018f7c35-${n}000-7000-8000-000000000015`,
  group: `018f7c35-${n}000-7000-8000-000000000016`,
  route: `018f7c35-${n}000-7000-8000-000000000017`,
  /** A second route of the same group, on another day, with a pickup of its own. */
  secondRoute: `018f7c35-${n}000-7000-8000-000000000018`,
  pickup: `018f7c35-${n}000-7000-8000-000000000019`,
  secondPickup: `018f7c35-${n}000-7000-8000-00000000001a`,
  unload: `018f7c35-${n}000-7000-8000-00000000001b`,
  ticket: `018f7c35-${n}000-7000-8000-00000000001c`,
  priceList: `018f7c35-${n}000-7000-8000-00000000001d`,
  priceListRow: `018f7c35-${n}000-7000-8000-00000000001e`,
  serviceArea: `018f7c35-${n}000-7000-8000-00000000001f`,
  areaPlanningArea: `018f7c35-${n}000-7000-8000-000000000020`,
  areaFraction: `018f7c35-${n}000-7000-8000-000000000021`,
  assignment: `018f7c35-${n}000-7000-8000-000000000022`,
  providerPrice: `018f7c35-${n}000-7000-8000-000000000023`,
  event: `018f7c35-${n}000-7000-8000-000000000024`,
  run: `018f7c35-${n}000-7000-8000-000000000025`,
  exclusion: `018f7c35-${n}000-7000-8000-000000000026`,
  invoice: `018f7c35-${n}000-7000-8000-000000000027`,
  line: `018f7c35-${n}000-7000-8000-000000000028`,
  settlement: `018f7c35-${n}000-7000-8000-000000000029`,
  settlementLine: `018f7c35-${n}000-7000-8000-00000000002a`,
  settlementEvent: `018f7c35-${n}000-7000-8000-00000000002b`,
  review: `018f7c35-${n}000-7000-8000-00000000002c`,
  /** An outbox event's id the consumer's event names: a soft uuid, nothing has to exist under it. */
  outbox: `018f7c35-${n}000-7000-8000-00000000002d`,
  /** Free for a test's own rows. */
  spare: `018f7c35-${n}000-7000-8000-0000000000e1`,
  other: `018f7c35-${n}000-7000-8000-0000000000e2`,
  third: `018f7c35-${n}000-7000-8000-0000000000e3`,
  fourth: `018f7c35-${n}000-7000-8000-0000000000e4`,
  /** A second project of the same company, with rows of its own that a record of the first may not name. */
  harbor: `018f7c35-${n}000-7000-8000-0000000000f1`,
  harborPriceList: `018f7c35-${n}000-7000-8000-0000000000f2`,
  harborProduct: `018f7c35-${n}000-7000-8000-0000000000f3`,
  harborArea: `018f7c35-${n}000-7000-8000-0000000000f4`,
  harborAgreement: `018f7c35-${n}000-7000-8000-0000000000f5`,
  harborScheme: `018f7c35-${n}000-7000-8000-0000000000f6`,
  harborGroup: `018f7c35-${n}000-7000-8000-0000000000f7`,
  harborRoute: `018f7c35-${n}000-7000-8000-0000000000f8`,
  harborContainer: `018f7c35-${n}000-7000-8000-0000000000f9`,
  harborProperty: `018f7c35-${n}000-7000-8000-0000000000fa`,
  harborPickup: `018f7c35-${n}000-7000-8000-0000000000fb`,
  harborTicket: `018f7c35-${n}000-7000-8000-0000000000fc`,
  harborServiceArea: `018f7c35-${n}000-7000-8000-0000000000fd`,
  harborAssignment: `018f7c35-${n}000-7000-8000-0000000000fe`,
  harborRun: `018f7c35-${n}000-7000-8000-0000000000d1`,
  harborInvoice: `018f7c35-${n}000-7000-8000-0000000000d2`,
  harborUnload: `018f7c35-${n}000-7000-8000-0000000000d3`,
})
const a = ids("a")
const b = ids("b")

const NORDHAVN: Point = { type: "Point", coordinates: [12.5951, 55.7089] }
const AMAGER: Point = { type: "Point", coordinates: [12.6193, 55.6602] }
const OPENED = "2026-01-01"
const DAY = "2026-10-05"
/** A morning shift and the instants around it. */
const at = (hour: number, minute = 0): Date => new Date(Date.UTC(2026, 9, 5, hour, minute))

const tables: Record<string, PgTable> = {
  priceList,
  priceListRow,
  serviceArea,
  serviceAreaPlanningArea,
  serviceAreaWasteFraction,
  serviceAreaAssignment,
  serviceProviderPrice,
  billableEvent,
  billingRun,
  billingRunExclusion,
  invoice,
  invoiceLine,
  settlement,
  settlementLine,
  settlementEvent,
  weightReview,
}
const LEDGERS = ["billing_run_exclusion", "invoice", "invoice_line", "settlement_event", "weight_review"]

/** A priced pickup: 123,45 kr at 25 %. */
const PRICE = { unitPriceMinor: 12_345, netMinor: 12_345, vatPercent: 25, vatMinor: 3_086, currency: "DKK" }

/** A company with what the other contexts lend it, and one row in each Finance table — a default list with its default row, an area with its two sets and NordRen's assignment priced for the product, a priced pickup event the consumer recorded, a completed run with one exclusion and one invoice with one line, a calculated settlement with its line and its history, an approved weight — inserted as the owner in dependency order. */
async function seed(tx: Tx, n: "a" | "b"): Promise<void> {
  const own = ids(n)
  const tenant = { companyId: own.company }
  const scoped = { ...tenant, projectId: own.project }
  await tx.insert(company).values({ id: own.company, ...tenant, name: `Company ${n}`, legalName: `Company ${n} A/S`, registrationNumber: `1000000${n}`, country: "DK", status: "active" })
  await tx.insert(project).values({ id: own.project, ...tenant, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active" })
  await tx.insert(role).values({ id: own.role, ...tenant, name: "Finance", scope: "Company", description: "Invoices", system: false })
  await tx.insert(userAccount).values({ id: own.account, ...tenant, email: `sofie@${n}.example`, fullName: "Sofie Nielsen", roleId: own.role })
  await tx.insert(wasteFraction).values({ id: own.wasteFraction, ...tenant, key: "residual", name: "Residual waste" })
  await tx.insert(containerType).values({ id: own.containerType, ...tenant, name: "240 L bin", volumeLitres: 240 })
  await tx.insert(container).values({ id: own.container, ...scoped, label: "BIN-82014", containerTypeId: own.containerType, ownership: "company" })
  await tx.insert(customer).values([
    { id: own.customer, ...tenant, kind: "organisation", name: "Parkvej Boligforening", registrationNumber: `3000000${n}`, email: `post@${n}.example`, status: "active" },
    { id: own.secondCustomer, ...tenant, kind: "person", name: "Karen Holt", status: "active" },
  ])
  await tx.insert(property).values({ id: own.property, ...scoped, name: "Parkvej 18", address: "Parkvej 18", kind: "residential", status: "active", location: NORDHAVN })
  await tx.insert(product).values({ id: own.product, ...scoped, name: "Residual 240 L", kind: "container-collection", status: "active", unit: "pickup", containerTypeId: own.containerType, wasteFractionId: own.wasteFraction, invoiceName: "Restaffald 240 L", invoiceCode: "1001", vatPercent: 25 })
  await tx.insert(planningArea).values({ id: own.planningArea, ...scoped, code: "OP-CEN-01", name: "Central", purpose: "route-planning" })
  await tx.insert(serviceProvider).values({ id: own.serviceProvider, ...tenant, legalName: "NordRen ApS", registrationNumber: `4000000${n}`, country: "DK", contactName: "Lars Mikkelsen", contactEmail: `lars@${n}.example` })
  await tx.insert(priceList).values({ id: own.priceList, ...scoped, validFrom: OPENED, code: "PL-CPH-2026", name: "Copenhagen tariff 2026", currency: "DKK", isDefault: true })
  await tx.insert(priceListRow).values({ id: own.priceListRow, ...scoped, validFrom: OPENED, priceListId: own.priceList, productId: own.product, unitPriceMinor: PRICE.unitPriceMinor })
  await tx.insert(agreement).values({ id: own.agreement, ...scoped, validFrom: OPENED, number: "AGR-2408", customerId: own.customer, payerCustomerId: own.customer, status: "active", billingCadence: "monthly", currency: "DKK" })
  await tx.insert(subscription).values({ id: own.subscription, ...scoped, validFrom: OPENED, agreementId: own.agreement, productId: own.product, propertyId: own.property })
  await tx.insert(vehicleType).values({ id: own.vehicleType, ...tenant, key: "rear-loader", name: "Rear loader" })
  await tx.insert(depot).values({ id: own.depot, ...scoped, code: "DEP-NORD", name: "Nordhavn", address: "Sundkrogsgade 1", location: NORDHAVN, ownership: "company", status: "active" })
  await tx.insert(unloadingStation).values({ id: own.station, ...tenant, code: "ARC", name: "ARC Amager", address: "Vindmøllevej 6", location: AMAGER, ownership: "external", status: "active", weighbridge: true })
  await tx.insert(vehicle).values({ id: own.vehicle, ...scoped, registration: `CN 42 01${n === "a" ? 8 : 9}`, callsign: "WH-24", kind: "powered-vehicle", vehicleTypeId: own.vehicleType, ownership: "company", status: "active", requiredLicenceClass: "c", homeDepotId: own.depot })
  await tx.insert(driver).values({ id: own.driver, ...scoped, name: "Mads Jensen", employment: "employee", licenceClass: "ce", status: "active", homeDepotId: own.depot })
  await tx.insert(routeScheme).values({ id: own.scheme, ...scoped, validFrom: OPENED, name: "Residual weekly", planningAreaId: own.planningArea, serviceType: "container-collection", frequency: "weekly", serviceDays: ["monday"], plannedStartTime: "06:30", depotId: own.depot })
  await tx.insert(collectionGroup).values({ id: own.group, ...scoped, routeSchemeId: own.scheme, name: "Rear loaders", position: 1, days: ["monday"], stopSource: "rule", ruleVehicleTypeId: own.vehicleType, vehicleId: own.vehicle, driverId: own.driver })
  await tx.insert(route).values([
    { id: own.route, ...scoped, routeSchemeId: own.scheme, collectionGroupId: own.group, serviceDate: DAY, operatingDate: DAY, status: "completed", number: n === "a" ? 1042 : 1043, plannedVehicleId: own.vehicle, plannedDriverId: own.driver, depotId: own.depot, actualVehicleId: own.vehicle, actualDriverId: own.driver, dispatchedAt: at(5), startedAt: at(6), completedAt: at(14) },
    { id: own.secondRoute, ...scoped, routeSchemeId: own.scheme, collectionGroupId: own.group, serviceDate: "2026-10-12", operatingDate: "2026-10-12", number: n === "a" ? 1044 : 1045, plannedDriverId: own.driver, plannedVehicleId: own.vehicle },
  ])
  await tx.insert(pickup).values([
    { id: own.pickup, ...scoped, routeId: own.route, containerId: own.container, position: 1, propertyId: own.property, wasteFractionId: own.wasteFraction, status: "completed", outcomeAt: at(6, 25) },
    { id: own.secondPickup, ...scoped, routeId: own.secondRoute, containerId: own.container, position: 1, propertyId: own.property, wasteFractionId: own.wasteFraction },
  ])
  await tx.insert(unload).values({ id: own.unload, ...scoped, routeId: own.route, unloadingStationId: own.station, wasteFractionId: own.wasteFraction, source: "dispatch", occurredAt: at(11), recordedBy: own.account, netKg: 4_200 })
  await tx.insert(ticket).values({ id: own.ticket, ...scoped, number: n === "a" ? 8831 : 8832, kind: "missed-collection", source: "phone", subject: "Missed collection at Parkvej 18", description: "The bin was not emptied", occurredAt: at(8), createdBy: own.account, agreementId: own.agreement, status: "completed", resolution: "recollected", closedAt: at(15) })
  await tx.insert(serviceArea).values({ id: own.serviceArea, ...scoped, validFrom: OPENED, code: "CA-Ø-2", name: "Østerbro", boundaryText: "Østerbro as the 2026 contract draws it" })
  await tx.insert(serviceAreaPlanningArea).values({ id: own.areaPlanningArea, ...scoped, serviceAreaId: own.serviceArea, planningAreaId: own.planningArea })
  await tx.insert(serviceAreaWasteFraction).values({ id: own.areaFraction, ...scoped, serviceAreaId: own.serviceArea, wasteFractionId: own.wasteFraction })
  await tx.insert(serviceAreaAssignment).values({ id: own.assignment, ...scoped, validFrom: OPENED, serviceAreaId: own.serviceArea, serviceProviderId: own.serviceProvider })
  await tx.insert(serviceProviderPrice).values({ id: own.providerPrice, ...scoped, validFrom: OPENED, serviceAreaAssignmentId: own.assignment, productId: own.product, bidMinor: 8_000, unitPriceMinor: 8_000, currency: "DKK" })
  // The consumer's event: no person, the outbox event's id, priced by the seeded row.
  await tx.insert(billableEvent).values({ id: own.event, ...scoped, kind: "pickup", serviceDate: DAY, agreementId: own.agreement, subscriptionId: own.subscription, productId: own.product, quantity: 1, ...PRICE, priceListRowId: own.priceListRow, routeId: own.route, pickupId: own.pickup, sourceEventId: own.outbox })
  await tx.insert(billingRun).values({ id: own.run, ...scoped, periodFrom: "2026-10-01", periodTo: "2026-10-31", status: "completed", requestedBy: own.account, completedAt: at(16), eventCount: 1, invoiceCount: 1, excludedCustomerCount: 1, netMinor: PRICE.netMinor, vatMinor: PRICE.vatMinor })
  await tx.insert(billingRunExclusion).values({ id: own.exclusion, ...scoped, billingRunId: own.run, customerId: own.secondCustomer, reason: "all-events-blocked", eventCount: 1 })
  await tx.insert(invoice).values({ id: own.invoice, ...scoped, number: n === "a" ? 1000 : 1001, kind: "invoice", customerId: own.customer, currency: "DKK", issuedOn: "2026-11-01", dueOn: "2026-12-01", periodFrom: "2026-10-01", periodTo: "2026-10-31", billingRunId: own.run, netMinor: PRICE.netMinor, vatMinor: PRICE.vatMinor, grossMinor: PRICE.netMinor + PRICE.vatMinor, issuedBy: own.account })
  await tx.insert(invoiceLine).values({ id: own.line, ...scoped, invoiceId: own.invoice, position: 1, billableEventId: own.event, description: `Restaffald 240 L · ${DAY}`, productId: own.product, serviceDate: DAY, quantity: 1, unitPriceMinor: PRICE.unitPriceMinor, netMinor: PRICE.netMinor, vatPercent: PRICE.vatPercent, vatMinor: PRICE.vatMinor })
  await tx.insert(settlement).values({ id: own.settlement, ...scoped, validFrom: "2026-10-01", validTo: "2026-11-01", serviceAreaAssignmentId: own.assignment, status: "calculated", currency: "DKK", calculatedAt: at(17), lineCount: 1, netMinor: 8_000 })
  await tx.insert(settlementLine).values({ id: own.settlementLine, ...scoped, settlementId: own.settlement, billableEventId: own.event, serviceProviderPriceId: own.providerPrice, quantity: 1, unitPriceMinor: 8_000, netMinor: 8_000 })
  await tx.insert(settlementEvent).values({ id: own.settlementEvent, ...scoped, settlementId: own.settlement, kind: "calculated", status: "calculated", lineCount: 1, netMinor: 8_000, recordedBy: own.account })
  await tx.insert(weightReview).values({ id: own.review, ...scoped, unloadId: own.unload, decision: "approved", reviewedBy: own.account })
}

/** A second project of company a, with a list, a product, a planning area, an agreement, a route with a pickup, a ticket, an area with an assignment, a run with an invoice and an unload of its own. */
async function seedHarbor(tx: Tx): Promise<void> {
  const scoped = { companyId: a.company, projectId: a.harbor }
  await tx.insert(project).values({ id: a.harbor, companyId: a.company, name: "Harbor", kind: "Contract", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active" })
  await tx.insert(priceList).values({ id: a.harborPriceList, ...scoped, validFrom: OPENED, code: "PL-HAV-2026", name: "Harbor tariff", currency: "DKK", isDefault: true })
  await tx.insert(product).values({ id: a.harborProduct, ...scoped, name: "Harbor residual", kind: "container-collection", status: "active", unit: "pickup", vatPercent: 25, invoiceCode: "1001" })
  await tx.insert(planningArea).values({ id: a.harborArea, ...scoped, code: "OP-HAV-01", name: "Harbor", purpose: "route-planning" })
  await tx.insert(agreement).values({ id: a.harborAgreement, ...scoped, validFrom: OPENED, number: "AGR-3000", customerId: a.customer, payerCustomerId: a.customer, status: "active", billingCadence: "monthly", currency: "DKK" })
  await tx.insert(routeScheme).values({ id: a.harborScheme, ...scoped, validFrom: OPENED, name: "Harbor weekly", serviceType: "container-collection", frequency: "weekly", serviceDays: ["tuesday"] })
  await tx.insert(collectionGroup).values({ id: a.harborGroup, ...scoped, routeSchemeId: a.harborScheme, name: "Harbor", position: 1, days: ["tuesday"], stopSource: "rule" })
  await tx.insert(route).values({ id: a.harborRoute, ...scoped, routeSchemeId: a.harborScheme, collectionGroupId: a.harborGroup, serviceDate: "2026-10-06", operatingDate: "2026-10-06", number: 1050 })
  await tx.insert(property).values({ id: a.harborProperty, ...scoped, name: "Havnegade 2", address: "Havnegade 2", kind: "commercial", status: "active" })
  await tx.insert(container).values({ id: a.harborContainer, ...scoped, label: "BIN-90001", containerTypeId: a.containerType, ownership: "company" })
  await tx.insert(pickup).values({ id: a.harborPickup, ...scoped, routeId: a.harborRoute, containerId: a.harborContainer, position: 1, propertyId: a.harborProperty, wasteFractionId: a.wasteFraction })
  await tx.insert(ticket).values({ id: a.harborTicket, ...scoped, number: 9000, kind: "internal-task", source: "office", subject: "Check the harbor gate", description: "The gate code changed", occurredAt: at(9), createdBy: a.account })
  await tx.insert(serviceArea).values({ id: a.harborServiceArea, ...scoped, validFrom: OPENED, code: "CA-H-1", name: "Havnen", boundaryText: "The harbour" })
  await tx.insert(serviceAreaAssignment).values({ id: a.harborAssignment, ...scoped, validFrom: OPENED, serviceAreaId: a.harborServiceArea, serviceProviderId: a.serviceProvider })
  await tx.insert(billingRun).values({ id: a.harborRun, ...scoped, periodFrom: "2026-10-01", periodTo: "2026-10-31", status: "completed", completedAt: at(16) })
  await tx.insert(invoice).values({ id: a.harborInvoice, ...scoped, number: 1500, kind: "invoice", customerId: a.customer, currency: "DKK", issuedOn: "2026-11-01", dueOn: "2026-12-01", periodFrom: "2026-10-01", periodTo: "2026-10-31", billingRunId: a.harborRun, netMinor: 0, vatMinor: 0, grossMinor: 0 })
  await tx.insert(unload).values({ id: a.harborUnload, ...scoped, routeId: a.harborRoute, unloadingStationId: a.station, wasteFractionId: a.wasteFraction, source: "dispatch", occurredAt: at(12), recordedBy: a.account, netKg: 1_000 })
}

/** A sound priced manual event of company a's first project by Sofie, but for what a test overrides. */
const manual = (values: Partial<typeof billableEvent.$inferInsert>): typeof billableEvent.$inferInsert => ({
  id: a.spare,
  companyId: a.company,
  projectId: a.project,
  kind: "manual",
  serviceDate: DAY,
  agreementId: a.agreement,
  productId: a.product,
  quantity: 1,
  ...PRICE,
  priceListRowId: a.priceListRow,
  createdBy: a.account,
  ...values,
})

/** A sound row of the seeded list for the seeded product, in the harbour zone from July, but for what a test overrides. */
const row = (values: Partial<typeof priceListRow.$inferInsert>): typeof priceListRow.$inferInsert => ({
  id: a.spare,
  companyId: a.company,
  projectId: a.project,
  validFrom: "2026-07-01",
  priceListId: a.priceList,
  productId: a.product,
  unitPriceMinor: 15_000,
  planningAreaId: a.planningArea,
  ...values,
})

/** A sound credit note against company a's invoice, but for what a test overrides. */
const creditNote = (values: Partial<typeof invoice.$inferInsert>): typeof invoice.$inferInsert => ({
  id: a.spare,
  companyId: a.company,
  projectId: a.project,
  number: 1100,
  kind: "credit-note",
  customerId: a.customer,
  currency: "DKK",
  issuedOn: "2026-11-15",
  dueOn: "2026-11-15",
  creditsInvoiceId: a.invoice,
  creditReason: "service-not-delivered",
  netMinor: -PRICE.netMinor,
  vatMinor: -PRICE.vatMinor,
  grossMinor: -(PRICE.netMinor + PRICE.vatMinor),
  issuedBy: a.account,
  ...values,
})

/** A sound credit line on that credit note, crediting the seeded line whole, but for what a test overrides. */
const creditLine = (values: Partial<typeof invoiceLine.$inferInsert>): typeof invoiceLine.$inferInsert => ({
  id: a.other,
  companyId: a.company,
  projectId: a.project,
  invoiceId: a.spare,
  position: 1,
  creditsLineId: a.line,
  description: `Restaffald 240 L · ${DAY}`,
  productId: a.product,
  serviceDate: DAY,
  quantity: 1,
  unitPriceMinor: PRICE.unitPriceMinor,
  netMinor: -PRICE.netMinor,
  vatPercent: PRICE.vatPercent,
  vatMinor: -PRICE.vatMinor,
  ...values,
})

/** A sound open settlement of the seeded assignment for November, but for what a test overrides. */
const opened = (values: Partial<typeof settlement.$inferInsert>): typeof settlement.$inferInsert => ({
  id: a.spare,
  companyId: a.company,
  projectId: a.project,
  validFrom: "2026-11-01",
  validTo: "2026-12-01",
  serviceAreaAssignmentId: a.assignment,
  currency: "DKK",
  ...values,
})

/** A sound review of company a's unload, but for what a test overrides. */
const reviewed = (values: Partial<typeof weightReview.$inferInsert>): typeof weightReview.$inferInsert => ({
  id: a.spare,
  companyId: a.company,
  projectId: a.project,
  unloadId: a.unload,
  decision: "approved",
  reviewedBy: a.account,
  ...values,
})

/** A sound provider price of the seeded assignment for a second product, but for what a test overrides. */
const priced = (values: Partial<typeof serviceProviderPrice.$inferInsert>): typeof serviceProviderPrice.$inferInsert => ({
  id: a.spare,
  companyId: a.company,
  projectId: a.project,
  validFrom: "2027-01-01",
  serviceAreaAssignmentId: a.assignment,
  productId: a.product,
  bidMinor: 8_000,
  unitPriceMinor: 8_400,
  currency: "DKK",
  ...values,
})

/** Odd amounts of both signs at three rates, with what the domain says the VAT is; the checks must agree row by row. */
const VAT_CASES: readonly [netMinor: number, vatPercent: number][] = [
  [1, 25],
  [2, 25],
  [3, 25],
  [6, 25],
  [10, 25],
  [14, 25],
  [-2, 25],
  [-6, 25],
  [-10, 25],
  [-14, 25],
  [12_345, 25],
  [-12_345, 25],
  [999, 7],
  [-999, 7],
  [1_000, 0],
  [1_000, 100],
]

describe("the Finance & Contracting tables against a fresh database", { skip: database.skip }, () => {
  let fresh: FreshDatabase
  let owner: Database

  before(async () => {
    fresh = await freshDatabase(database.adminUrl, "waste_finance")
    await migrateDatabase(fresh.url)
    owner = createDb(fresh.url, { max: 3 })
  })
  after(async () => {
    await owner?.close()
    await fresh?.drop()
  })

  /** The two companies seeded as the owner in a transaction that is rolled back. */
  const seeded = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    rolledBack(owner.db, async (tx) => {
      await seed(tx, "a")
      await seed(tx, "b")
      return fn(tx)
    })

  test("0010 created the sixteen tables in wms, each fenced, eleven with the updated_at trigger and the five ledgers with none, gave company its third counter at 1000, the product and the agreement their columns, the unload its key, and grew the outbox's checks", async () => {
    const names = Object.values(tables).map(getTableName).sort()
    assert.equal(names.length, 16)
    const rows = await owner.sql<{ table: string; enabled: boolean; forced: boolean; policies: string[]; triggers: string[] | null }[]>`
      select c.relname as table, c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
        (select array_agg(p.policyname order by p.policyname) from pg_policies p where p.schemaname = 'wms' and p.tablename = c.relname) as policies,
        (select array_agg(t.tgname order by t.tgname) from pg_trigger t where t.tgrelid = c.oid and not t.tgisinternal) as triggers
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'wms' and c.relkind = 'r' and c.relname = any (${names}::text[])
      order by c.relname`
    assert.deepEqual(
      rows.map(({ table, enabled, forced, policies, triggers }) => ({ table, enabled, forced, policies, triggers })),
      names.map((table) => ({ table, enabled: true, forced: true, policies: [`${table}_tenant_fence`], triggers: LEDGERS.includes(table) ? null : [`${table}_touch_updated_at`] })),
    )
    const counters = await owner.sql<{ column: string; default: string; nullable: string }[]>`select column_name as column, column_default as default, is_nullable as nullable from information_schema.columns where table_schema = 'wms' and table_name = 'company' and column_name like 'next_%' order by column_name`
    assert.deepEqual(
      [...counters],
      [
        { column: "next_invoice_number", default: "1000", nullable: "NO" },
        { column: "next_route_number", default: "1000", nullable: "NO" },
        { column: "next_ticket_number", default: "1000", nullable: "NO" },
      ],
    )
    const columns = await owner.sql<{ table: string; column: string; type: string }[]>`
      select table_name as table, column_name as column, data_type as type from information_schema.columns
      where table_schema = 'wms' and ((table_name = 'product' and column_name in ('invoice_name', 'invoice_code', 'vat_percent')) or (table_name = 'agreement' and column_name = 'price_list_id'))
      order by table_name, column_name`
    assert.deepEqual(
      [...columns],
      [
        { table: "agreement", column: "price_list_id", type: "uuid" },
        { table: "product", column: "invoice_code", type: "text" },
        { table: "product", column: "invoice_name", type: "text" },
        { table: "product", column: "vat_percent", type: "integer" },
      ],
    )
    const [keys] = await owner.sql<{ unloadKey: string; kinds: string; aggregates: string; exclusions: number }[]>`
      select (select pg_get_constraintdef(oid) from pg_constraint where conname = 'unload_project_key') as "unloadKey",
             (select pg_get_constraintdef(oid) from pg_constraint where conname = 'outbox_event_kind_one_of') as kinds,
             (select pg_get_constraintdef(oid) from pg_constraint where conname = 'outbox_event_aggregate_kind_one_of') as aggregates,
             (select count(*)::int from pg_constraint where contype = 'x' and conname like any (array['price_list%', 'service_area%', 'service_provider_price%', 'settlement%'])) as exclusions`
    assert.equal(keys.unloadKey, "UNIQUE (company_id, project_id, id)")
    assert.match(keys.kinds, /'invoice-issued'.*'settlement-closed'/)
    assert.match(keys.aggregates, /'invoice'.*'settlement'/)
    assert.equal(keys.exclusions, 6, "the six exclusion constraints")
  })

  test("and left the API role able to insert into the five ledgers and to update or delete nothing there, while the owner keeps every right", async () => {
    const rows = await owner.sql<{ relation: string; rolename: string; privilege: string; granted: boolean }[]>`
      select t.relation, r.rolename, p.privilege, has_table_privilege(r.rolename::name, ('wms.' || t.relation)::regclass, p.privilege) as granted
      from (values ('billing_run_exclusion'), ('invoice'), ('invoice_line'), ('settlement_event'), ('weight_review'), ('billable_event'), ('settlement')) as t(relation),
           (values (${API_ROLE}::text), (current_user::text)) as r(rolename),
           (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as p(privilege)
      order by t.relation, r.rolename, p.privilege`
    assert.equal(rows.length, 56)
    const denied = rows.filter((row) => !row.granted).map((row) => `${row.rolename} ${row.privilege} ${row.relation}`)
    assert.deepEqual(denied.sort(), LEDGERS.flatMap((ledger) => [`${API_ROLE} DELETE ${ledger}`, `${API_ROLE} UPDATE ${ledger}`]).sort())
  })

  /** Row counts per table as the transaction currently sees them. */
  const counts = async (tx: Tx): Promise<Record<string, number>> => {
    const seen: Record<string, number> = {}
    for (const [name, table] of Object.entries(tables)) {
      const [{ count }] = await tx.execute<{ count: number }>(sql`select count(*)::int as count from ${table}`)
      seen[name] = count
    }
    return seen
  }
  /** What one company seeded: one row in each table. */
  const ownRows = Object.fromEntries(Object.keys(tables).map((name) => [name, 1]))

  /** Both companies seeded as the owner inside `withCompany`, then the transaction becomes the API role. */
  const asCompany = <T>(companyId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    rolledBackIn(
      (body) => withCompany(owner.db, companyId, body),
      async (tx) => {
        await seed(tx, "a")
        await seed(tx, "b")
        // Role settings apply at login, not at SET ROLE: the API role's search path is set by hand.
        await tx.execute(sql`set local role ${sql.raw(API_ROLE)}`)
        await tx.execute(sql`set local search_path = wms, extensions`)
        return fn(tx)
      },
    )

  test("under withCompany as the API role, each of the sixteen tables shows the company's rows and nothing of another company's", async () => {
    const seenByA = await asCompany(a.company, async (tx) => ({
      counts: await counts(tx),
      invoices: (await tx.select({ id: invoice.id, number: invoice.number }).from(invoice)).map((row) => [row.id, row.number]),
      events: (await tx.select({ id: billableEvent.id }).from(billableEvent)).map((row) => row.id),
    }))
    assert.deepEqual(seenByA, { counts: ownRows, invoices: [[a.invoice, 1000]], events: [a.event] })
    const seenByB = await asCompany(b.company, async (tx) => ({
      counts: await counts(tx),
      invoices: (await tx.select({ id: invoice.id, number: invoice.number }).from(invoice)).map((row) => [row.id, row.number]),
    }))
    assert.deepEqual(seenByB, { counts: ownRows, invoices: [[b.invoice, 1001]] })
  })

  test("as the API role, a ledger row can be appended and neither updated nor deleted (42501); the owner may do both; an event and a settlement are updated", () =>
    asCompany(a.company, async (tx) => {
      await tx.insert(weightReview).values(reviewed({ decision: "rejected", note: "The ticket photo is unreadable" }))
      await tx.insert(invoice).values(creditNote({ id: a.other, number: 1100 }))
      await tx.insert(invoiceLine).values(creditLine({ id: a.third, invoiceId: a.other }))
      await tx.insert(settlementEvent).values({ id: a.fourth, companyId: a.company, projectId: a.project, settlementId: a.settlement, kind: "calculated", status: "calculated", lineCount: 1, netMinor: 8_000, recordedBy: a.account })
      await assert.rejects(tx.transaction((savepoint) => savepoint.update(weightReview).set({ note: "rewritten" }).where(eq(weightReview.id, a.spare))), refusedWith("42501", /permission denied for table weight_review/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.update(invoice).set({ creditNote: "rewritten" }).where(eq(invoice.id, a.other))), refusedWith("42501", /permission denied for table invoice/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.update(invoiceLine).set({ description: "rewritten" }).where(eq(invoiceLine.id, a.third))), refusedWith("42501", /permission denied for table invoice_line/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.update(settlementEvent).set({ reason: "rewritten" }).where(eq(settlementEvent.id, a.fourth))), refusedWith("42501", /permission denied for table settlement_event/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.update(billingRunExclusion).set({ eventCount: 2 }).where(eq(billingRunExclusion.id, a.exclusion))), refusedWith("42501", /permission denied for table billing_run_exclusion/))
      for (const [table, id, name] of [
        [weightReview, a.spare, "weight_review"],
        [invoiceLine, a.third, "invoice_line"],
        [invoice, a.other, "invoice"],
        [settlementEvent, a.fourth, "settlement_event"],
        [billingRunExclusion, a.exclusion, "billing_run_exclusion"],
      ] as const) {
        await assert.rejects(tx.transaction((savepoint) => savepoint.delete(table).where(eq(table.id, id))), refusedWith("42501", new RegExp(`permission denied for table ${name}`)))
      }
      // The event and the settlement are current state: the API role updates them, and the trigger moves updated_at.
      const [cancelled] = await tx.update(billableEvent).set({ cancelledAt: at(18), cancelledBy: a.account, cancelReason: "duplicate" }).where(eq(billableEvent.id, a.event)).returning({ reason: billableEvent.cancelReason })
      assert.equal(cancelled.reason, "duplicate")
      const [reopened] = await tx.update(settlement).set({ status: "open", calculatedAt: null }).where(eq(settlement.id, a.settlement)).returning({ status: settlement.status })
      assert.equal(reopened.status, "open")
      // The owner keeps both rights, for tests and for erasure.
      await tx.execute(sql`reset role`)
      assert.equal((await tx.update(weightReview).set({ note: "rewritten" }).where(eq(weightReview.id, a.spare)).returning()).length, 1)
      assert.equal((await tx.delete(invoiceLine).where(eq(invoiceLine.id, a.third)).returning()).length, 1)
      assert.equal((await tx.delete(invoice).where(eq(invoice.id, a.other)).returning()).length, 1)
    }))

  test("a Finance row cannot name another company's customer, container type, waste fraction, provider or account (23503): every key carries the tenant", () =>
    seeded(async (tx) => {
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(priceListRow).values(row({ customerId: b.customer }))), refusedWith("23503", /price_list_row_customer_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(priceListRow).values(row({ containerTypeId: b.containerType }))), refusedWith("23503", /price_list_row_container_type_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(priceListRow).values(row({ wasteFractionId: b.wasteFraction }))), refusedWith("23503", /price_list_row_waste_fraction_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(serviceAreaWasteFraction).values({ id: a.spare, companyId: a.company, projectId: a.project, serviceAreaId: a.serviceArea, wasteFractionId: b.wasteFraction })), refusedWith("23503", /service_area_waste_fraction_waste_fraction_id_fk/))
      // The seeded assignment ends where this one would begin, so the key and not the exclusion constraint is what refuses it.
      await tx.update(serviceAreaAssignment).set({ validTo: "2027-01-01" }).where(eq(serviceAreaAssignment.id, a.assignment))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(serviceAreaAssignment).values({ id: a.spare, companyId: a.company, projectId: a.project, validFrom: "2027-01-01", serviceAreaId: a.serviceArea, serviceProviderId: b.serviceProvider })), refusedWith("23503", /service_area_assignment_service_provider_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(billableEvent).values(manual({ createdBy: b.account }))), refusedWith("23503", /billable_event_created_by_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(billingRunExclusion).values({ id: a.spare, companyId: a.company, projectId: a.project, billingRunId: a.run, customerId: b.customer, reason: "all-events-blocked", eventCount: 1 })), refusedWith("23503", /billing_run_exclusion_customer_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(invoice).values(creditNote({ customerId: b.customer }))), refusedWith("23503", /invoice_customer_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(weightReview).values(reviewed({ reviewedBy: b.account }))), refusedWith("23503", /weight_review_reviewed_by_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(settlementEvent).values({ id: a.spare, companyId: a.company, projectId: a.project, settlementId: a.settlement, kind: "closed", status: "closed", lineCount: 1, netMinor: 8_000, recordedBy: b.account })), refusedWith("23503", /settlement_event_recorded_by_fk/))
      // The same rows land when every id they name is their own company's.
      await tx.insert(priceListRow).values(row({ customerId: a.customer, containerTypeId: a.containerType, wasteFractionId: a.wasteFraction }))
      await tx.insert(billableEvent).values(manual({ id: a.other }))
    }))

  test("nor another project's list, product, planning area, agreement, route, pickup, ticket, assignment, invoice or unload of its own company (23503): every project-scoped key carries the project", () =>
    seeded(async (tx) => {
      await seedHarbor(tx)
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(priceListRow).values(row({ priceListId: a.harborPriceList }))), refusedWith("23503", /price_list_row_price_list_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(priceListRow).values(row({ productId: a.harborProduct }))), refusedWith("23503", /price_list_row_product_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(priceListRow).values(row({ planningAreaId: a.harborArea }))), refusedWith("23503", /price_list_row_planning_area_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(serviceAreaPlanningArea).values({ id: a.spare, companyId: a.company, projectId: a.project, serviceAreaId: a.serviceArea, planningAreaId: a.harborArea })), refusedWith("23503", /service_area_planning_area_planning_area_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(billableEvent).values(manual({ agreementId: a.harborAgreement }))), refusedWith("23503", /billable_event_agreement_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(billableEvent).values(manual({ kind: "pickup", createdBy: null, sourceEventId: a.spare, routeId: a.harborRoute, pickupId: a.harborPickup }))), refusedWith("23503", /billable_event_route_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(billableEvent).values(manual({ kind: "ticket", ticketId: a.harborTicket, priceListRowId: null, blockReason: "no-product", productId: null, unitPriceMinor: null, netMinor: null, vatPercent: null, vatMinor: null, currency: null }))), refusedWith("23503", /billable_event_ticket_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(serviceProviderPrice).values(priced({ serviceAreaAssignmentId: a.harborAssignment }))), refusedWith("23503", /service_provider_price_service_area_assignment_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(settlement).values(opened({ serviceAreaAssignmentId: a.harborAssignment }))), refusedWith("23503", /settlement_service_area_assignment_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(invoiceLine).values(creditLine({ invoiceId: a.harborInvoice }))), refusedWith("23503", /invoice_line_invoice_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(invoice).values(creditNote({ creditsInvoiceId: a.harborInvoice }))), refusedWith("23503", /invoice_credits_invoice_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(weightReview).values(reviewed({ unloadId: a.harborUnload }))), refusedWith("23503", /weight_review_unload_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(weightReview).values(reviewed({ decision: "corrected", correctionUnloadId: a.harborUnload }))), refusedWith("23503", /weight_review_correction_unload_id_fk/))
      // The agreement's own key into Finance carries the project too.
      await assert.rejects(tx.transaction((savepoint) => savepoint.update(agreement).set({ priceListId: a.harborPriceList }).where(eq(agreement.id, a.agreement))), refusedWith("23503", /agreement_price_list_id_fk/))
      await tx.update(agreement).set({ priceListId: a.priceList }).where(eq(agreement.id, a.agreement))
      // The same rows land when every id they name is their own project's.
      await tx.insert(billableEvent).values(manual({ kind: "ticket", ticketId: a.ticket, priceListRowId: null, blockReason: "no-product", productId: null, unitPriceMinor: null, netMinor: null, vatPercent: null, vatMinor: null, currency: null }))
    }))

  test("an event names a pickup of the route it names and no other route's (23503): the key carries the route, and a pickup without a route is refused before the key can be asked (23514)", () =>
    seeded(async (tx) => {
      const consumers = (values: Partial<typeof billableEvent.$inferInsert>) => manual({ kind: "pickup", createdBy: null, sourceEventId: a.spare, routeId: a.route, pickupId: a.pickup, ...values })
      // The second pickup is the planned route's; the event names the completed one.
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(billableEvent).values(consumers({ pickupId: a.secondPickup }))), refusedWith("23503", /billable_event_route_id_pickup_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(billableEvent).values(consumers({ routeId: null }))), refusedWith("23514", /billable_event_pickup_shape/), "Postgres leaves a composite key with a null member unchecked, so the shape check says a pickup names its route")
      await tx.insert(billableEvent).values(consumers({ routeId: a.secondRoute, pickupId: a.secondPickup }))
    }))

  test("one list of a code and one area of a code in force at a time (23P01 price_list_no_overlap, service_area_no_overlap); a new one may start the day the old ends, and the code is the project's", () =>
    seeded(async (tx) => {
      const list = (values: Partial<typeof priceList.$inferInsert>) => ({ id: a.spare, companyId: a.company, projectId: a.project, validFrom: "2027-01-01", code: "PL-CPH-2026", name: "Copenhagen tariff 2027", currency: "DKK", ...values })
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(priceList).values(list({}))), refusedWith("23P01", /price_list_no_overlap/))
      await tx.update(priceList).set({ validTo: "2027-01-01" }).where(eq(priceList.id, a.priceList))
      await tx.insert(priceList).values(list({}))
      // Another code beside it, and the same code in another project.
      await tx.insert(priceList).values(list({ id: a.other, code: "PL-CPH-COMMERCIAL", validFrom: OPENED }))
      await seedHarbor(tx)
      await tx.insert(priceList).values(list({ id: a.third, projectId: a.harbor, validFrom: OPENED }))
      const area = (values: Partial<typeof serviceArea.$inferInsert>) => ({ id: a.fourth, companyId: a.company, projectId: a.project, validFrom: "2027-01-01", code: "CA-Ø-2", name: "Østerbro, re-let", boundaryText: "Østerbro as the 2027 contract draws it", ...values })
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(serviceArea).values(area({}))), refusedWith("23P01", /service_area_no_overlap/))
      await tx.update(serviceArea).set({ validTo: "2027-01-01" }).where(eq(serviceArea.id, a.serviceArea))
      await tx.insert(serviceArea).values(area({}))
    }))

  test("one row of a list, a product and a condition set in force at a time (23P01 price_list_row_no_overlap): the generated key tells two condition sets apart, and a scheduled change is the next row", () =>
    seeded(async (tx) => {
      // The default row runs from the start of 2026; a second default row for the product overlaps it.
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(priceListRow).values(row({ planningAreaId: null }))), refusedWith("23P01", /price_list_row_no_overlap/))
      // A zone row of the same product is another condition set and coexists; a second zone row of the same zone does not.
      await tx.insert(priceListRow).values(row({}))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(priceListRow).values(row({ id: a.other, validFrom: "2026-09-01" }))), refusedWith("23P01", /price_list_row_no_overlap/))
      // A zone row for a customer kind is a third set.
      await tx.insert(priceListRow).values(row({ id: a.other, customerKind: "person" }))
      // The scheduled change: the default row ends and the next begins the same day.
      await tx.update(priceListRow).set({ validTo: "2027-01-01" }).where(eq(priceListRow.id, a.priceListRow))
      await tx.insert(priceListRow).values(row({ id: a.third, planningAreaId: null, validFrom: "2027-01-01", unitPriceMinor: 12_900 }))
      // The key reads as the five conditions coalesced and joined, so a person can see what an exclusion refused.
      const keys = await tx.select({ id: priceListRow.id, key: priceListRow.conditionKey }).from(priceListRow).where(and(eq(priceListRow.companyId, a.company), eq(priceListRow.projectId, a.project))).orderBy(priceListRow.id)
      assert.deepEqual(
        keys.map((k) => [k.id, k.key]),
        [
          [a.priceListRow, "////"],
          [a.spare, `${a.planningArea}////`],
          [a.other, `${a.planningArea}/person///`],
          [a.third, "////"],
        ],
      )
      // The database owns the key: a value written for it is refused (428C9, a generated column).
      await assert.rejects(tx.transaction((savepoint) => savepoint.execute(sql`update ${priceListRow} set condition_key = 'x' where id = ${a.spare}`)), refusedWith("428C9", /can only be updated to DEFAULT/))
    }))

  test("one provider holds an area at a time, one price of an assignment and a product, and one settlement of an assignment over a period (23P01), each free once the earlier has ended", () =>
    seeded(async (tx) => {
      const assignment = (values: Partial<typeof serviceAreaAssignment.$inferInsert>) => ({ id: a.spare, companyId: a.company, projectId: a.project, validFrom: "2026-07-01", serviceAreaId: a.serviceArea, serviceProviderId: a.serviceProvider, ...values })
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(serviceAreaAssignment).values(assignment({}))), refusedWith("23P01", /service_area_assignment_no_overlap/))
      // A transfer: the old assignment ends on the day, the new one starts on it.
      await tx.update(serviceAreaAssignment).set({ validTo: "2026-07-01" }).where(eq(serviceAreaAssignment.id, a.assignment))
      await tx.insert(serviceAreaAssignment).values(assignment({}))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(serviceProviderPrice).values(priced({ validFrom: "2026-03-01" }))), refusedWith("23P01", /service_provider_price_no_overlap/))
      // An indexation: the row ends on the day the indexed one begins, the chain through indexed_from_id.
      await tx.update(serviceProviderPrice).set({ validTo: "2026-03-01" }).where(eq(serviceProviderPrice.id, a.providerPrice))
      await tx.insert(serviceProviderPrice).values(priced({ id: a.other, validFrom: "2026-03-01", indexedFromId: a.providerPrice, indexLabel: "CPI", indexBasisPoints: 500, indexBase: "current-fee" }))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(settlement).values(opened({ validFrom: "2026-10-15", validTo: "2026-11-15" }))), refusedWith("23P01", /settlement_no_overlap/))
      await tx.insert(settlement).values(opened({ id: a.third }))
      // Another assignment's settlement over the same month is another settlement.
      await tx.insert(settlement).values(opened({ id: a.fourth, validFrom: "2026-10-01", validTo: "2026-11-01", serviceAreaAssignmentId: a.spare }))
    }))

  test("one default list per project (23505 price_list_default_idx), one line per event (invoice_line_billable_event_id_idx), one event per outbox event (billable_event_source_event_id_idx) and one invoice code per project (product_invoice_code_idx), a null passing each", () =>
    seeded(async (tx) => {
      const list = (values: Partial<typeof priceList.$inferInsert>) => ({ id: a.spare, companyId: a.company, projectId: a.project, validFrom: "2027-01-01", code: "PL-CPH-2027", name: "Copenhagen tariff 2027", currency: "DKK", ...values })
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(priceList).values(list({ isDefault: true }))), refusedWith("23505", /price_list_default_idx/), "a second default, whatever its period")
      await tx.insert(priceList).values(list({}))
      await tx.update(priceList).set({ isDefault: false }).where(eq(priceList.id, a.priceList))
      await tx.update(priceList).set({ isDefault: true }).where(eq(priceList.id, a.spare))
      // The seeded event is on the seeded line; a second line naming it, on any invoice, is refused.
      await tx.insert(invoice).values(creditNote({ id: a.other, kind: "invoice", number: 1200, creditsInvoiceId: null, creditReason: null, periodFrom: "2026-10-01", periodTo: "2026-10-31", billingRunId: a.run, netMinor: PRICE.netMinor, vatMinor: PRICE.vatMinor, grossMinor: PRICE.netMinor + PRICE.vatMinor, dueOn: "2026-12-15" }))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(invoiceLine).values(creditLine({ id: a.third, invoiceId: a.other, creditsLineId: null, billableEventId: a.event, netMinor: PRICE.netMinor, vatMinor: PRICE.vatMinor }))), refusedWith("23505", /invoice_line_billable_event_id_idx/))
      // The consumer's key: the same outbox event twice is one row; a person's events carry no key and do not collide.
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(billableEvent).values(manual({ kind: "pickup", routeId: a.route, pickupId: a.pickup, createdBy: null, sourceEventId: a.outbox }))), refusedWith("23505", /billable_event_source_event_id_idx/))
      await tx.insert(billableEvent).values([manual({ id: a.third }), manual({ id: a.fourth })])
      // The same outbox event in another company is another company's row.
      await tx.insert(billableEvent).values(manual({ id: `018f7c35-a000-7000-8000-0000000000e5`, companyId: b.company, projectId: b.project, kind: "pickup", agreementId: b.agreement, subscriptionId: b.subscription, productId: b.product, priceListRowId: b.priceListRow, routeId: b.route, pickupId: b.pickup, createdBy: null, sourceEventId: a.outbox }))
      assert.equal((await tx.select({ id: billableEvent.id }).from(billableEvent).where(eq(billableEvent.sourceEventId, a.outbox))).length, 2, "company a's and company b's")
      // An invoice code once per project, and the same code in another project.
      await seedHarbor(tx)
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(product).values({ id: a.spare, companyId: a.company, projectId: a.project, name: "Residual 660 L", kind: "container-collection", status: "active", unit: "pickup", invoiceCode: "1001" })), refusedWith("23505", /product_invoice_code_idx/))
      await tx.insert(product).values({ id: a.spare, companyId: a.company, projectId: a.project, name: "Residual 660 L", kind: "container-collection", status: "active", unit: "pickup" })
    }))

  test("the billable event's ten shape checks refuse their pairs (23514), and the shapes that stand land: a priced pickup, a blocked pickup, a manual event with a person's price, a ticket's event, a reversal, a cancellation", () =>
    seeded(async (tx) => {
      const refuse = (values: Partial<typeof billableEvent.$inferInsert>, constraint: RegExp, why: string) =>
        assert.rejects(tx.transaction((savepoint) => savepoint.insert(billableEvent).values(manual(values))), refusedWith("23514", constraint), why)
      const unpriced = { unitPriceMinor: null, netMinor: null, vatPercent: null, vatMinor: null, currency: null, priceListRowId: null }
      const consumers = { kind: "pickup" as const, createdBy: null, sourceEventId: a.spare, routeId: a.route, pickupId: a.pickup }
      await refuse({ ...consumers, blockReason: "no-price-row" }, /billable_event_priced_shape/, "a block and a price")
      await refuse({ ...consumers, ...unpriced }, /billable_event_priced_shape/, "neither a block nor a price")
      await refuse({ ...consumers, currency: null }, /billable_event_priced_shape/, "the five not null together")
      await refuse({ agreementId: null }, /billable_event_priced_references/, "a priced event without its agreement")
      await refuse({ productId: null }, /billable_event_priced_references/, "a priced event without its product")
      await refuse({ netMinor: 12_346 }, /billable_event_amounts_shape/, "the net is not the unit price times the quantity")
      await refuse({ vatMinor: 3_087 }, /billable_event_vat_shape/, "an øre off")
      await refuse({ ...consumers, priceListRowId: null }, /billable_event_row_shape/, "a priced pickup with no row")
      await refuse({ priceListRowId: null }, /billable_event_override_shape/, "a person's price with no reason")
      await refuse({ overrideReason: "Agreed by phone" }, /billable_event_override_shape/, "a reason beside a row")
      await refuse({ ...consumers, routeId: null }, /billable_event_pickup_shape/, "a pickup without its route")
      await refuse({ ...consumers, ticketId: a.ticket }, /billable_event_kind_shape/, "a pickup naming a ticket")
      await refuse({ ...consumers, pickupId: null }, /billable_event_kind_shape/, "a pickup naming no pickup")
      await refuse({ kind: "ticket", ticketId: a.ticket, pickupId: a.pickup, routeId: a.route }, /billable_event_kind_shape/, "a ticket naming a pickup")
      await refuse({ pickupId: a.pickup, routeId: a.route }, /billable_event_kind_shape/, "a manual event naming a pickup")
      // The unit price negated so the amounts agree and the kind CASE alone refuses: a reversal's net is zero or less.
      await refuse({ kind: "reversal", reversesEventId: a.event, priceListRowId: null, unitPriceMinor: -PRICE.unitPriceMinor }, /billable_event_kind_shape/, "a positive reversal")
      await refuse({ kind: "reversal", priceListRowId: null, netMinor: -PRICE.netMinor, vatMinor: -PRICE.vatMinor }, /billable_event_kind_shape/, "a reversal naming nothing")
      // A reversal is never blocked: with the net null, `net_minor <= 0` is null and the CASE would pass, so the branch insists on the net by name.
      await refuse({ kind: "reversal", reversesEventId: a.event, ...unpriced, blockReason: "no-price-row" }, /billable_event_kind_shape/, "a blocked reversal")
      await refuse({ sourceEventId: a.spare }, /billable_event_origin_shape/, "a person and an event")
      await refuse({ createdBy: null, kind: "pickup", routeId: a.route, pickupId: a.pickup }, /billable_event_origin_shape/, "neither")
      await refuse({ cancelledAt: at(18) }, /billable_event_cancel_shape/, "a cancellation without its reason")
      await refuse({ cancelReason: "duplicate" }, /billable_event_cancel_shape/, "a reason without its instant")
      await refuse({ cancelledBy: a.account }, /billable_event_cancel_shape/, "a person without a cancellation")
      await refuse({ quantity: 0, netMinor: 0, vatMinor: 0 }, /billable_event_quantity_positive/, "nothing of a product")
      await refuse({ blockReason: "missing-payer", ...unpriced, priceListRowId: null }, /billable_event_block_reason_one_of|billable_event_override_shape/, "a reason outside the vocabulary")
      // The shapes that stand.
      await tx.insert(billableEvent).values([
        manual({ id: a.spare, ...consumers, sourceEventId: a.other, routeId: a.secondRoute, pickupId: a.secondPickup, serviceDate: "2026-10-12" }),
        manual({ id: a.other, ...consumers, ...unpriced, sourceEventId: a.third, routeId: a.secondRoute, pickupId: a.secondPickup, blockReason: "no-subscription", agreementId: null, subscriptionId: null, productId: null, serviceDate: "2026-10-12" }),
        manual({ id: a.third, priceListRowId: null, overrideReason: "Agreed by phone", unitPriceMinor: 10_000, netMinor: 10_000, vatMinor: 2_500 }),
        manual({ id: a.fourth, kind: "ticket", ticketId: a.ticket, ...unpriced, blockReason: "no-product", productId: null }),
      ])
      // The reversal: the original's amounts negated, the original named, and then the original cancelled by the consumer with no person.
      await tx.insert(billableEvent).values(manual({ id: `018f7c35-a000-7000-8000-0000000000e5`, kind: "reversal", createdBy: null, sourceEventId: a.fourth, reversesEventId: a.event, priceListRowId: null, netMinor: -PRICE.netMinor, vatMinor: -PRICE.vatMinor }))
      const [cancelled] = await tx.update(billableEvent).set({ cancelledAt: at(18), cancelReason: "pickup-corrected" }).where(eq(billableEvent.id, a.spare)).returning({ cancelledBy: billableEvent.cancelledBy })
      assert.equal(cancelled.cancelledBy, null)
    }))

  test("the domain's vatOf agrees with the two _vat_shape checks over odd amounts of both signs: every row the domain computed lands, and an øre off is refused", () =>
    seeded(async (tx) => {
      let rows = 0
      for (const [netMinor, vatPercent] of VAT_CASES) {
        const vatMinor = vatOf(netMinor, vatPercent)
        const unitPriceMinor = Math.abs(netMinor)
        await tx.transaction(async (savepoint) => {
          await savepoint.insert(billableEvent).values(
            netMinor < 0
              ? manual({ kind: "reversal", createdBy: null, sourceEventId: a.other, reversesEventId: a.event, priceListRowId: null, unitPriceMinor, netMinor, vatPercent, vatMinor })
              : manual({ priceListRowId: null, overrideReason: "The domain's case", unitPriceMinor, netMinor, vatPercent, vatMinor }),
          )
          await savepoint.insert(invoiceLine).values(creditLine({ id: a.other, invoiceId: a.invoice, position: 2, creditsLineId: netMinor < 0 ? a.line : null, billableEventId: netMinor < 0 ? null : a.spare, quantity: 1, unitPriceMinor, netMinor, vatPercent, vatMinor }))
          rows += 2
          throw new Landed()
        }).catch((error: unknown) => {
          if (!(error instanceof Landed)) throw error
        })
      }
      assert.equal(rows, VAT_CASES.length * 2)
      // Postgres rounds half away from zero, as the domain does: 10 øre at 25 % is 3, not 2, and -10 is -3.
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(billableEvent).values(manual({ priceListRowId: null, overrideReason: "Half up", unitPriceMinor: 10, netMinor: 10, vatPercent: 25, vatMinor: 2 }))), refusedWith("23514", /billable_event_vat_shape/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(invoiceLine).values(creditLine({ invoiceId: a.invoice, position: 2, quantity: 1, unitPriceMinor: 10, netMinor: -10, vatPercent: 25, vatMinor: -2 }))), refusedWith("23514", /invoice_line_vat_shape/))
      assert.equal(vatOf(10, 25), 3)
      assert.equal(vatOf(-10, 25), -3)
    }))

  test("an invoice's totals agree, a credit note's net is zero or less where an invoice's takes either sign, its period and its credit go with the kind, it does not credit itself, and a line charges for an event or credits a line (23514)", () =>
    seeded(async (tx) => {
      const refuse = (values: Partial<typeof invoice.$inferInsert>, constraint: RegExp, why: string) =>
        assert.rejects(tx.transaction((savepoint) => savepoint.insert(invoice).values(creditNote(values))), refusedWith("23514", constraint), why)
      await refuse({ grossMinor: -PRICE.netMinor }, /invoice_totals_shape/, "the gross is not the net and the VAT")
      await refuse({ netMinor: 100, vatMinor: 25, grossMinor: 125 }, /invoice_totals_shape/, "a positive credit note")
      await refuse({ billingRunId: a.run }, /invoice_kind_shape/, "a credit note naming a run")
      await refuse({ creditReason: null }, /invoice_kind_shape/, "a credit note without its reason")
      await refuse({ kind: "invoice", periodFrom: "2026-10-01", periodTo: "2026-10-31", creditsInvoiceId: null, creditReason: null, netMinor: 0, vatMinor: 0, grossMinor: 0 }, /invoice_kind_shape/, "an invoice without its run")
      await refuse({ periodFrom: "2026-10-01", periodTo: "2026-10-31" }, /invoice_period_shape/, "a credit note with a period")
      await refuse({ kind: "invoice", billingRunId: a.run, creditsInvoiceId: null, creditReason: null, periodFrom: "2026-10-01", netMinor: 0, vatMinor: 0, grossMinor: 0 }, /invoice_period_shape/, "half a period")
      await refuse({ dueOn: "2026-11-14" }, /invoice_due_shape/, "due before issued")
      await refuse({ creditsInvoiceId: a.spare }, /invoice_credits_shape/, "crediting itself")
      await refuse({ creditReason: "goodwill" }, /invoice_credit_reason_one_of/, "a reason outside the vocabulary")
      // The zero credit note stands: a free line credited.
      await tx.insert(invoice).values(creditNote({ id: a.other, number: 1101, netMinor: 0, vatMinor: 0, grossMinor: 0 }))
      await tx.insert(invoice).values(creditNote({}))
      // An invoice's net is held to no sign: a payer whose period holds more reversals than lines is invoiced a negative net, so a reversal-only payer group does not fail the run.
      await tx.insert(invoice).values(creditNote({ id: a.fourth, number: 1102, kind: "invoice", billingRunId: a.run, periodFrom: "2026-10-01", periodTo: "2026-10-31", creditsInvoiceId: null, creditReason: null }))
      const refuseLine = (values: Partial<typeof invoiceLine.$inferInsert>, constraint: RegExp, why: string) =>
        assert.rejects(tx.transaction((savepoint) => savepoint.insert(invoiceLine).values(creditLine(values))), refusedWith("23514", constraint), why)
      await refuseLine({ netMinor: PRICE.netMinor, vatMinor: PRICE.vatMinor }, /invoice_line_amounts_shape/, "a positive credit line")
      await refuseLine({ netMinor: -12_000, vatMinor: -3_000 }, /invoice_line_amounts_shape/, "a net that is not the unit price times the quantity")
      await refuseLine({ billableEventId: a.event }, /invoice_line_source_exactly_one/, "an event and a line")
      await refuseLine({ creditsLineId: null }, /invoice_line_source_exactly_one/, "neither")
      await refuseLine({ quantity: 0, netMinor: 0, vatMinor: 0 }, /invoice_line_quantity_positive/, "nothing credited")
      await tx.insert(invoiceLine).values(creditLine({}))
      // A number is the company's once; the same number in another company is another document.
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(invoice).values(creditNote({ id: a.third, number: 1000 }))), refusedWith("23505", /invoice_number_key/))
      await tx.insert(invoice).values(creditNote({ id: a.third, companyId: b.company, projectId: b.project, customerId: b.customer, creditsInvoiceId: b.invoice, issuedBy: b.account, number: 1000 }))
    }))

  test("a settlement's stamps follow its status on every status, its period has an end, its history gives a reopening its reason, and its lines are priced whole or not at all (23514)", () =>
    seeded(async (tx) => {
      const refuse = (values: Partial<typeof settlement.$inferInsert>, constraint: RegExp, why: string) =>
        assert.rejects(tx.transaction((savepoint) => savepoint.insert(settlement).values(opened(values))), refusedWith("23514", constraint), why)
      const stamps = { calculatedAt: at(17), closedAt: at(18), closedBy: a.account }
      await refuse({ status: "open", calculatedAt: at(17) }, /settlement_stamps_shape/, "open with a calculation")
      await refuse({ status: "calculated" }, /settlement_stamps_shape/, "calculated without its stamp")
      await refuse({ status: "calculated", ...stamps }, /settlement_stamps_shape/, "calculated and closed")
      await refuse({ status: "closed", calculatedAt: at(17), closedAt: at(18) }, /settlement_stamps_shape/, "closed without the person")
      await refuse({ status: "closed", closedAt: at(18), closedBy: a.account }, /settlement_stamps_shape/, "closed without a calculation")
      await refuse({ status: "under-review" as SettlementStatus }, /settlement_stamps_shape|settlement_status_one_of/, "the prototype's Under review is a reading")
      await refuse({ validTo: null }, /settlement_period_closed/, "a settlement without an end is not a period")
      await refuse({ validTo: "2026-11-01" }, /settlement_validity/, "an empty period")
      // The shapes that stand, one per status.
      const statuses: Record<SettlementStatus, Partial<typeof settlement.$inferInsert>> = {
        open: {},
        calculated: { calculatedAt: at(17), lineCount: 2, netMinor: 16_000 },
        closed: { ...stamps, lineCount: 2, netMinor: 16_000 },
      }
      const periods: [id: string, validFrom: string, validTo: string][] = [
        [a.spare, "2026-11-01", "2026-12-01"],
        [a.other, "2026-12-01", "2027-01-01"],
        [a.third, "2027-01-01", "2027-02-01"],
      ]
      for (const [i, status] of SETTLEMENT_STATUSES.entries()) {
        const [id, validFrom, validTo] = periods[i]
        await tx.insert(settlement).values(opened({ id, status, validFrom, validTo, ...statuses[status] }))
      }
      assert.equal(Object.keys(statuses).length, SETTLEMENT_STATUSES.length)
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(settlementEvent).values({ id: a.fourth, companyId: a.company, projectId: a.project, settlementId: a.settlement, kind: "reopened", status: "open", lineCount: 1, netMinor: 8_000, recordedBy: a.account })), refusedWith("23514", /settlement_event_reason_shape/), "a reopening without its reason")
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(settlementEvent).values({ id: a.fourth, companyId: a.company, projectId: a.project, settlementId: a.settlement, kind: "closed", status: "closed", lineCount: 1, netMinor: 8_000, reason: "x", recordedBy: a.account })), refusedWith("23514", /settlement_event_reason_shape/), "a reason on anything else")
      await tx.insert(settlementEvent).values({ id: a.fourth, companyId: a.company, projectId: a.project, settlementId: a.settlement, kind: "reopened", status: "open", lineCount: 1, netMinor: 8_000, reason: "A correction landed in October", recordedBy: a.account })
      const line = (values: Partial<typeof settlementLine.$inferInsert>) => ({ id: `018f7c35-a000-7000-8000-0000000000e6`, companyId: a.company, projectId: a.project, settlementId: a.spare, billableEventId: a.event, quantity: 1, ...values })
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(settlementLine).values(line({ serviceProviderPriceId: a.providerPrice }))), refusedWith("23514", /settlement_line_priced_shape/), "a price without its amounts")
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(settlementLine).values(line({ netMinor: 8_000, unitPriceMinor: 8_000 }))), refusedWith("23514", /settlement_line_priced_shape/), "amounts without a price")
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(settlementLine).values(line({ serviceProviderPriceId: a.providerPrice, netMinor: 8_000 }))), refusedWith("23514", /settlement_line_priced_shape/), "a net without its unit price")
      // An unpriced line stands, and blocks close at the API; the same event on one settlement is one line (23505).
      await tx.insert(settlementLine).values(line({}))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(settlementLine).values(line({ id: `018f7c35-a000-7000-8000-0000000000e7` }))), refusedWith("23505", /settlement_line_settlement_id_billable_event_id_key/))
    }))

  test("the remaining shape checks: a run's period and stamps, a price's index columns together and never itself, a review's note and correction, a product's rate in range (23514)", () =>
    seeded(async (tx) => {
      const run = (values: Partial<typeof billingRun.$inferInsert>) => ({ id: a.spare, companyId: a.company, projectId: a.project, periodFrom: "2026-11-01", periodTo: "2026-11-30", ...values })
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(billingRun).values(run({ periodTo: "2026-10-31" }))), refusedWith("23514", /billing_run_period_shape/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(billingRun).values(run({ status: "completed" }))), refusedWith("23514", /billing_run_stamps_shape/), "completed without its instant")
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(billingRun).values(run({ completedAt: at(16) }))), refusedWith("23514", /billing_run_stamps_shape/), "requested with one")
      await tx.insert(billingRun).values(run({ periodTo: "2026-11-01" }))
      // The seeded price ends where the rows below begin, so the checks and not the exclusion constraint are what refuse them.
      await tx.update(serviceProviderPrice).set({ validTo: "2027-01-01" }).where(eq(serviceProviderPrice.id, a.providerPrice))
      const refusePrice = (values: Partial<typeof serviceProviderPrice.$inferInsert>, constraint: RegExp, why: string) =>
        assert.rejects(tx.transaction((savepoint) => savepoint.insert(serviceProviderPrice).values(priced(values))), refusedWith("23514", constraint), why)
      await refusePrice({ indexLabel: "CPI" }, /service_provider_price_index_shape/, "a label without the row it indexed")
      await refusePrice({ indexedFromId: a.providerPrice, indexLabel: "CPI", indexBasisPoints: 500 }, /service_provider_price_index_shape/, "three of the four")
      await refusePrice({ indexedFromId: a.spare, indexLabel: "CPI", indexBasisPoints: 500, indexBase: "bid" }, /service_provider_price_index_shape/, "indexed from itself")
      await refusePrice({ bidMinor: -1 }, /service_provider_price_bid_not_negative/, "a negative bid")
      await refusePrice({ unitPriceMinor: -1 }, /service_provider_price_unit_price_not_negative/, "a negative fee")
      await refusePrice({ indexedFromId: a.providerPrice, indexLabel: "CPI", indexBasisPoints: -200, indexBase: "fee" }, /service_provider_price_index_base_one_of/, "a base outside the vocabulary")
      await tx.insert(serviceProviderPrice).values(priced({ indexedFromId: a.providerPrice, indexLabel: "CPI", indexBasisPoints: -200, indexBase: "current-fee", unitPriceMinor: 7_840 }))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(priceListRow).values(row({ unitPriceMinor: -1 }))), refusedWith("23514", /price_list_row_unit_price_not_negative/))
      await tx.insert(priceListRow).values(row({ unitPriceMinor: 0 }))
      const refuseReview = (values: Partial<typeof weightReview.$inferInsert>, constraint: RegExp, why: string) =>
        assert.rejects(tx.transaction((savepoint) => savepoint.insert(weightReview).values(reviewed(values))), refusedWith("23514", constraint), why)
      await refuseReview({ decision: "rejected" }, /weight_review_note_shape/, "a rejection says why")
      await refuseReview({ decision: "corrected" }, /weight_review_correction_shape/, "a correction names the new row")
      await refuseReview({ correctionUnloadId: a.spare }, /weight_review_correction_shape/, "an approval naming a correction")
      await refuseReview({ decision: "corrected", correctionUnloadId: a.unload }, /weight_review_correction_shape/, "a correction naming the reviewed row")
      await refuseReview({ decision: "needs-review" }, /weight_review_decision_one_of|weight_review_correction_shape/, "the prototype's Needs review is captured")
      await tx.insert(weightReview).values(reviewed({ decision: "rejected", note: "The ticket photo is unreadable" }))
      await assert.rejects(tx.transaction((savepoint) => savepoint.update(product).set({ vatPercent: 101 }).where(eq(product.id, a.product))), refusedWith("23514", /product_vat_percent_range/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.update(product).set({ vatPercent: -1 }).where(eq(product.id, a.product))), refusedWith("23514", /product_vat_percent_range/))
      await tx.update(product).set({ vatPercent: 0 }).where(eq(product.id, a.product))
      await tx.update(product).set({ vatPercent: null }).where(eq(product.id, a.product))
    }))

  test("the weight-review lookup folds the latest row: captured with none, the decision with one, the later decision with two, in recording order", () =>
    seeded(async (tx) => {
      // A second unload of the same route with no review yet, and a correction of the seeded one.
      await tx.insert(unload).values({ id: a.spare, companyId: a.company, projectId: a.project, routeId: a.route, unloadingStationId: a.station, wasteFractionId: a.wasteFraction, source: "dispatch", occurredAt: at(11, 30), recordedBy: a.account, netKg: 4_100 })
      const read = async () => {
        const review = weightReviewOf(tx, a.company, unload.id)
        const rows = await tx
          .select({ id: unload.id, status: reviewStatus(review.decision), correctionUnloadId: review.correctionUnloadId, reviewId: review.reviewId })
          .from(unload)
          .leftJoinLateral(review, sql`true`)
          .where(and(eq(unload.companyId, a.company), eq(unload.projectId, a.project)))
          .orderBy(unload.id)
        return rows.map((r) => [r.id, r.status, r.correctionUnloadId, r.reviewId])
      }
      assert.deepEqual(await read(), [
        [a.unload, "approved", null, a.review],
        [a.spare, "captured", null, null],
      ])
      await tx.insert(weightReview).values(reviewed({ id: a.other, decision: "corrected", correctionUnloadId: a.spare }))
      assert.deepEqual(await read(), [
        [a.unload, "corrected", a.spare, a.other],
        [a.spare, "captured", null, null],
      ])
      await tx.insert(weightReview).values(reviewed({ id: a.third, unloadId: a.spare, decision: "rejected", note: "Weighed twice" }))
      assert.deepEqual(await read(), [
        [a.unload, "corrected", a.spare, a.other],
        [a.spare, "rejected", null, a.third],
      ])
    }))

  test("the counter answers disjoint numbers under two concurrent transactions: the second's update waits on the first's row lock and returns only once the first has committed", async () => {
    // Two documents that merely ran together would pass on their numbers even if they took turns by accident, so the first is hand-held — its transaction, and with it the row lock, kept open until the test lets go — and the second is watched: Postgres reports its backend blocked behind the first's (`pg_blocking_pids`) before the first is released, and its update is timed to have returned only after.
    const companyId = a.spare
    await owner.db.insert(company).values({ id: companyId, companyId, name: "Counter", legalName: "Counter A/S", registrationNumber: "99999999", country: "DK", status: "active" })
    try {
      const [{ nextInvoiceNumber }] = await owner.db.select({ nextInvoiceNumber: company.nextInvoiceNumber }).from(company).where(eq(company.id, companyId))
      assert.equal(nextInvoiceNumber, 1000, "the default")
      /** One document taking its number: what the counter said before the update. */
      const take = async (tx: Tx): Promise<number> => {
        const [row] = await tx
          .update(company)
          .set({ nextInvoiceNumber: sql`${company.nextInvoiceNumber} + 1` })
          .where(and(eq(company.id, companyId), eq(company.companyId, companyId)))
          .returning({ next: company.nextInvoiceNumber })
        return row.next - 1
      }
      const backendOf = async (tx: Tx): Promise<number> => (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0].pid
      const released = Promise.withResolvers<void>()
      const firstLocked = Promise.withResolvers<number>()
      const first = owner.db
        .transaction(async (tx) => {
          const pid = await backendOf(tx)
          const number = await take(tx)
          firstLocked.resolve(pid)
          await released.promise
          return number
        })
        .catch((error: unknown) => {
          firstLocked.reject(error)
          throw error
        })
      const secondStarted = Promise.withResolvers<number>()
      let secondUpdated = Number.NaN
      const second = owner.db
        .transaction(async (tx) => {
          secondStarted.resolve(await backendOf(tx))
          const number = await take(tx)
          secondUpdated = performance.now()
          return number
        })
        .catch((error: unknown) => {
          secondStarted.reject(error)
          throw error
        })
      /** Rejects if the second's update returns while the first still holds the row. */
      const slippedThrough = second.then(() => Promise.reject(new Error("the second's update returned while the first still held the row: the lock did not hold it")))
      void slippedThrough.catch(() => undefined)
      let releasedAt = Number.NaN
      try {
        const [firstPid, secondPid] = await Promise.all([firstLocked.promise, secondStarted.promise])
        // Postgres names the backends a process blocks: the second's update is waiting on the first's transaction once this answers a row, and not before.
        const blocked = async (): Promise<boolean> => (await owner.sql`select pid from pg_stat_activity where pid = ${secondPid} and ${firstPid} = any(pg_blocking_pids(pid))`).length > 0
        const deadline = Date.now() + 10_000
        while (!(await Promise.race([blocked(), slippedThrough]))) {
          assert.ok(Date.now() < deadline, "the second's update never waited on the first: the row lock did not hold it")
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        releasedAt = performance.now()
      } finally {
        released.resolve()
        await Promise.allSettled([first, second])
      }
      assert.deepEqual(await Promise.all([first, second]), [1000, 1001], "the first took the first number and the second the next: nothing shared, nothing skipped")
      assert.ok(secondUpdated > releasedAt, "the second's update returned only after the first's hold ended")
      const [{ after }] = await owner.db.select({ after: company.nextInvoiceNumber }).from(company).where(eq(company.id, companyId))
      assert.equal(after, 1002)
    } finally {
      await owner.db.delete(company).where(eq(company.id, companyId))
    }
  })

  test("the outbox takes Finance's two kinds about an invoice and a settlement, and nothing about a billing run", () =>
    seeded(async (tx) => {
      const event = { companyId: a.company, projectId: a.project, occurredAt: at(16), payload: { id: a.invoice } } as const
      await tx.insert(outboxEvent).values([
        { ...event, id: a.spare, kind: "invoice-issued", aggregateKind: "invoice", aggregateId: a.invoice },
        { ...event, id: a.other, kind: "settlement-closed", aggregateKind: "settlement", aggregateId: a.settlement },
      ])
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(outboxEvent).values({ ...event, id: a.third, kind: "billing-run-completed", aggregateKind: "invoice", aggregateId: a.run })), refusedWith("23514", /outbox_event_kind_one_of/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(outboxEvent).values({ ...event, id: a.third, kind: "invoice-issued", aggregateKind: "billing-run", aggregateId: a.run })), refusedWith("23514", /outbox_event_aggregate_kind_one_of/))
    }))
})

/** Thrown out of a savepoint to roll it back after a statement landed. */
class Landed extends Error {}
