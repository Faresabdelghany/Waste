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

import { moduleKeyOf, recordFrom, type ServerModule } from "../records/adapter"
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

const projectRecord = recordFrom(projectAdapter, copenhagen, { resolve: resolverOver(new Map()), now: EVENING })
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

  test("reads it through the mapping's clock alone, which notes the read: no adapter, nor a helper beside one, reads the day off the clock itself", () => {
    assert.deepEqual(daysOffTheClock(), [])
  })
})

/** The one place each day is read off the clock on purpose: the clock itself, and the engine's clock a load's mapping is handed. */
const THE_CLOCK = new Set(["api/records/clock.ts", "api/records/server-records.ts"])

/**
 * Read when listed, never mapped: which default list a product's price is read from is the browser's day's (findings X3), a
 * read no mapping makes, so no day turn follows it. Named here until the list reads it on the project's clock.
 */
const READ_WHEN_LISTED = new Set(["api/records/pricing.ts: dayIn(new Date()"])

/** The functions that make a day, or a time of day, out of an instant. */
const DAY_OF = /\b(dayIn|dayInTimezone|wallClockIn|projectToday|todayIso)\(/g

/** The text of a call's first argument, from just inside its parenthesis: up to the first comma or the close at its own depth. */
function firstArgument(source: string, from: number): string {
  let depth = 0
  for (let at = from; at < source.length; at += 1) {
    const character = source[at]
    if ("([{".includes(character)) depth += 1
    else if (")]}".includes(character)) {
      if (depth === 0) return source.slice(from, at).trim()
      depth -= 1
    } else if (character === "," && depth === 0) return source.slice(from, at).trim()
  }
  return source.slice(from).trim()
}

/**
 * Every day made out of the clock outside the clock, in the record layer and the helpers its mappings call (lib/data,
 * lib/prototype, lib/commercial): a call whose instant is the clock's now — `context.now`, `new Date()`, nothing at all, or a
 * name bound to either in the same file (`const now = context.now ?? new Date()`).
 */
function daysOffTheClock(): string[] {
  const lib = join(import.meta.dirname, "..", "..")
  const files = ["api/records", "data", "prototype", "commercial"].flatMap((folder) => readdirSync(join(lib, folder), { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".ts") && !file.includes("__tests__")).map((file) => `${folder}/${file}`))
  const found: string[] = []
  for (const file of files.filter((candidate) => !THE_CLOCK.has(candidate))) {
    const source = readFileSync(join(lib, file), "utf8")
    const clocks = [...source.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*(?:context\.now|new Date\(\s*\))/g)].map((bound) => bound[1])
    for (const call of source.matchAll(DAY_OF)) {
      const argument = firstArgument(source, (call.index ?? 0) + call[0].length)
      const offTheClock = argument === "" || /context\.now|new Date\(\s*\)/.test(argument) || clocks.some((name) => new RegExp(`^${name}\\b`).test(argument))
      const named = `${file}: ${call[1]}(${argument.split("\n")[0]}`
      if (offTheClock && !READ_WHEN_LISTED.has(named)) found.push(named)
    }
  }
  return found
}

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
