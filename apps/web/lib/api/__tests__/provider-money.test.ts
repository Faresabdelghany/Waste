// Service provider prices and settlements on the adapter (#186, slice 11 of
// #81, for #148): a price under an assignment, its bid locked and its fee
// moved by indexation alone — Apply index a create of the chain's next row —
// and a settlement over an assignment's period, moved by calculate, close and
// reopen where the domain's machine moves it, its history read beside it.
// Bodies are held against the contracts' own zod schemas.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Product } from "@waste/contracts/catalogue"
import type { Project } from "@waste/contracts/organisation"
import { ServiceProviderPriceCreate, ServiceProviderPriceIndex, ServiceProviderPricePatch, type ServiceProviderPrice } from "@waste/contracts/service-provider-prices"
import { SettlementCreate, SettlementReopen, type SettlementDetail, type SettlementEvent } from "@waste/contracts/settlements"

import { type BusinessRecord } from "../../data/business-modules"
import { problemSentence } from "../problem"
import { NOTHING_RESOLVED, recordFrom, type MappingContext } from "../records/adapter"
import { isServerBacked } from "../records/modules"
import { projectAdapter } from "../records/organisation"
import { productAdapter } from "../records/pricing"
import {
  providerPriceAdapter,
  providerPriceIndexHeldBack,
  providerPriceIndexOffered,
  providerPricesModule,
  settlementAdapter,
  settlementCommandsOffered,
  settlementHeldBack,
  settlementHistory,
  settlementsModule,
} from "../records/provider-money"
import { basisPointsOf, INDEX_REFUSAL } from "@/lib/commercial/indexation"
import { commandRecord, loaded, resolverOver, spellsStatus, writeRecord, type ServerRecordsState } from "../records/server-records"
import { bodyOf, clientOver, json, problem, scripted } from "./scripted-fetch"

const NOW = new Date("2026-09-30T12:00:00Z")
const STAMPS = { createdAt: "2026-09-24T09:00:00.000Z", updatedAt: "2026-09-25T09:30:00.000Z" }

const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays", publicSlug: null, weightTolerancePercent: 5, paymentTermsDays: 30, paymentReferenceScheme: "none", holdForReview: false, branding: { brandColor: null, logoUrl: null, accessibilityStatementUrl: null } }
const residual: Product = { id: "01a0d2a4-a280-700a-8000-000000000001", ...STAMPS, projectId: copenhagen.id, name: "Residual waste · 240L bin", kind: "container-collection", status: "active", unit: "pickup", containerTypeId: null, wasteFractionId: null, serviceFrequencyId: null, invoiceName: null, invoiceCode: null, vatPercent: 25, freeDays: null }
const ASSIGNMENT = "01a0d2a4-a280-7091-8000-000000000001"
const EVENT = "01a0d2a4-a280-7050-8000-000000000001"
const ADMIN = "01a0d2a4-a280-7003-8000-000000000001"

const first: ServiceProviderPrice = {
  id: "01a0d2a4-a280-7092-8000-000000000001",
  ...STAMPS,
  projectId: copenhagen.id,
  serviceAreaAssignmentId: ASSIGNMENT,
  productId: residual.id,
  bidMinor: 1120,
  unitPriceMinor: 1120,
  currency: "DKK",
  indexedFromId: null,
  indexLabel: null,
  indexBasisPoints: null,
  indexBase: null,
  notes: null,
  validFrom: "2026-01-01",
  validTo: "2026-03-01",
}
const indexed: ServiceProviderPrice = { ...first, id: "01a0d2a4-a280-7092-8000-000000000002", unitPriceMinor: 1176, indexedFromId: first.id, indexLabel: "CPI", indexBasisPoints: 500, indexBase: "bid", validFrom: "2026-03-01", validTo: null }

const NO = (): MappingContext => ({ resolve: NOTHING_RESOLVED, now: NOW })
const moduleOf = (records: BusinessRecord[], ids: string[]) => loaded({ records, serverIds: new Map(records.map((record, index) => [record.id, ids[index]])) }, 1)
const projectRecord = recordFrom(projectAdapter, copenhagen, NO())
const productRecord = recordFrom(productAdapter, residual, NO())
const assignmentRecord: BusinessRecord = { ...projectRecord, id: `assignment-${ASSIGNMENT}`, name: "CA-Ø-2 · NordRen ApS", status: "Active", recordKind: "Service area assignment", facts: { "Service area": "Østerbro organic and paper", "Service provider": "NordRen ApS" }, projectIds: [projectRecord.id], submittedValues: { serviceAreaId: "service-area-x", serviceProviderId: "service-provider-y", validFrom: "2026-01-01" } }
const eventRecord: BusinessRecord = { ...projectRecord, id: `event-${EVENT}`, name: "Pickup · Residual waste · 240L bin", recordKind: "Billable event", facts: { Route: "RC-1042 · 2026-09-29", "Service date": "2026-09-29" } }
const userRecord: BusinessRecord = { ...projectRecord, id: `user-${ADMIN}`, name: "Fares Abdelghany", recordKind: "User" }
const state: ServerRecordsState = new Map([
  ["configure.organization", moduleOf([projectRecord], [copenhagen.id])],
  ["configure.access", moduleOf([userRecord], [ADMIN])],
  ["commercial.products", moduleOf([productRecord], [residual.id])],
  ["service-providers.service-areas", moduleOf([assignmentRecord], [ASSIGNMENT])],
  ["commercial.events", moduleOf([eventRecord], [EVENT])],
])
const context = (at: ServerRecordsState = state): MappingContext => ({ ...NO(), resolve: resolverOver(at) })

function made(id: string, recordKind: string, values: Record<string, string>): BusinessRecord {
  return { id, name: id, context: "", status: "Active", owner: "", value: "", updated: "Now", description: "", facts: {}, related: [], source: "Waste API", freshness: "Now", projectIds: [projectRecord.id], recordKind, submittedValues: values }
}

describe("the service provider prices module", () => {
  test("is switched", () => {
    assert.ok(isServerBacked("commercial", "service-provider-prices"))
    assert.deepEqual(providerPricesModule.resources, [providerPriceAdapter])
  })

  test("shows a price with its product, provider and area, its fee in the project's currency, the bid locked and the index that made it", () => {
    const record = recordFrom(providerPriceAdapter, indexed, context())
    assert.equal(record.id, `provider-price-${indexed.id}`)
    assert.equal(record.name, "Residual waste · 240L bin · NordRen ApS")
    assert.equal(record.context, "CA-Ø-2 · NordRen ApS")
    assert.equal(record.value, "DKK 11.76/pickup")
    assert.equal(record.serviceProviderId, "service-provider-y", "its assignment's provider: the provider page lists its prices by it")
    assert.equal(record.status, "Active")
    assert.equal(record.facts.Bid, "DKK 11.20")
    assert.equal(record.facts.Index, "CPI +5% on the bid")
    assert.deepEqual(record.submittedValues, { serviceAreaAssignmentId: `assignment-${ASSIGNMENT}`, productId: productRecord.id, bid: "11.20", fee: "11.76", validFrom: "2026-03-01", indexedFromId: `provider-price-${first.id}`, readOn: "2026-09-30" })
    assert.equal(recordFrom(providerPriceAdapter, first, context()).status, "Expired")
    assert.ok(!spellsStatus(providerPricesModule, record, "Expired"))
  })

  test("makes a chain's first row from the form: the bid and the fee in minor units, the fee the bid when blank", () => {
    const record = made("service-provider-prices-service-provider-price-1", "Service provider price", { serviceAreaAssignmentId: assignmentRecord.id, productId: productRecord.id, bid: "11.20", fee: "", notes: "Tender 2026", validFrom: "2026-01-01", validTo: "" })
    const body = providerPriceAdapter.toCreateBody!(record, context())
    assert.deepEqual(body, { serviceAreaAssignmentId: ASSIGNMENT, productId: residual.id, bidMinor: 1120, notes: "Tender 2026", validFrom: "2026-01-01" })
    assert.ok(ServiceProviderPriceCreate.safeParse(body).success)
    const refusalOf = (values: Record<string, string>) => providerPriceAdapter.toCreateBody!({ ...record, submittedValues: { ...record.submittedValues, ...values } }, context())
    assert.deepEqual(refusalOf({ serviceAreaAssignmentId: "assignment-unknown" }), { path: "serviceAreaAssignmentId", message: "Pick a service area assignment the API holds" })
    assert.deepEqual(refusalOf({ bid: "11.205" }), { path: "bid", message: "An amount in DKK, such as 18.50" })
  })

  test("ends a price left open with its assignment, as the form's hint says: the API refuses an open end under a bounded one", () => {
    const bounded = { ...assignmentRecord, submittedValues: { ...assignmentRecord.submittedValues, validTo: "2026-12-31" } }
    const at = new Map([...state, ["service-providers.service-areas", moduleOf([bounded], [ASSIGNMENT])]])
    const record = made("service-provider-prices-service-provider-price-1", "Service provider price", { serviceAreaAssignmentId: bounded.id, productId: productRecord.id, bid: "11.20", validFrom: "2026-01-01", validTo: "" })
    assert.equal((providerPriceAdapter.toCreateBody!(record, context(at)) as { validTo?: string }).validTo, "2027-01-01")
    assert.equal((providerPriceAdapter.toCreateBody!({ ...record, submittedValues: { ...record.submittedValues, validTo: "2026-06-30" } }, context(at)) as { validTo?: string }).validTo, "2026-07-01", "an end given is the price's own")
  })

  test("Apply index is a create of the chain's next row, posted under the row it indexes, the change in basis points", async () => {
    assert.deepEqual(["5", "2.5", "-1.25", "0.05"].map(basisPointsOf), [500, 250, -125, 5])
    for (const text of ["", "5%", "1.234", "x"]) assert.ok(Number.isNaN(basisPointsOf(text)), text)
    const current = moduleOf([recordFrom(providerPriceAdapter, first, context())], [first.id])
    const at = new Map([...state, ["commercial.service-provider-prices", current]])
    const record = made("service-provider-prices-indexed-1", "Indexed service provider price", { indexesPriceId: `provider-price-${first.id}`, label: "CPI", percent: "5", base: "bid", appliedFrom: "2026-03-01" })
    const body = providerPriceAdapter.toCreateBody!(record, context(at)) as { indexes: string; body: unknown }
    assert.deepEqual(body, { indexes: first.id, body: { label: "CPI", basisPoints: 500, base: "bid", appliedFrom: "2026-03-01" } })
    assert.ok(ServiceProviderPriceIndex.safeParse(body.body).success)
    assert.deepEqual(providerPriceAdapter.toCreateBody!({ ...record, submittedValues: { ...record.submittedValues, percent: "five" } }, context(at)), { path: "percent", message: INDEX_REFUSAL })
    const { fetch, calls } = scripted([() => json(indexed, 201, { location: `/service-provider-prices/${indexed.id}` })])
    const outcome = await writeRecord(clientOver(fetch), providerPricesModule, current, record, { state: at, now: NOW })
    assert.equal(calls[0].url, `http://api.test/service-provider-prices/${first.id}/index`)
    assert.equal(outcome.kind, "created")
    if (outcome.kind === "created") assert.equal(outcome.record.value, "DKK 11.76/pickup")
  })

  test("offers Apply index only on a price not ended on the project's day it was read on, the module read again as the day turns (#281)", () => {
    /** A price read on the clock `now`: whether its details offer Apply index. */
    const offered = (price: ServiceProviderPrice, now: Date) => providerPriceIndexOffered(recordFrom(providerPriceAdapter, price, { ...context(), now }))
    assert.equal(offered(indexed, NOW), true, "an open price")
    assert.equal(offered(first, new Date("2026-02-28T12:00:00Z")), true, "on its last day in")
    assert.equal(offered(first, NOW), false, "ended: the price in force is the one to index")
    assert.equal(offered({ ...indexed, validFrom: "2026-12-01" }, NOW), true, "upcoming: an index applies inside its period")
    // 23:30 UTC on its last day is the first of March in Copenhagen, the project's clock.
    assert.equal(offered(first, new Date("2026-02-28T23:30:00Z")), false)
    assert.equal(providerPriceIndexOffered({ ...recordFrom(providerPriceAdapter, indexed, context()), submittedValues: {} }), false, "a record that does not say its day is offered nothing")
  })

  test("says why an ended price takes no index, naming its end as its details do: the last day in (#281)", () => {
    const heldBack = (price: ServiceProviderPrice, now: Date) => providerPriceIndexHeldBack(recordFrom(providerPriceAdapter, price, { ...context(), now }))
    const ended = recordFrom(providerPriceAdapter, first, context())
    assert.equal(ended.facts["Valid to"], "2026-02-28")
    assert.equal(heldBack(first, NOW), "This price was valid to 2026-02-28; index the price in force")
    assert.equal(heldBack(first, new Date("2026-02-28T12:00:00Z")), undefined)
    assert.equal(heldBack(indexed, NOW), undefined)
  })

  test("patches the notes and the end alone: the fee moves by index, the bid never", () => {
    const record = recordFrom(providerPriceAdapter, indexed, context())
    const ended = providerPriceAdapter.toPatchBody?.(record, { ...record, submittedValues: { ...record.submittedValues, validTo: "2026-12-31", notes: "Ends with the contract" } }, context())
    assert.deepEqual(ended, { notes: "Ends with the contract", validTo: "2027-01-01" })
    assert.ok(ServiceProviderPricePatch.safeParse(ended).success)
    for (const [key, value] of [["fee", "12.00"], ["bid", "12.00"], ["productId", "product-other"], ["validFrom", "2026-04-01"]] as const) {
      assert.deepEqual(providerPriceAdapter.toPatchBody?.(record, { ...record, submittedValues: { ...record.submittedValues, [key]: value } }, context()), { path: key, message: "The fee moves by Apply index and the bid never: end this price and add another for anything else" }, key)
    }
  })
})

describe("the settlements module", () => {
  const settlement: SettlementDetail = {
    id: "01a0d2a4-a280-7093-8000-000000000001",
    ...STAMPS,
    projectId: copenhagen.id,
    serviceAreaAssignmentId: ASSIGNMENT,
    status: "calculated",
    currency: "DKK",
    calculatedAt: "2026-09-30T10:00:00.000Z",
    closedAt: null,
    closedBy: null,
    lineCount: 2,
    netMinor: 1176,
    validFrom: "2026-09-01",
    validTo: "2026-10-01",
    lines: [
      { id: "01a0d2a4-a280-7094-8000-000000000001", ...STAMPS, settlementId: "01a0d2a4-a280-7093-8000-000000000001", billableEventId: EVENT, serviceProviderPriceId: indexed.id, quantity: 1, unitPriceMinor: 1176, netMinor: 1176 },
      { id: "01a0d2a4-a280-7094-8000-000000000002", ...STAMPS, settlementId: "01a0d2a4-a280-7093-8000-000000000001", billableEventId: "01a0d2a4-a280-7050-8000-000000000002", serviceProviderPriceId: null, quantity: 1, unitPriceMinor: null, netMinor: null },
    ],
  }

  test("is switched, a settlement of its own", () => {
    assert.ok(isServerBacked("commercial", "settlements"))
    assert.deepEqual(settlementsModule.resources, [settlementAdapter])
  })

  test("shows a settlement by its provider and period, its net in its currency, an unpriced line said since it blocks close", () => {
    const record = recordFrom(settlementAdapter, settlement, context())
    assert.equal(record.id, `settlement-${settlement.id}`)
    assert.equal(record.name, "NordRen ApS · 2026-09-01 – 2026-09-30")
    assert.equal(record.status, "Calculated")
    assert.equal(record.value, "DKK 11.76")
    assert.equal(record.facts.Lines, "2")
    assert.equal(record.facts["Unpriced lines"], "1: no provider price covers its product on its day, which blocks close")
    assert.deepEqual(record.allowedTransitions, [])
    assert.ok(!spellsStatus(settlementsModule, record, "Closed"), "the status moves by command alone")
  })

  test("offers each command only where the machine moves the settlement on the project's day it was read on: never a stay, never a refusal (#260)", () => {
    /** September's settlement in a status, read on the clock `now`: what its details offer. */
    const offered = (status: SettlementDetail["status"], now: Date) => settlementCommandsOffered(recordFrom(settlementAdapter, { ...settlement, status }, { ...context(), now }))
    const october = new Date("2026-10-01T08:00:00Z")
    assert.deepEqual(offered("open", october), ["calculate"], "once the period has ended")
    assert.deepEqual(offered("calculated", october), ["calculate", "close"])
    assert.deepEqual(offered("closed", october), ["reopen"])
    assert.deepEqual(offered("calculated", NOW), ["calculate"], "on its last day the period has not ended: a calculation, no close")
    const august = new Date("2026-08-31T12:00:00Z")
    for (const status of ["open", "calculated"] as const) assert.deepEqual(offered(status, august), [], `${status} before the period has begun: nothing to calculate`)
    assert.deepEqual(offered("closed", august), ["reopen"], "reopen reads no day")
    // 22:30 UTC on its last day is the first of October in Copenhagen, the project's clock.
    assert.deepEqual(offered("calculated", new Date("2026-09-30T22:30:00Z")), ["calculate", "close"])
    assert.deepEqual(settlementCommandsOffered({ ...recordFrom(settlementAdapter, settlement, context()), submittedValues: {} }), [], "a record that does not say its period and day is offered nothing")
  })

  test("says why the day holds a command back, in the API's sentence; nothing where only the status does (#260)", () => {
    const heldBack = (status: SettlementDetail["status"], now: Date) => settlementHeldBack(recordFrom(settlementAdapter, { ...settlement, status }, { ...context(), now }))
    const august = new Date("2026-08-31T12:00:00Z")
    assert.equal(heldBack("open", august), "Settlement NordRen ApS · 2026-09-01 – 2026-09-30 has not begun; calculate it from its first day")
    assert.equal(heldBack("calculated", NOW), "Settlement NordRen ApS · 2026-09-01 – 2026-09-30 has not ended; close it after its last day")
    assert.equal(heldBack("calculated", august), "Settlement NordRen ApS · 2026-09-01 – 2026-09-30 has not begun; calculate it from its first day", "the first held back, in the commands' order")
    const october = new Date("2026-10-01T08:00:00Z")
    for (const status of ["open", "calculated", "closed"] as const) assert.equal(heldBack(status, october), undefined, `${status} once the period has ended`)
    assert.equal(heldBack("open", NOW), undefined, "an open settlement's close waits for its calculation, not the day")
    assert.equal(heldBack("closed", august), undefined, "a closed one waits for its reopening")
  })

  test("opens a settlement on an assignment over a period, its end the first day out", () => {
    const record = made("settlements-settlement-1", "Settlement", { serviceAreaAssignmentId: assignmentRecord.id, validFrom: "2026-09-01", validTo: "2026-09-30" })
    const body = settlementAdapter.toCreateBody!(record, context())
    assert.deepEqual(body, { serviceAreaAssignmentId: ASSIGNMENT, validFrom: "2026-09-01", validTo: "2026-10-01" })
    assert.ok(SettlementCreate.safeParse(body).success)
    assert.deepEqual(settlementAdapter.toCreateBody!({ ...record, submittedValues: { ...record.submittedValues, validTo: "" } }, context()), { path: "validTo", message: "A settlement settles a period: give its last day" })
  })

  test("calculates, closes and reopens by command, reopening with its reason, the API's refusal in its words", async () => {
    const record = recordFrom(settlementAdapter, settlement, context())
    const current = moduleOf([record], [settlement.id])
    const { fetch, calls } = scripted([
      () => problem(409, "Settlement NordRen ApS · 2026-09 has lines no provider price covers; price them, then calculate again"),
      () => json({ ...settlement, status: "closed", closedAt: "2026-09-30T12:00:00.000Z", closedBy: ADMIN }),
      () => json({ ...settlement, status: "open" }),
    ])
    const options = { state }
    const refused = await commandRecord(clientOver(fetch), settlementsModule, current, record, "close", {}, options)
    assert.equal(refused.kind, "refused")
    if (refused.kind === "refused") {
      assert.equal(refused.what, `${record.name} was not closed`)
      assert.match(problemSentence(refused.problem), /price them, then calculate again/)
    }
    assert.deepEqual(bodyOf(calls[0]), {})
    const closed = await commandRecord(clientOver(fetch), settlementsModule, current, record, "close", {}, options)
    if (closed.kind === "done") assert.equal(closed.record.status, "Closed")
    assert.equal(calls[1].url, `http://api.test/settlements/${settlement.id}/close`)
    const unsaid = await commandRecord(clientOver(fetch), settlementsModule, current, record, "reopen", { reason: "" }, options)
    assert.equal(unsaid.kind, "refused", "a reopening says why")
    assert.equal(calls.length, 2)
    const reopened = await commandRecord(clientOver(fetch), settlementsModule, current, record, "reopen", { reason: "A disputed line was settled" }, options)
    assert.equal(reopened.kind, "done")
    assert.deepEqual(bodyOf(calls[2]), { reason: "A disputed line was settled" })
    assert.ok(SettlementReopen.safeParse(bodyOf(calls[2])).success)
  })

  test("reads the history oldest first, the reason a reopening gave beside its row", async () => {
    const events: SettlementEvent[] = [
      { id: "01a0d2a4-a280-7095-8000-000000000001", recordedAt: "2026-09-30T10:00:00.000Z", settlementId: settlement.id, kind: "calculated", status: "calculated", lineCount: 2, netMinor: 1176, reason: null, recordedBy: ADMIN },
    ]
    const { fetch, calls } = scripted([() => json({ items: events, nextCursor: null })])
    assert.deepEqual(await settlementHistory(clientOver(fetch), settlement.id), events)
    assert.equal(calls[0].url, `http://api.test/settlements/${settlement.id}/events?limit=200`)
  })
})
