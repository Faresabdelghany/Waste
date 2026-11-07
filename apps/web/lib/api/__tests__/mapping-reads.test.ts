// What a module's mapping read, as the store learns it from the mapping
// itself: the project's day it was read on, so the store reads it again once
// that day turns, and the project's clock it was read on, which is the
// project's whatever the role views.
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, test } from "node:test"

import type { Agreement, Subscription } from "@waste/contracts/agreements"
import type { Application } from "@waste/contracts/applications"
import type { Property } from "@waste/contracts/customers"
import type { Project } from "@waste/contracts/organisation"
import type { PriceList, PriceListRow } from "@waste/contracts/price-lists"
import type { ServiceArea } from "@waste/contracts/service-areas"

import { moduleKeyOf, type ServerModule } from "../records/adapter"
import { agreementsModule } from "../records/agreements"
import { applicationsModule } from "../records/applications"
import { projectTimezoneOf } from "../records/clock"
import { projectWebIdOf, withMeProjects } from "../records/me-projects"
import { SERVER_MODULES } from "../records/modules"
import { projectAdapter } from "../records/organisation"
import { priceRowsModule } from "../records/pricing"
import { propertiesModule } from "../records/properties"
import { serviceAreasModule } from "../records/service-areas"
import { clocksRead, dayTurnRereads, loaded, mapModule, resolverOver, type ModuleLists, type ServerRecordsState } from "../records/server-records"

const STAMPS = { createdAt: "2026-09-24T09:00:00.000Z", updatedAt: "2026-09-25T09:30:00.000Z" }
const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays", publicSlug: null, weightTolerancePercent: 5, paymentTermsDays: 30, paymentReferenceScheme: "none", holdForReview: false, branding: { brandColor: null, logoUrl: null, accessibilityStatementUrl: null } }
const CUSTOMER = "01a0d2a4-a280-700b-8000-000000000002"
const PRODUCT = "01a0d2a4-a280-700a-8000-000000000001"
const PROPERTY = "01a0d2a4-a280-700c-8000-000000000001"

const agreement: Agreement = { id: "01a0d2a4-a280-7012-8000-000000000001", ...STAMPS, projectId: copenhagen.id, number: "AGR-2408", customerId: CUSTOMER, payerCustomerId: CUSTOMER, status: "active", billingCadence: "monthly", currency: "DKK", notes: null, priceListId: null, serviceWindow: null, validFrom: "2026-01-01", validTo: null }
const subscription: Subscription = { id: "01a0d2a4-a280-7013-8000-000000000001", ...STAMPS, projectId: copenhagen.id, agreementId: agreement.id, productId: PRODUCT, propertyId: PROPERTY, sharedCollectionPointId: null, quantity: 1, validFrom: "2026-10-25", validTo: null }
const property: Property = { id: PROPERTY, ...STAMPS, projectId: copenhagen.id, name: "Parkvej 18", address: "Parkvej 18, 2100 København Ø", addressId: null, addressParts: null, registryId: null, kind: "residential", location: null, notes: null, driverInstructions: null, serviceWindow: null, status: "active", parties: [{ customerId: CUSTOMER, role: "owner", validFrom: "2026-10-25", validTo: null }] }
const application: Application = {
  id: "01a0d2a4-a280-7040-8000-000000000001",
  ...STAMPS,
  projectId: copenhagen.id,
  number: 12,
  kind: "home-composting",
  status: "decided",
  channel: "email",
  receivedOn: "2026-10-02",
  customerId: CUSTOMER,
  propertyId: null,
  sharedCollectionPointId: null,
  subscriptionId: null,
  statement: "We compost our food waste in the garden.",
  decision: { id: "01a0d2a4-a280-7041-8000-000000000001", applicationId: "01a0d2a4-a280-7040-8000-000000000001", outcome: "granted", conditions: null, validFrom: "2026-10-25", validTo: null, appealText: null, decidedBy: "01a0d2a4-a280-7005-8000-000000000001", decidedAt: "2026-10-05T09:00:00.000Z" },
}
const priceList: PriceList = { id: "01a0d2a4-a280-7028-8000-000000000001", ...STAMPS, projectId: copenhagen.id, code: "PL-2026", name: "PL-2026", currency: "DKK", isDefault: true, notes: null, validFrom: "2026-10-25", validTo: null }
const priceRow: PriceListRow = { id: "01a0d2a4-a280-7029-8000-000000000001", ...STAMPS, projectId: copenhagen.id, priceListId: priceList.id, productId: PRODUCT, unitPriceMinor: 1850, planningAreaId: null, customerKind: null, containerTypeId: null, wasteFractionId: null, customerId: null, note: null, indexedFromId: null, indexLabel: null, indexBasisPoints: null, fromQuantity: null, validFrom: "2026-10-25", validTo: null }
const serviceArea: ServiceArea = { id: "01a0d2a4-a280-7090-8000-000000000001", ...STAMPS, projectId: copenhagen.id, code: "CA-Ø-2", name: "Østerbro organic and paper", boundaryText: "Østerbro, north of Jagtvej", notes: null, planningAreaIds: [], wasteFractionIds: [], validFrom: "2026-10-25", validTo: null }

/** 23:00 on 24 October in Copenhagen (summer time), and 01:00 on the 25th: the project's midnight between them. */
const EVENING = new Date("2026-10-24T21:00:00Z")
const MORNING = Date.parse("2026-10-24T23:00:00Z")

const projectRecord = projectAdapter.toRecord(copenhagen, { resolve: resolverOver(new Map()), now: EVENING })
const organisation: ServerRecordsState = new Map([["configure.organization", loaded({ records: [projectRecord], serverIds: new Map([[projectRecord.id, copenhagen.id]]) }, EVENING.getTime())]])

/** The module read on the evening's clock, filed in the store as its read lands. */
function readOnTheEvening(module: ServerModule, lists: ModuleLists): ServerRecordsState {
  const result = mapModule(module, lists, { state: organisation, now: EVENING })
  return new Map([...organisation, [moduleKeyOf(module.workspaceId, module.moduleId), loaded(result, EVENING.getTime())]])
}

const keysOf = (modules: readonly ServerModule[]) => modules.map((module) => moduleKeyOf(module.workspaceId, module.moduleId))

// Bug: four modules read the project's day in their mapping but said nothing of it, so their statuses stayed on the
// day they were read until the page was left — a subscription starting today still "Pending" the morning it began.
// The service areas' award periods were a fifth.
describe("a module whose mapping reads the project's day", () => {
  const cases: [string, ServerModule, ModuleLists][] = [
    ["the agreements' subscriptions", agreementsModule, [[agreement], [subscription]]],
    ["the properties' parties", propertiesModule, [[property]]],
    ["the applications' decisions", applicationsModule, [[application]]],
    ["the price lists and their rows", priceRowsModule, [[priceList], [priceRow]]],
    ["the service areas' awards", serviceAreasModule, [[serviceArea], []]],
  ]
  for (const [what, module, lists] of cases) {
    test(`is read again once the project's day turns: ${what}`, () => {
      const state = readOnTheEvening(module, lists)
      assert.deepEqual(clocksRead(state), ["Europe/Copenhagen"], "on the project's clock")
      assert.deepEqual(keysOf(dayTurnRereads(state, SERVER_MODULES, EVENING.getTime())), [], "not before its midnight")
      assert.deepEqual(keysOf(dayTurnRereads(state, SERVER_MODULES, MORNING)), [moduleKeyOf(module.workspaceId, module.moduleId)])
    })
  }

  test("reads it through the mapping's clock alone, which notes the read: no adapter reads the day off `now` itself", () => {
    const records = join(import.meta.dirname, "..", "records")
    const offTheClock = /\b(dayIn|wallClockIn)\(\(?context\.now/
    const readers = readdirSync(records).filter((file) => file.endsWith(".ts") && file !== "clock.ts" && offTheClock.test(readFileSync(join(records, file), "utf8")))
    assert.deepEqual(readers, [])
  })
})

// Bug: `/me` named a project by its id and name alone, so for a role that does not view the organisation the
// project's clock was the browser's: every day and time its rows read was the browser's, not the project's.
describe("a project /me names, for a role that does not view the organisation", () => {
  const kiritimati = { id: "01a0d2a4-a280-7002-8000-000000000009", name: "Line Islands", timezone: "Pacific/Kiritimati", currency: "AUD" }
  const state = withMeProjects(new Map(), [kiritimati])

  test("carries the project's clock and currency", () => {
    const resolve = resolverOver(state)
    assert.equal(projectTimezoneOf({ projectIds: [projectWebIdOf(kiritimati)] }, { resolve }), "Pacific/Kiritimati")
    assert.equal(resolve.byServerId(kiritimati.id)?.submittedValues?.currency, "AUD")
  })

  test("so a row is read on the project's day, not the browser's, and turns at the project's midnight", () => {
    // 10:30 on 1 April in UTC is half past midnight on the 2nd at UTC+14.
    const now = new Date("2026-04-01T10:30:00Z")
    const starting = { ...subscription, projectId: kiritimati.id, validFrom: "2026-04-02" }
    const result = mapModule(agreementsModule, [[], [starting]], { state, now })
    assert.equal(result.records[0].status, "Active")
    assert.deepEqual(clocksRead(new Map(state).set("customers.agreements", loaded(result, now.getTime()))), ["Pacific/Kiritimati"])
  })
})
