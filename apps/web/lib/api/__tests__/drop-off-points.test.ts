// The Drop-off Points on the adapter (#293 M3c): a point becomes a record of
// Resources › Drop-off Points with its three sets as the form types them; the
// record the generic form writes becomes the bodies the API's contracts
// accept, held here against the contracts' own zod schemas; and a save writes
// the point and each set that changed, through the store's seam over a
// scripted `fetch`.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { WasteFraction } from "@waste/contracts/catalogue"
import { DropOffPointCreate, DropOffPointExceptionsSet, DropOffPointHoursSet, DropOffPointPatch, type DropOffPoint } from "@waste/contracts/drop-off-points"
import type { Project } from "@waste/contracts/organisation"

import { FIXTURE_COMPANY_ID, FIXTURE_PROJECT_IDS, getModuleDefinition, type BusinessRecord } from "../../data/business-modules"
import { NOTHING_RESOLVED, type MappingContext } from "../records/adapter"
import { DROP_OFF_EXCEPTIONS_KEY, DROP_OFF_FRACTIONS_KEY, DROP_OFF_HOURS_KEY, dropOffPointAdapter, dropOffPointsModule } from "../records/drop-off-points"
import { wasteFractionAdapter } from "../records/master-data"
import { isServerBacked, SERVER_MODULE_KEYS } from "../records/modules"
import { projectAdapter } from "../records/organisation"
import { loaded, resolverOver, type ServerRecordsState } from "../records/server-records"
import { bodyOf, clientOver, json, scripted } from "./scripted-fetch"

/** Saturday 24 October 2026, late evening in Copenhagen: still the 24th on the project's clock, the 25th nowhere yet. */
const NOW = new Date("2026-10-24T20:00:00Z")
const STAMPS = { createdAt: "2026-10-20T09:00:00.000Z", updatedAt: "2026-10-21T09:30:00.000Z" }

const fixturesOf = (workspaceId: "resources" | "configure", moduleId: string) => {
  const module = getModuleDefinition({ workspaceId, moduleId })
  if (!module) throw new Error(`no module ${workspaceId}.${moduleId}`)
  return module.records
}

const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays", publicSlug: null, weightTolerancePercent: 5, paymentTermsDays: 30, paymentReferenceScheme: "none", holdForReview: false }
const glass: WasteFraction = { id: "01a0d2a4-a280-7005-8000-000000000005", ...STAMPS, key: "glass", name: "Glass", wasteCode: null, treatment: null, densityKgPerCubicMetre: null, hazardous: false }
const metal: WasteFraction = { ...glass, id: "01a0d2a4-a280-7005-8000-000000000007", key: "metal", name: "Metal" }

const noResolve = (fixtures: readonly BusinessRecord[]): MappingContext => ({ fixtures, resolve: NOTHING_RESOLVED, now: NOW })
const copenhagenRecord = projectAdapter.toRecord(copenhagen, noResolve(fixturesOf("configure", "organization")))
const fractionRecords = [glass, metal].map((fraction) => wasteFractionAdapter.toRecord(fraction, noResolve(fixturesOf("configure", "master"))))
const state: ServerRecordsState = new Map([
  ["configure.organization", loaded({ records: [copenhagenRecord], serverIds: new Map([[copenhagenRecord.id, copenhagen.id]]) }, 1)],
  ["configure.master", loaded({ records: fractionRecords, serverIds: new Map(fractionRecords.map((record, index) => [record.id, [glass, metal][index]!.id])) }, 1)],
])
const resolve = resolverOver(state)
const context: MappingContext = { fixtures: [], resolve, companyRecordId: FIXTURE_COMPANY_ID, now: NOW }

const amager: DropOffPoint = {
  id: "01a0d2a4-a280-7999-8000-000000000001",
  ...STAMPS,
  projectId: copenhagen.id,
  code: "GS-AMAGER",
  name: "Genbrugsstation Amager",
  kind: "recycling-centre",
  address: "Kraftværksvej 31, 2300 København S",
  location: { type: "Point", coordinates: [12.6105, 55.6521] },
  openAlways: false,
  closedOnHolidays: true,
  publicNote: "Husk ID.",
  status: "active",
  notes: null,
  wasteFractionIds: [glass.id, metal.id],
  hours: [
    { weekday: "monday", opensAt: "10:00", closesAt: "18:00" },
    { weekday: "tuesday", opensAt: "10:00", closesAt: "18:00" },
    { weekday: "wednesday", opensAt: "10:00", closesAt: "18:00" },
    { weekday: "saturday", opensAt: "09:00", closesAt: "12:00" },
  ],
  exceptions: [{ date: "2026-12-24", opensAt: "09:00", closesAt: "12:00", note: "Juleaften" }],
}

const recordOf = (point: DropOffPoint) => dropOffPointAdapter.toRecord(point, context)
const withValues = (record: BusinessRecord, values: Record<string, string | boolean>): BusinessRecord => ({ ...record, submittedValues: { ...record.submittedValues, ...values } })

describe("the Drop-off Points module", () => {
  test("is switched, after the organisation and the master data a point names", () => {
    assert.ok(isServerBacked("resources", "drop-off-points"))
    const at = (key: string) => SERVER_MODULE_KEYS.indexOf(key)
    assert.ok(at("configure.organization") < at("resources.drop-off-points"))
    assert.ok(at("configure.master") < at("resources.drop-off-points"))
    assert.deepEqual([dropOffPointsModule.workspaceId, dropOffPointsModule.moduleId], ["resources", "drop-off-points"])
  })
})

describe("a drop-off point", () => {
  test("is a record in its project, its fractions by the master module's web ids and its hours and exceptions as the form types them", () => {
    const record = recordOf(amager)
    assert.equal(record.id, `drop-off-${amager.id}`)
    assert.deepEqual(record.projectIds, [copenhagenRecord.id])
    assert.equal(record.status, "Active")
    assert.equal(record.facts?.Takes, "Glass · Metal")
    assert.deepEqual(record.submittedValues?.[DROP_OFF_FRACTIONS_KEY], fractionRecords.map((fraction) => fraction.id).join(","))
    assert.equal(record.submittedValues?.[DROP_OFF_HOURS_KEY], "Mon–Wed 10:00–18:00\nSat 09:00–12:00")
    assert.equal(record.submittedValues?.[DROP_OFF_EXCEPTIONS_KEY], "2026-12-24 09:00–12:00 Juleaften")
    assert.equal(record.submittedValues?.closedOnHolidays, true)
    assert.equal(record.submittedValues?.status, "active", "the edit form opens on the point's own status, never the create default")
  })

  test("the record the form writes becomes a DropOffPointCreate the contract accepts, the sets read out of the text, today on the project's clock kept", () => {
    const made: BusinessRecord = {
      ...recordOf(amager),
      id: "drop-off-points-drop-off-point-1700000000000",
      projectIds: [FIXTURE_PROJECT_IDS.copenhagen],
      submittedValues: {
        projectId: copenhagenRecord.id,
        kind: "bring-bank",
        name: "Glascontainer Holmbladsgade",
        code: "BB-HOLMB",
        status: "draft",
        address: "Holmbladsgade 70",
        latitude: "55.6655",
        longitude: "12.6093",
        openAlways: true,
        [DROP_OFF_FRACTIONS_KEY]: fractionRecords[0]!.id,
        [DROP_OFF_HOURS_KEY]: "",
        [DROP_OFF_EXCEPTIONS_KEY]: "2026-10-24 closed Emptied today",
      },
    }
    const body = dropOffPointAdapter.toCreateBody!(made, context)
    const parsed = DropOffPointCreate.parse(body)
    assert.equal(parsed.projectId, copenhagen.id)
    assert.deepEqual(parsed.wasteFractionIds, [glass.id])
    assert.deepEqual(parsed.location, { type: "Point", coordinates: [12.6093, 55.6655] })
    assert.equal(parsed.openAlways, true)
    assert.deepEqual(
      parsed.exceptions.map((exception) => exception.date),
      ["2026-10-24"],
      "today, still the 24th in Copenhagen though the 24th's evening in UTC, kept",
    )
    assert.deepEqual(
      dropOffPointAdapter.toCreateBody!({ ...made, submittedValues: { ...made.submittedValues, [DROP_OFF_EXCEPTIONS_KEY]: "2025-12-24 closed Juleaften" } }, context),
      { path: DROP_OFF_EXCEPTIONS_KEY, message: "2025-12-24 has gone by: an exception is for today or a day ahead" },
      "a date typed for a day gone by is refused, never quietly lost",
    )
  })

  test("an exception the point held is dropped once its day has passed; text retyped to the same hours writes nothing", () => {
    const held = recordOf({ ...amager, exceptions: [{ date: "2026-10-01", opensAt: null, closesAt: null, note: "Inventory" }, ...amager.exceptions] })
    const added = dropOffPointAdapter.toPatchBody(held, withValues(held, { [DROP_OFF_EXCEPTIONS_KEY]: `${held.submittedValues?.[DROP_OFF_EXCEPTIONS_KEY]}\n2026-12-31 closed` }), context) as { exceptions: { date: string }[] }
    assert.deepEqual(
      added.exceptions.map((exception) => exception.date),
      ["2026-12-24", "2026-12-31"],
      "the held 1 October dropped as history, not refused",
    )
    const record = recordOf(amager)
    assert.equal(dropOffPointAdapter.toPatchBody(record, withValues(record, { [DROP_OFF_HOURS_KEY]: "Sat 9:00-12:00\nMonday-Wednesday 10:00-18:00" }), context), null)
  })

  test("is refused here, naming the field, for hours or exceptions the domain refuses, a kind it does not know, or no location", () => {
    const record = recordOf(amager)
    assert.deepEqual(dropOffPointAdapter.toPatchBody(record, withValues(record, { [DROP_OFF_HOURS_KEY]: "Mon 18:00–10:00" }), context), {
      path: DROP_OFF_HOURS_KEY,
      message: "Monday: a window must open before it closes (18:00–10:00)",
    })
    assert.deepEqual(dropOffPointAdapter.toPatchBody(record, withValues(record, { [DROP_OFF_EXCEPTIONS_KEY]: "24 December closed" }), context), {
      path: DROP_OFF_EXCEPTIONS_KEY,
      message: "Line 1: begin with the date, such as 2026-12-24, then closed or the hours",
    })
    assert.equal((dropOffPointAdapter.toPatchBody(record, withValues(record, { kind: "depot" }), context) as { path: string }).path, "kind")
    assert.equal((dropOffPointAdapter.toPatchBody(record, withValues(record, { latitude: "" , longitude: "" }), context) as { path: string }).path, "latitude")
    assert.equal((dropOffPointAdapter.toPatchBody(record, withValues(record, { code: "GS-OTHER" }), context) as { path: string }).path, "code")
  })

  test("a save writes the point's own fields and each set that changed, never a set the form left as it was", () => {
    const record = recordOf(amager)
    assert.equal(dropOffPointAdapter.toPatchBody(record, record, context), null, "read and saved unchanged writes nothing")
    const renamed = dropOffPointAdapter.toPatchBody(record, withValues({ ...record, name: "GS Amager" }, { name: "GS Amager" }), context) as Record<string, unknown>
    assert.deepEqual(Object.keys(renamed), ["point"])
    DropOffPointPatch.parse(renamed.point)
    const rehoured = dropOffPointAdapter.toPatchBody(record, withValues(record, { [DROP_OFF_HOURS_KEY]: "Mon–Fri 10:00–17:00" }), context) as Record<string, unknown>
    assert.deepEqual(Object.keys(rehoured), ["hours"])
    DropOffPointHoursSet.parse({ hours: rehoured.hours })
    const excepted = dropOffPointAdapter.toPatchBody(record, withValues(record, { [DROP_OFF_EXCEPTIONS_KEY]: "2026-12-24 09:00–12:00 Juleaften\n2026-12-31 closed" }), context) as Record<string, unknown>
    assert.deepEqual(Object.keys(excepted), ["exceptions"])
    DropOffPointExceptionsSet.parse({ exceptions: excepted.exceptions })
  })

  test("the update patches the point, then puts each set it was handed through its own route, and answers the point as it now stands", async () => {
    const record = recordOf(amager)
    const write = dropOffPointAdapter.toPatchBody(record, withValues({ ...record, name: "GS Amager" }, { name: "GS Amager", [DROP_OFF_HOURS_KEY]: "Mon–Fri 10:00–17:00" }), context)
    const renamed = { ...amager, name: "GS Amager" }
    const rehoured = { ...renamed, hours: (["monday", "tuesday", "wednesday", "thursday", "friday"] as const).map((weekday) => ({ weekday, opensAt: "10:00", closesAt: "17:00" })) }
    const { fetch, calls } = scripted([() => json(renamed), () => json(rehoured)])
    const answer = await dropOffPointAdapter.update(clientOver(fetch), amager.id, write)
    assert.deepEqual(
      calls.map((call) => `${call.init.method} ${call.url}`),
      [`PATCH http://api.test/drop-off-points/${amager.id}`, `PUT http://api.test/drop-off-points/${amager.id}/hours`],
    )
    assert.deepEqual(bodyOf(calls[0]), { name: "GS Amager" })
    assert.equal(answer.hours.length, 5)
    const setOnly = scripted([() => json(amager)])
    await dropOffPointAdapter.update(clientOver(setOnly.fetch), amager.id, { exceptions: [] })
    assert.deepEqual(setOnly.calls.map((call) => `${call.init.method} ${call.url}`), [`PUT http://api.test/drop-off-points/${amager.id}/exceptions`])
  })
})
