// Service areas and their assignments on the adapter (#186, slice 11 of #81,
// for #148): the award as the set of planning areas it covers and the
// fractions it is for — never a drawn polygon — and the provider holding it
// over a period, the two kinds of `service-providers.service-areas`. The
// bodies are held against the contracts' own zod schemas; an edit that moves
// a set replaces it whole through its own route after the patch.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { WasteFraction } from "@waste/contracts/catalogue"
import type { Project } from "@waste/contracts/organisation"
import {
  ServiceAreaAssignmentCreate,
  ServiceAreaAssignmentPatch,
  ServiceAreaCreate,
  ServiceAreaPatch,
  ServiceAreaPlanningAreasSet,
  ServiceAreaWasteFractionsSet,
  type ServiceArea,
  type ServiceAreaAssignment,
  type ServiceAreaCreated,
} from "@waste/contracts/service-areas"

import { FIXTURE_COMPANY_ID, getModuleDefinition, type BusinessRecord } from "../../data/business-modules"
import { assignmentsOf, SERVICE_AREAS_MODULE } from "../../data/provider-money"
import { problemSentence } from "../problem"
import { NOTHING_RESOLVED, type MappingContext } from "../records/adapter"
import { wasteFractionAdapter } from "../records/master-data"
import { isServerBacked, SERVER_MODULE_KEYS } from "../records/modules"
import { projectAdapter } from "../records/organisation"
import { assignmentAdapter, NO_PLANNING_AREA, serviceAreaAdapter, serviceAreasModule } from "../records/service-areas"
import { loaded, loadModule, resolverOver, spellsStatus, writeRecord, type ServerRecordsState } from "../records/server-records"
import { bodyOf, clientOver, json, problem, scripted } from "./scripted-fetch"

const NOW = new Date("2026-09-30T12:00:00Z")
const STAMPS = { createdAt: "2026-09-24T09:00:00.000Z", updatedAt: "2026-09-25T09:30:00.000Z" }
const fixtures = getModuleDefinition(SERVICE_AREAS_MODULE)?.records ?? []

const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays" }
const organic: WasteFraction = { id: "01a0d2a4-a280-7005-8000-000000000002", ...STAMPS, key: "organic", name: "Organic" }
const paper: WasteFraction = { id: "01a0d2a4-a280-7005-8000-000000000003", ...STAMPS, key: "paper", name: "Paper" }
const OSTERBRO = "01a0d2a4-a280-7015-8000-000000000002"
const NORDHAVN = "01a0d2a4-a280-7015-8000-000000000003"
const NORDREN = "01a0d2a4-a280-7004-8000-000000000001"
const CITYHAUL = "01a0d2a4-a280-7004-8000-000000000002"

const area: ServiceArea = {
  id: "01a0d2a4-a280-7090-8000-000000000001",
  ...STAMPS,
  projectId: copenhagen.id,
  code: "CA-Ø-2",
  name: "Østerbro organic and paper",
  boundaryText: "Østerbro, north of Jagtvej",
  notes: null,
  planningAreaIds: [OSTERBRO, NORDHAVN],
  wasteFractionIds: [organic.id, paper.id],
  validFrom: "2026-01-01",
  validTo: "2029-01-01",
}
const held: ServiceAreaAssignment = { id: "01a0d2a4-a280-7091-8000-000000000001", ...STAMPS, projectId: copenhagen.id, serviceAreaId: area.id, serviceProviderId: NORDREN, notes: null, validFrom: "2026-01-01", validTo: null }
const before: ServiceAreaAssignment = { ...held, id: "01a0d2a4-a280-7091-8000-000000000000", serviceProviderId: CITYHAUL, validFrom: "2025-01-01", validTo: "2026-01-01" }

const bare = (records: readonly BusinessRecord[] = []): MappingContext => ({ fixtures: records, resolve: NOTHING_RESOLVED, companyRecordId: FIXTURE_COMPANY_ID, now: NOW })
const moduleOf = (records: BusinessRecord[], ids: string[]) => loaded({ records, serverIds: new Map(records.map((record, index) => [record.id, ids[index]])) }, 1)
const projectRecord = projectAdapter.toRecord(copenhagen, bare())
const fractionRecords = [organic, paper].map((fraction) => wasteFractionAdapter.toRecord(fraction, bare()))
const plain = (id: string, name: string, recordKind: string): BusinessRecord => ({ ...projectRecord, id, name, recordKind, submittedValues: {} })
const areaRecords = [plain(`area-${OSTERBRO}`, "Østerbro Zone 2", "Planning area"), plain(`area-${NORDHAVN}`, "Nordhavn", "Planning area")]
const providerRecords = [plain(`service-provider-${NORDREN}`, "NordRen ApS", "Service provider"), plain(`service-provider-${CITYHAUL}`, "CityHaul A/S", "Service provider")]
const state: ServerRecordsState = new Map([
  ["configure.organization", moduleOf([projectRecord], [copenhagen.id])],
  ["configure.master", moduleOf(fractionRecords, [organic.id, paper.id])],
  ["configure.areas", moduleOf(areaRecords, [OSTERBRO, NORDHAVN])],
  ["service-providers.service-providers", moduleOf(providerRecords, [NORDREN, CITYHAUL])],
])
const context = (at: ServerRecordsState = state): MappingContext => ({ ...bare(fixtures), resolve: resolverOver(at) })

/** The module as the store holds it once loaded: the area, then its assignments. */
function withAreas(at: ServerRecordsState = state): ServerRecordsState {
  const areaRecord = serviceAreaAdapter.toRecord({ ...area, assignments: [before, held] }, context(at))
  const listed = new Map([...at, ["service-providers.service-areas", moduleOf([areaRecord], [area.id])]])
  const assignmentRecords = [before, held].map((assignment) => assignmentAdapter.toRecord(assignment, context(listed)))
  return new Map([...at, ["service-providers.service-areas", moduleOf([areaRecord, ...assignmentRecords], [area.id, before.id, held.id])]])
}
const loadedState = withAreas()

const pageOf = (items: unknown[]) => json({ items, nextCursor: null })
/** The id an award made this session was minted under. */
const MINTED = "service-areas-service-area-1700000000000"

function made(id: string, recordKind: string, values: Record<string, string>): BusinessRecord {
  return { id, name: values.areaName ?? id, context: "", status: "Active", owner: "", value: "", updated: "Now", description: "", facts: {}, related: [], source: "Waste API", freshness: "Now", companyId: FIXTURE_COMPANY_ID, projectIds: ["project-copenhagen"], recordKind, submittedValues: values }
}

const AREA_FORM = {
  projectId: projectRecord.id,
  areaCode: "CA-VW-1",
  areaName: "Vesterbro west award",
  boundary: "Drawn on Map Planning · 12 containers across 4 properties",
  notes: "",
  zoneIds: `area-${OSTERBRO},area-${NORDHAVN}`,
  wasteFractionIds: `fraction-${organic.id}`,
  serviceProviderId: `service-provider-${NORDREN}`,
  validFrom: "2026-10-01",
  validTo: "2027-09-30",
}

describe("the service areas module", () => {
  test("is switched after the organisation, the providers, the planning areas and the master data an award names, ahead of the schemes (it names no route)", () => {
    assert.ok(isServerBacked("service-providers", "service-areas"))
    const at = SERVER_MODULE_KEYS.indexOf("service-providers.service-areas")
    for (const before of ["configure.organization", "service-providers.service-providers", "configure.areas", "configure.master"]) assert.ok(SERVER_MODULE_KEYS.indexOf(before) < at, before)
    assert.ok(at < SERVER_MODULE_KEYS.indexOf("route-studio.schemes"))
    assert.deepEqual(serviceAreasModule.resources, [serviceAreaAdapter, assignmentAdapter])
  })

  test("reads the areas and the assignments once each, the areas holding the provider of the one in force, the assignments its second kind", async () => {
    const { fetch, calls } = scripted([() => pageOf([area]), () => pageOf([before, held])])
    const result = await loadModule(clientOver(fetch), serviceAreasModule, { fixtures, state, now: NOW })
    assert.deepEqual(calls.map((call) => call.url), ["http://api.test/service-areas?limit=200", "http://api.test/service-area-assignments?limit=200"], "one read of the assignments serves both kinds")
    assert.deepEqual(result.records.map((record) => record.id), [`service-area-${area.id}`, `assignment-${before.id}`, `assignment-${held.id}`])
    assert.equal(result.records[0].facts["Service provider"], "NordRen ApS")
  })

  test("read again over an award made this session, files its assignments under the id it was made under, the one the read keeps (#240)", async () => {
    const minted = { ...serviceAreaAdapter.toRecord({ ...area, assignments: [held] }, context()), id: MINTED }
    const before_ = new Map([...state, ["service-providers.service-areas", moduleOf([minted], [area.id])]])
    const { fetch } = scripted([() => pageOf([area]), () => pageOf([held])])
    const result = await loadModule(clientOver(fetch), serviceAreasModule, { fixtures, state: before_, now: NOW })
    assert.equal(result.records[0].id, MINTED)
    assert.equal(result.records[1].submittedValues?.serviceAreaId, MINTED, "never the adapter's id")
  })

  test("an award made this session and edited holds its provider: an answer without its assignments finds them by the award's server id", () => {
    const minted = { ...serviceAreaAdapter.toRecord({ ...area, assignments: [held] }, context()), id: MINTED }
    const listed = new Map([...state, ["service-providers.service-areas", moduleOf([minted], [area.id])]])
    const assignmentRecord = assignmentAdapter.toRecord(held, context(listed))
    const at = new Map([...state, ["service-providers.service-areas", moduleOf([minted, assignmentRecord], [area.id, held.id])]])
    // A patch's answer is the bare area; the holder comes from the assignments the store holds under the session's id.
    assert.equal(serviceAreaAdapter.toRecord(area, context(at)).facts["Service provider"], "NordRen ApS")
  })

  test("shows an area as the set of planning areas and fractions it covers, its period a reading of the day, its fields the form's", () => {
    const record = loadedState.get("service-providers.service-areas")!.records[0]
    assert.equal(record.name, "Østerbro organic and paper")
    assert.equal(record.context, "CA-Ø-2 · Organic, Paper")
    assert.equal(record.status, "Active")
    assert.equal(record.recordKind, "Service area")
    assert.equal(record.facts["Planning areas"], "Østerbro Zone 2 · Nordhavn")
    assert.equal(record.facts["Service provider"], "NordRen ApS")
    assert.equal(record.serviceProviderId, `service-provider-${NORDREN}`, "the holder in force, as the provider page lists its areas by")
    assert.equal(record.facts["Valid to"], "2028-12-31")
    assert.equal(record.submittedValues?.zoneIds, `area-${OSTERBRO},area-${NORDHAVN}`, "the planning areas coverage reads (map-planning/coverage.ts)")
    assert.equal(record.submittedValues?.wasteFractionIds, `fraction-${organic.id},fraction-${paper.id}`)
    assert.equal(record.submittedValues?.boundaryPolygon, undefined, "no drawn polygon: the area is its planning areas")
    assert.ok(!spellsStatus(serviceAreasModule, record, "Expired"), "no status on the wire")
  })

  test("makes the create body from the Pilot's form: the sets by server id, the first assignment from the provider picked", () => {
    const body = serviceAreaAdapter.toCreateBody!(made("service-areas-service-area-1", "Service area", AREA_FORM), context(loadedState))
    assert.deepEqual(body, {
      projectId: copenhagen.id,
      code: "CA-VW-1",
      name: "Vesterbro west award",
      boundaryText: "Drawn on Map Planning · 12 containers across 4 properties",
      planningAreaIds: [OSTERBRO, NORDHAVN],
      wasteFractionIds: [organic.id],
      validFrom: "2026-10-01",
      validTo: "2027-10-01",
      assignment: { serviceProviderId: NORDREN },
    })
    assert.ok(ServiceAreaCreate.safeParse(body).success)
    const refusalOf = (values: Record<string, string>) => serviceAreaAdapter.toCreateBody!(made("service-areas-service-area-1", "Service area", { ...AREA_FORM, ...values }), context(loadedState))
    assert.deepEqual(refusalOf({ zoneIds: "" }), { path: "zoneIds", message: NO_PLANNING_AREA })
    assert.deepEqual(refusalOf({ zoneIds: "area-unknown" }), { path: "zoneIds", message: "Pick planning areas the API holds" })
    assert.deepEqual(refusalOf({ wasteFractionIds: "fraction-glass" }), { path: "wasteFractionIds", message: "Pick waste fractions the API holds" })
    assert.deepEqual(refusalOf({ serviceProviderId: "service-provider-nobody" }), { path: "serviceProviderId", message: "Pick a service provider the API holds" })
    const unassigned = serviceAreaAdapter.toCreateBody!(made("service-areas-service-area-1", "Service area", { ...AREA_FORM, serviceProviderId: "" }), context(loadedState)) as Record<string, unknown>
    assert.equal(unassigned.assignment, undefined, "an area may be registered first and assigned later")
  })

  test("maps the create's answer, the first assignment beside it, under the provider it names", () => {
    const created: ServiceAreaCreated = { ...area, id: "01a0d2a4-a280-7090-8000-000000000099", assignment: { ...held, id: "01a0d2a4-a280-7091-8000-000000000099", serviceAreaId: "01a0d2a4-a280-7090-8000-000000000099" } }
    const record = serviceAreaAdapter.toRecord(created, context(loadedState))
    assert.equal(record.facts["Service provider"], "NordRen ApS")
  })

  test("patches the name, the text, the notes and the period, then replaces a moved set whole through its own route; the code and the project stay", async () => {
    const current = loadedState.get("service-providers.service-areas")!
    const record = current.records[0]
    const edited = { ...record, submittedValues: { ...record.submittedValues, areaName: "Østerbro award", validTo: "", zoneIds: `area-${OSTERBRO}` } }
    const body = serviceAreaAdapter.toPatchBody(record, edited, context(loadedState)) as { patch?: unknown; planningAreaIds?: unknown; wasteFractionIds?: unknown }
    assert.deepEqual(body, { patch: { name: "Østerbro award", validTo: null }, planningAreaIds: { ids: [OSTERBRO] } })
    assert.ok(ServiceAreaPatch.safeParse(body.patch).success)
    assert.ok(ServiceAreaPlanningAreasSet.safeParse(body.planningAreaIds).success)
    assert.deepEqual(serviceAreaAdapter.toPatchBody(record, { ...record, submittedValues: { ...record.submittedValues, areaCode: "CA-Ø-3" } }, context(loadedState)), { path: "areaCode", message: "An award keeps its code: the contract spells it" })
    assert.deepEqual(serviceAreaAdapter.toPatchBody(record, { ...record, submittedValues: { ...record.submittedValues, zoneIds: "" } }, context(loadedState)), { path: "zoneIds", message: NO_PLANNING_AREA })
    const fractionsOnly = serviceAreaAdapter.toPatchBody(record, { ...record, submittedValues: { ...record.submittedValues, wasteFractionIds: `fraction-${paper.id}` } }, context(loadedState)) as { wasteFractionIds?: unknown }
    assert.deepEqual(fractionsOnly, { wasteFractionIds: { ids: [paper.id] } })
    assert.ok(ServiceAreaWasteFractionsSet.safeParse(fractionsOnly.wasteFractionIds).success)

    const { fetch, calls } = scripted([() => json({ ...area, name: "Østerbro award", validTo: null }), () => problem(409, "Planning area Nordhavn is named by a route scheme of this award")])
    const outcome = await writeRecord(clientOver(fetch), serviceAreasModule, current, edited, { fixtures, state: loadedState, now: NOW })
    assert.deepEqual(calls.map((call) => [call.init.method, call.url]), [["PATCH", `http://api.test/service-areas/${area.id}`], ["PUT", `http://api.test/service-areas/${area.id}/planning-areas`]])
    assert.equal(outcome.kind, "refused")
    if (outcome.kind === "refused") {
      assert.equal(problemSentence(outcome.problem), "Planning area Nordhavn is named by a route scheme of this award")
      assert.equal(outcome.record?.name, "Østerbro award", "the patch landed: the row is shown as the server holds it")
    }
  })

  test("adds an assignment under its area and moves only its notes and its end: a transfer is an end and another assignment", async () => {
    const record = loadedState.get("service-providers.service-areas")!.records[2]
    assert.equal(record.name, "CA-Ø-2 · NordRen ApS")
    assert.equal(record.status, "Active")
    const made_ = made("service-areas-assignment-1", "Service area assignment", { serviceAreaId: `service-area-${area.id}`, serviceProviderId: `service-provider-${CITYHAUL}`, notes: "Interim", validFrom: "2028-06-01", validTo: "" })
    const body = assignmentAdapter.toCreateBody!(made_, context(loadedState)) as { serviceAreaId: string; body: unknown }
    assert.equal(body.serviceAreaId, area.id)
    assert.deepEqual(body.body, { serviceProviderId: CITYHAUL, notes: "Interim", validFrom: "2028-06-01", validTo: "2029-01-01" }, "left open, it ends with its award, as the form's hint says")
    const given = assignmentAdapter.toCreateBody!({ ...made_, submittedValues: { ...made_.submittedValues, validTo: "2028-09-30" } }, context(loadedState)) as { body: { validTo?: string } }
    assert.equal(given.body.validTo, "2028-10-01", "an end given is the assignment's own")
    assert.ok(ServiceAreaAssignmentCreate.safeParse(body.body).success)
    const ended = assignmentAdapter.toPatchBody(record, { ...record, submittedValues: { ...record.submittedValues, validTo: "2028-12-31" } }, context(loadedState))
    assert.deepEqual(ended, { validTo: "2029-01-01" })
    assert.ok(ServiceAreaAssignmentPatch.safeParse(ended).success)
    assert.deepEqual(assignmentAdapter.toPatchBody(record, { ...record, submittedValues: { ...record.submittedValues, serviceProviderId: `service-provider-${CITYHAUL}` } }, context(loadedState)), { path: "serviceProviderId", message: "A transfer ends this assignment and adds another" })

    const { fetch, calls } = scripted([() => json({ ...held, id: "01a0d2a4-a280-7091-8000-000000000098", serviceProviderId: CITYHAUL, notes: "Interim", validFrom: "2029-01-01" }, 201, { location: "/service-area-assignments/x" })])
    const outcome = await writeRecord(clientOver(fetch), serviceAreasModule, loadedState.get("service-providers.service-areas")!, made_, { fixtures, state: loadedState, now: NOW })
    assert.equal(calls[0].url, `http://api.test/service-areas/${area.id}/assignments`)
    assert.equal(outcome.kind, "created")
    assert.ok(bodyOf(calls[0]))
  })

  test("names the provider an award not yet in force is awarded to: its first upcoming holder", () => {
    const upcoming = { ...area, validFrom: "2027-01-01", validTo: null }
    const record = serviceAreaAdapter.toRecord({ ...upcoming, assignments: [{ ...held, validFrom: "2027-01-01", validTo: null }] }, context())
    assert.equal(record.facts["Service provider"], "NordRen ApS")
    assert.equal(record.serviceProviderId, `service-provider-${NORDREN}`)
    const ended = serviceAreaAdapter.toRecord({ ...area, assignments: [before] }, context())
    assert.equal(ended.facts["Service provider"], undefined, "an ended holder holds nothing")
  })

  test("lists an area's assignments, the first holder first, for its details", () => {
    const records = loadedState.get("service-providers.service-areas")?.records ?? []
    const areaRecord = records.find((record) => record.recordKind === "Service area")!
    assert.deepEqual(assignmentsOf(records, areaRecord.id).map((record) => record.id), [`assignment-${before.id}`, `assignment-${held.id}`])
    assert.deepEqual(assignmentsOf([...records].reverse(), areaRecord.id).map((record) => record.id), [`assignment-${before.id}`, `assignment-${held.id}`], "by the day each starts, whatever the order read")
    assert.deepEqual(assignmentsOf(records, "service-area-other"), [])
  })
})
