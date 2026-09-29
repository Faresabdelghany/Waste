// Planning configuration on the adapter (#175, slice 1 of #81): a planning
// area with the boundary version in force becomes the record the Areas &
// Zones pane and the map read, a calendar with its holidays the record the
// Collection calendars pane, the wizard and generation read; the records the
// two panes write become the bodies the API's contracts accept, held here
// against the contracts' own zod schemas; and the two writes go out through
// the store's seam over a scripted `fetch`, the API's refusals coming back as
// its sentences.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { CollectionCalendarCreate, CollectionCalendarHolidaysSet, CollectionCalendarPatch, type CollectionCalendar } from "@waste/contracts/collection-calendars"
import type { Company, Project } from "@waste/contracts/organisation"
import { PlanningAreaBoundaryCreate, PlanningAreaBoundaryPatch, PlanningAreaCreate, PlanningAreaPatch, type PlanningArea, type PlanningAreaBoundary } from "@waste/contracts/planning-areas"
import { calendarFromRecord } from "@waste/domain/route-schemes/calendar"
import { holidayNamesFor } from "@waste/domain/route-schemes/holiday-names"
import { resolveProjectCalendar } from "@waste/domain/route-schemes/project-calendar"

import { FIXTURE_COMPANY_ID, FIXTURE_PROJECT_IDS, getModuleDefinition, type BusinessRecord } from "../../data/business-modules"
import { COLLECTION_CALENDARS_MODULE, createCollectionCalendarRecord } from "../../data/collection-calendars"
import { createPlanningAreaRecord, PLANNING_AREAS_MODULE, planningAreaFormValues, planningAreaPurpose, planningAreaTableRow } from "../../data/planning-areas"
import { problemSentence } from "../problem"
import { NOTHING_RESOLVED, type MappingContext, type Resolver } from "../records/adapter"
import { isServerBacked, SERVER_MODULE_KEYS } from "../records/modules"
import { companyAdapter, projectAdapter } from "../records/organisation"
import { collectionCalendarAdapter, collectionCalendarsModule, geometryOfText, NOT_A_POLYGON, parsePolygonText, planningAreaAdapter, planningAreasModule, type PlanningAreaResource } from "../records/planning"
import { loaded, resolverOver, writeRecord, type ServerRecordsState } from "../records/server-records"
import { bodyOf, clientOver, json, problem, scripted } from "./scripted-fetch"

const NOW = new Date("2026-09-30T12:00:00Z")
const STAMPS = { createdAt: "2026-09-24T09:00:00.000Z", updatedAt: "2026-09-25T09:30:00.000Z" }

const fixturesOf = (moduleId: string) => {
  const module = getModuleDefinition({ workspaceId: "configure", moduleId })
  if (!module) throw new Error(`no module configure.${moduleId}`)
  return module.records
}
const areaFixtures = fixturesOf("areas")
const calendarFixtures = fixturesOf("calendars")
const organisationFixtures = fixturesOf("organization")

const context = (fixtures: readonly BusinessRecord[], resolve: Resolver = NOTHING_RESOLVED): MappingContext => ({ fixtures, resolve, companyRecordId: FIXTURE_COMPANY_ID, now: NOW })

// The seeded demo company as the API answers it (packages/db/src/seed).
const company: Company = { id: "01a0d2a4-a280-7001-8000-000000000001", ...STAMPS, name: "Kystbyen Renovation", legalName: "Kystbyen Renovation A/S", registrationNumber: "12345678", country: "DK", status: "active" }
const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays" }
const harbor: Project = { ...copenhagen, id: "01a0d2a4-a280-7002-8000-000000000002", name: "Harbor Commercial", kind: "Business unit", status: "onboarding", holidayList: null }

/** A small closed ring around Indre By, as the column stores one. */
const RING: [number, number][] = [
  [12.5683, 55.6761],
  [12.5793, 55.6761],
  [12.5793, 55.6831],
  [12.5683, 55.6831],
  [12.5683, 55.6761],
]
const polygon = { type: "Polygon" as const, coordinates: [RING] }

const indreby: PlanningArea = { id: "01a0d2a4-a280-7016-8000-000000000001", ...STAMPS, projectId: copenhagen.id, code: "OP-CEN-01", name: "Indre By Operations", purpose: "route-planning" }
const indrebyBoundary: PlanningAreaBoundary = { id: "01a0d2a4-a280-7017-8000-000000000001", ...STAMPS, projectId: copenhagen.id, planningAreaId: indreby.id, boundary: polygon, validFrom: "2026-01-01", validTo: null }
const nordhavn: PlanningArea = { ...indreby, id: "01a0d2a4-a280-7016-8000-000000000004", projectId: harbor.id, code: "OP-HAR-01", name: "Nordhavn Harbor Area" }
const valby: PlanningArea = { ...indreby, id: "019995e0-0000-7000-8000-0000000000e1", code: "OP-VAL-01", name: "Valby Test Area", purpose: "notification" }
const valbyExpired: PlanningAreaBoundary = { ...indrebyBoundary, id: "019995e0-0000-7000-8000-0000000000e2", planningAreaId: valby.id, validFrom: "2025-01-01", validTo: "2026-01-01" }
const valbyUpcoming: PlanningAreaBoundary = { ...indrebyBoundary, id: "019995e0-0000-7000-8000-0000000000e3", planningAreaId: valby.id, validFrom: "2027-01-01", validTo: null }

const central2026: CollectionCalendar = {
  id: "01a0d2a4-a280-7018-8000-000000000001",
  ...STAMPS,
  projectId: copenhagen.id,
  name: "Copenhagen Central 2026",
  validFrom: "2026-01-01",
  validTo: "2027-01-01",
  holidays: [
    { day: "2026-01-01", name: "Nytårsdag" },
    { day: "2026-04-02", name: "Skærtorsdag" },
    { day: "2026-06-05", name: "Grundlovsdag" },
    { day: "2026-12-25", name: null },
  ],
}
const harborCalendar: CollectionCalendar = { ...central2026, id: "01a0d2a4-a280-7018-8000-000000000003", projectId: harbor.id, name: "Harbor Offices service calendar", validFrom: "2026-09-01", validTo: "2027-09-01", holidays: [] }

// The organisation module as the store has it when the planning modules load.
const companyRecord = companyAdapter.toRecord(company, context(organisationFixtures))
const copenhagenRecord = projectAdapter.toRecord(copenhagen, context(organisationFixtures))
const harborRecord = projectAdapter.toRecord(harbor, context(organisationFixtures))
const state: ServerRecordsState = new Map([
  ["configure.organization", loaded({ records: [companyRecord, copenhagenRecord, harborRecord], serverIds: new Map([[companyRecord.id, company.id], [copenhagenRecord.id, copenhagen.id], [harborRecord.id, harbor.id]]) }, 1)],
])
const resolve = resolverOver(state)
const areaContext = (): MappingContext => context(areaFixtures, resolve)
const calendarContext = (): MappingContext => context(calendarFixtures, resolve)
const lookups = { projectName: (id: string) => (id === FIXTURE_PROJECT_IDS.copenhagen ? "Copenhagen Central" : undefined), recordName: () => undefined }

const withBoundaries = (area: PlanningArea, boundaries: PlanningAreaBoundary[]): PlanningAreaResource => ({ ...area, boundaries })

describe("a planning area read", () => {
  test("lists the areas and every boundary version in two reads, each version filed under its area", async () => {
    const { fetch, calls } = scripted([
      () => json({ items: [indreby, nordhavn, valby], nextCursor: null }),
      () => json({ items: [indrebyBoundary, valbyExpired, valbyUpcoming], nextCursor: null }),
    ])
    const areas = (await planningAreaAdapter.list?.(clientOver(fetch))) ?? []
    assert.deepEqual(calls.map((call) => call.url), ["http://api.test/planning-areas?limit=200", "http://api.test/planning-area-boundaries?limit=200"])
    assert.deepEqual(areas.map((area) => [area.code, area.boundaries.map((version) => version.id)]), [
      ["OP-CEN-01", [indrebyBoundary.id]],
      ["OP-HAR-01", []],
      ["OP-VAL-01", [valbyExpired.id, valbyUpcoming.id]],
    ])
  })

  test("a seeded area is its fixture record, with the version in force as its geometry, its dates and its Active status", () => {
    const record = planningAreaAdapter.toRecord(withBoundaries(indreby, [indrebyBoundary]), areaContext())
    assert.equal(record.id, "area-indreby")
    assert.equal(record.name, "Indre By Operations")
    assert.equal(record.context, "Route planning · Copenhagen Central")
    assert.equal(record.status, "Active")
    assert.equal(record.facts.Code, "OP-CEN-01")
    assert.equal(record.facts["Area purpose"], "Route planning")
    assert.equal(record.facts["Effective from"], "2026-01-01")
    assert.equal(record.facts["Effective to"], undefined)
    assert.equal(record.value, "—", "nothing measures coverage; the fixture's figure is not the API's")
    assert.equal(record.owner, "Operations Admin", "presentation the wire does not carry is the fixture's")
    assert.deepEqual(record.projectIds, [FIXTURE_PROJECT_IDS.copenhagen])
    assert.equal(record.companyId, FIXTURE_COMPANY_ID)
    assert.equal(record.recordKind, "Operational Planning Area version")
    assert.equal(planningAreaPurpose(record), "route-planning")
    assert.equal(record.submittedValues?.projectId, FIXTURE_PROJECT_IDS.copenhagen)
    assert.equal(record.submittedValues?.areaCode, "OP-CEN-01")
    assert.equal(record.submittedValues?.effectiveFrom, "2026-01-01")
    assert.equal(record.submittedValues?.boundaryId, indrebyBoundary.id)
    assert.deepEqual(JSON.parse(String(record.submittedValues?.geometry)), polygon)
    const row = planningAreaTableRow(record, lookups)
    assert.equal(row.code, "OP-CEN-01")
    assert.equal(row.purpose, "Route planning")
    assert.equal(row.project, "Copenhagen Central")
    assert.equal(row.effective, "2026-01-01 →")
    assert.equal(planningAreaFormValues(record, "2026-09-30").effectiveFrom, "2026-01-01", "the edit form seeds from the version")
  })

  test("the status is a reading of the versions against the day: none is Draft, only an upcoming one Upcoming, only an ended one Expired; the dates are the version's, the end as the last day in force", () => {
    const undrawn = planningAreaAdapter.toRecord(withBoundaries(nordhavn, []), areaContext())
    assert.equal(undrawn.id, "area-harbor-1")
    assert.equal(undrawn.status, "Draft")
    assert.equal(undrawn.submittedValues?.geometry, undefined)
    assert.equal(undrawn.facts["Effective from"], undefined)

    const upcoming = planningAreaAdapter.toRecord(withBoundaries(valby, [valbyExpired, valbyUpcoming]), areaContext())
    assert.equal(upcoming.id, `area-${valby.id}`, "a row no fixture names is area-<uuid>")
    assert.equal(upcoming.status, "Upcoming")
    assert.equal(upcoming.submittedValues?.effectiveFrom, "2027-01-01")
    assert.equal(upcoming.submittedValues?.boundaryId, valbyUpcoming.id)
    assert.equal(upcoming.facts["Area purpose"], "Notification zone")

    const expired = planningAreaAdapter.toRecord(withBoundaries(valby, [valbyExpired]), areaContext())
    assert.equal(expired.status, "Expired")
    assert.equal(expired.submittedValues?.effectiveTo, "2025-12-31", "the wire's first day out of force is the day after the last day in")
    assert.equal(expired.facts["Effective to"], "2025-12-31")
  })

  test("a version in force on the day wins over an ended and an upcoming one", () => {
    const inForce: PlanningAreaBoundary = { ...indrebyBoundary, id: "019995e0-0000-7000-8000-0000000000e4", planningAreaId: valby.id, validFrom: "2026-01-01", validTo: "2027-01-01" }
    const record = planningAreaAdapter.toRecord(withBoundaries(valby, [valbyExpired, inForce, valbyUpcoming]), areaContext())
    assert.equal(record.status, "Active")
    assert.equal(record.submittedValues?.boundaryId, inForce.id)
    assert.equal(record.submittedValues?.effectiveTo, "2026-12-31")
  })

  test("only the version in force lends the record its geometry: an upcoming or ended version keeps its dates and id for the form, and the map has nothing to draw", () => {
    const upcoming = planningAreaAdapter.toRecord(withBoundaries(valby, [valbyUpcoming]), areaContext())
    assert.equal(upcoming.submittedValues?.geometry, undefined)
    assert.equal(upcoming.submittedValues?.boundaryId, valbyUpcoming.id)
    const expired = planningAreaAdapter.toRecord(withBoundaries(valby, [valbyExpired]), areaContext())
    assert.equal(expired.submittedValues?.geometry, undefined)
    assert.equal(expired.submittedValues?.boundaryId, valbyExpired.id)
    assert.equal(planningAreaAdapter.toRecord(withBoundaries(indreby, [indrebyBoundary]), areaContext()).submittedValues?.geometryConfirmed, true, "a drawn version is the form's confirmation")
  })

  test("the day is read in the project's own timezone, so the version in force is the project's and not the browser's", () => {
    const lateEvening = context(areaFixtures, resolve)
    lateEvening.now = new Date("2026-09-30T23:30:00Z")
    const fromOctober: PlanningAreaBoundary = { ...indrebyBoundary, validFrom: "2026-10-01" }
    // Copenhagen is already on 1 October at 23:30Z; the record reads the version as in force.
    assert.equal(planningAreaAdapter.toRecord(withBoundaries(indreby, [fromOctober]), lateEvening).status, "Active")
    const newYorkProject = projectAdapter.toRecord({ ...harbor, timezone: "America/New_York" }, context(organisationFixtures))
    const newYork: ServerRecordsState = new Map([["configure.organization", loaded({ records: [newYorkProject], serverIds: new Map([[newYorkProject.id, harbor.id]]) }, 1)]])
    const evening = context(areaFixtures, resolverOver(newYork))
    evening.now = new Date("2026-09-30T23:30:00Z")
    assert.equal(planningAreaAdapter.toRecord(withBoundaries(nordhavn, [{ ...fromOctober, projectId: harbor.id, planningAreaId: nordhavn.id }]), evening).status, "Upcoming")
  })

  test("a seeded area is its fixture by the reference it quotes, so a renamed area keeps the id the fixtures of other modules name", () => {
    const renamed = planningAreaAdapter.toRecord(withBoundaries({ ...indreby, name: "Indre By" }, [indrebyBoundary]), areaContext())
    assert.equal(renamed.id, "area-indreby")
    assert.equal(renamed.name, "Indre By")
  })

  test("an area has no status on the wire: the adapter lists none and every move is refused before the API", () => {
    assert.equal(planningAreaAdapter.statuses, undefined)
  })
})

describe("the polygon a form's geometry text spells", () => {
  test("a GeoJSON Polygon, a Feature around one, a list of [lng, lat] pairs and a list of {lng, lat} spots are one closed flat ring; anything else is no polygon", () => {
    assert.deepEqual(parsePolygonText(JSON.stringify(polygon)), polygon)
    assert.deepEqual(parsePolygonText(JSON.stringify({ type: "Feature", geometry: polygon, properties: {} })), polygon)
    const open = RING.slice(0, 4)
    assert.deepEqual(parsePolygonText(JSON.stringify(open)), polygon, "an unclosed ring is closed here, as the contracts say the web adapter does")
    assert.deepEqual(parsePolygonText(JSON.stringify(open.map(([lng, lat]) => ({ lng, lat })))), polygon)
    assert.deepEqual(parsePolygonText(JSON.stringify([[12.5683123456789, 55.6761987654321], [12.58, 55.6761], [12.58, 55.6831]]))?.coordinates[0][0], [12.568312, 55.676199], "six decimals, the decimetre the Registry's points keep")
    assert.equal(parsePolygonText("north of the river, drawn later"), undefined)
    assert.equal(parsePolygonText(JSON.stringify([[12.5, 55.6], [12.6, 55.6]])), undefined, "two spots enclose nothing")
    assert.equal(parsePolygonText(""), undefined)
  })

  test("a polygon's holes travel with it, and JSON that spells no polygon is told apart from a note", () => {
    const hole: [number, number][] = [
      [12.572, 55.678],
      [12.575, 55.678],
      [12.575, 55.681],
      [12.572, 55.681],
      [12.572, 55.678],
    ]
    assert.deepEqual(parsePolygonText(JSON.stringify({ type: "Polygon", coordinates: [RING, hole] })), { type: "Polygon", coordinates: [RING, hole] })
    assert.deepEqual(geometryOfText("north of the river"), { kind: "note" })
    assert.deepEqual(geometryOfText(undefined), { kind: "none" })
    assert.equal(geometryOfText(JSON.stringify({ type: "FeatureCollection", features: [] })).kind, "malformed")
    assert.equal(geometryOfText(JSON.stringify({ type: "MultiPolygon", coordinates: [[RING]] })).kind, "malformed")
    assert.equal(geometryOfText(JSON.stringify([[12.5, "55.6"], [12.6, 55.6], [12.6, 55.7]])).kind, "malformed")
    assert.equal(geometryOfText(JSON.stringify(polygon)).kind, "polygon")
  })
})

describe("the record the Areas & Zones pane writes", () => {
  const values: Record<string, string> = { areaName: "Valby Test Area", areaCode: "OP-VAL-01", projectId: FIXTURE_PROJECT_IDS.copenhagen, purpose: "notification", effectiveFrom: "2026-10-01", effectiveTo: "2026-12-31", geometry: JSON.stringify(polygon) }
  const made = (overrides: Record<string, string> = {}) => createPlanningAreaRecord({ ...values, ...overrides }, { now: 1_700_000_000_000, actorName: "Olivia Larsen", lookups })

  test("becomes a PlanningAreaCreate the contracts accept: the project by its server id, the code, the purpose, and the first version drawn from the geometry with the end as the first day out of force", () => {
    const record = made()
    assert.ok(planningAreaAdapter.owns(record), "the pane's record kind is the adapter's")
    const body = planningAreaAdapter.toCreateBody?.(record, areaContext())
    assert.deepEqual(body, { projectId: copenhagen.id, code: "OP-VAL-01", name: "Valby Test Area", purpose: "notification", boundary: { boundary: polygon, validFrom: "2026-10-01", validTo: "2027-01-01" } })
    const parsed = PlanningAreaCreate.safeParse(body)
    assert.ok(parsed.success, JSON.stringify(parsed.error))
  })

  test("an open-ended version carries no end; a geometry that is no polygon registers the area undrawn, to be drawn later", () => {
    const openEnded = planningAreaAdapter.toCreateBody?.(made({ effectiveTo: "" }), areaContext()) as { boundary?: { validTo?: string } }
    assert.equal(openEnded.boundary?.validTo, undefined)
    const undrawn = planningAreaAdapter.toCreateBody?.(made({ geometry: "north of the river" }), areaContext())
    assert.deepEqual(undrawn, { projectId: copenhagen.id, code: "OP-VAL-01", name: "Valby Test Area", purpose: "notification" })
    assert.ok(PlanningAreaCreate.safeParse(undrawn).success)
  })

  test("is refused here, naming the field, without a project the store loaded, a reference, a purpose, or a start for a drawn version, and for JSON that is no polygon", () => {
    assert.deepEqual(planningAreaAdapter.toCreateBody?.(made({ projectId: "project-nowhere" }), areaContext()), { path: "projectId", message: "Pick a project" })
    assert.deepEqual(planningAreaAdapter.toCreateBody?.(made({ areaCode: "" }), areaContext()), { path: "areaCode", message: "An area needs a reference" })
    assert.deepEqual(planningAreaAdapter.toCreateBody?.(made({ purpose: "" }), areaContext()), { path: "purpose", message: "Pick a purpose" })
    assert.deepEqual(planningAreaAdapter.toCreateBody?.(made({ effectiveFrom: "" }), areaContext()), { path: "effectiveFrom", message: "A drawn area needs the day its boundary comes into force" })
    assert.deepEqual(planningAreaAdapter.toCreateBody?.(made({ geometry: JSON.stringify({ type: "FeatureCollection", features: [] }) }), areaContext()), { path: "geometry", message: NOT_A_POLYGON })
  })

  test("goes out as POST /planning-areas through the store's write, and the answer is the area with its version, under the record's own kind", async () => {
    const written = { ...valby, boundary: { ...indrebyBoundary, id: "019995e0-0000-7000-8000-0000000000e5", planningAreaId: valby.id, validFrom: "2026-10-01", validTo: "2027-01-01" } }
    const { fetch, calls } = scripted([() => json(written, 201, { location: `/planning-areas/${valby.id}` })])
    const current = loaded({ records: [], serverIds: new Map() }, 1)
    const outcome = await writeRecord(clientOver(fetch), planningAreasModule, current, made(), { fixtures: areaFixtures, state, now: NOW })
    assert.equal(calls[0].url, "http://api.test/planning-areas")
    assert.equal(calls[0].init.method, "POST")
    assert.deepEqual(bodyOf(calls[0]), { projectId: copenhagen.id, code: "OP-VAL-01", name: "Valby Test Area", purpose: "notification", boundary: { boundary: polygon, validFrom: "2026-10-01", validTo: "2027-01-01" } })
    assert.equal(outcome.kind, "created")
    if (outcome.kind !== "created") return
    assert.equal(outcome.serverId, valby.id)
    assert.equal(outcome.record.status, "Upcoming", "drawn from 2026-10-01, read on 2026-09-30")
    assert.equal(outcome.record.submittedValues?.boundaryId, written.boundary.id)
    assert.equal(outcome.record.submittedValues?.effectiveTo, "2026-12-31")
  })

  test("the API's refusals come back as its sentences: a code the project has, and a polygon PostGIS calls invalid, at the path the body carried it", async () => {
    const current = loaded({ records: [], serverIds: new Map() }, 1)
    const taken = scripted([() => problem(409, 'This project already has a planning area coded "OP-VAL-01"')])
    const refused = await writeRecord(clientOver(taken.fetch), planningAreasModule, current, made(), { fixtures: areaFixtures, state, now: NOW })
    assert.equal(refused.kind, "refused")
    if (refused.kind === "refused") assert.equal(problemSentence(refused.problem), 'This project already has a planning area coded "OP-VAL-01"')

    const invalid = scripted([() => problem(400, "The request body is invalid", [{ path: "boundary.boundary", message: "Not a valid polygon" }])])
    const crossed = await writeRecord(clientOver(invalid.fetch), planningAreasModule, current, made(), { fixtures: areaFixtures, state, now: NOW })
    assert.equal(crossed.kind, "refused")
    if (crossed.kind === "refused") assert.equal(problemSentence(crossed.problem), "The request body is invalid — boundary.boundary: Not a valid polygon")
  })
})

describe("an edited planning area", () => {
  const before = planningAreaAdapter.toRecord(withBoundaries(indreby, [indrebyBoundary]), areaContext())
  const edited = (values: Record<string, string>): BusinessRecord => ({ ...before, name: values.areaName ?? before.name, submittedValues: { ...before.submittedValues, ...values } })

  test("a new name or purpose is a PlanningAreaPatch; the reference and the project do not move", () => {
    const body = planningAreaAdapter.toPatchBody(before, edited({ areaName: "Indre By", purpose: "service-operations" }), areaContext())
    assert.deepEqual(body, { area: { name: "Indre By", purpose: "service-operations" } })
    assert.ok(PlanningAreaPatch.safeParse((body as { area: unknown }).area).success)
    assert.deepEqual(planningAreaAdapter.toPatchBody(before, edited({ areaCode: "OP-CEN-02" }), areaContext()), { path: "areaCode", message: "The reference is set once: an area that needs another reference is another area" })
    assert.deepEqual(planningAreaAdapter.toPatchBody(before, edited({ projectId: FIXTURE_PROJECT_IDS.harbor }), areaContext()), { path: "projectId", message: "An area stays in its project" })
    assert.equal(planningAreaAdapter.toPatchBody(before, before, areaContext()), null, "nothing moved, nothing sent")
  })

  test("a redrawn boundary or a moved end is a patch of the version in force; the start does not move", () => {
    const redrawn = JSON.stringify(RING.slice(0, 4).map(([lng, lat]) => [lng + 0.01, lat]))
    const body = planningAreaAdapter.toPatchBody(before, edited({ geometry: redrawn, effectiveTo: "2026-12-31" }), areaContext()) as { boundary: { id: string; patch: unknown } }
    assert.equal(body.boundary.id, indrebyBoundary.id)
    assert.deepEqual(body.boundary.patch, { boundary: parsePolygonText(redrawn), validTo: "2027-01-01" })
    assert.ok(PlanningAreaBoundaryPatch.safeParse(body.boundary.patch).success)
    const reopened = planningAreaAdapter.toPatchBody(planningAreaAdapter.toRecord(withBoundaries(valby, [valbyExpired]), areaContext()), { ...planningAreaAdapter.toRecord(withBoundaries(valby, [valbyExpired]), areaContext()), submittedValues: { ...planningAreaAdapter.toRecord(withBoundaries(valby, [valbyExpired]), areaContext()).submittedValues, effectiveTo: "" } }, areaContext())
    assert.deepEqual(reopened, { boundary: { id: valbyExpired.id, patch: { validTo: null } } }, "a cleared end reopens the version")
    assert.deepEqual(planningAreaAdapter.toPatchBody(before, edited({ effectiveFrom: "2026-02-01" }), areaContext()), { path: "effectiveFrom", message: "A version's start does not move: end this one and draw the next" })
  })

  test("through the store's write, the renamed row keeps its web id, so one server row is one row here", async () => {
    const renamed = { ...indreby, name: "Indre By" }
    const { fetch } = scripted([() => json(renamed), () => json({ items: [indrebyBoundary], nextCursor: null })])
    const current = loaded({ records: [before], serverIds: new Map([[before.id, indreby.id]]) }, 1)
    const outcome = await writeRecord(clientOver(fetch), planningAreasModule, current, edited({ areaName: "Indre By" }), { fixtures: areaFixtures, state, now: NOW })
    assert.equal(outcome.kind, "updated")
    if (outcome.kind !== "updated") return
    assert.equal(outcome.record.id, before.id)
    assert.equal(outcome.record.name, "Indre By")
  })

  test("on an area whose version has ended, a new polygon and a new start are the next version, never a patch of the ended one", () => {
    const ended = planningAreaAdapter.toRecord(withBoundaries(valby, [valbyExpired]), areaContext())
    const drawn: BusinessRecord = { ...ended, submittedValues: { ...ended.submittedValues, geometry: JSON.stringify(polygon), effectiveFrom: "2026-10-01" } }
    assert.deepEqual(planningAreaAdapter.toPatchBody(ended, drawn, areaContext()), { boundary: { create: { boundary: polygon, validFrom: "2026-10-01" } } })
    const sameStart: BusinessRecord = { ...ended, submittedValues: { ...ended.submittedValues, geometry: JSON.stringify(polygon) } }
    assert.deepEqual(planningAreaAdapter.toPatchBody(ended, sameStart, areaContext()), { path: "effectiveFrom", message: "This version has ended: give the day the next one comes into force" })
    const malformed: BusinessRecord = { ...before, submittedValues: { ...before.submittedValues, geometry: JSON.stringify({ type: "FeatureCollection", features: [] }) } }
    assert.deepEqual(planningAreaAdapter.toPatchBody(before, malformed, areaContext()), { path: "geometry", message: NOT_A_POLYGON })
  })

  test("a first drawing on an area registered undrawn is a new version", () => {
    const undrawn = planningAreaAdapter.toRecord(withBoundaries(nordhavn, []), areaContext())
    const drawn: BusinessRecord = { ...undrawn, submittedValues: { ...undrawn.submittedValues, geometry: JSON.stringify(polygon), effectiveFrom: "2026-10-01" } }
    const body = planningAreaAdapter.toPatchBody(undrawn, drawn, areaContext()) as { boundary: { create: unknown } }
    assert.deepEqual(body, { boundary: { create: { boundary: polygon, validFrom: "2026-10-01" } } })
    assert.ok(PlanningAreaBoundaryCreate.safeParse(body.boundary.create).success)
    assert.deepEqual(planningAreaAdapter.toPatchBody(undrawn, { ...drawn, submittedValues: { ...drawn.submittedValues, effectiveFrom: "" } }, areaContext()), { path: "effectiveFrom", message: "A drawn area needs the day its boundary comes into force" })
  })

  test("the update sends the version first, the area second, and reads the versions back, so the request most likely to be refused goes before anything is written", async () => {
    const renamed = { ...indreby, name: "Indre By" }
    const { fetch, calls } = scripted([
      () => json(renamed),
      () => json({ items: [indrebyBoundary], nextCursor: null }),
    ])
    const answer = await planningAreaAdapter.update(clientOver(fetch), indreby.id, { area: { name: "Indre By" } })
    assert.deepEqual(calls.map((call) => `${call.init.method} ${call.url}`), [`PATCH http://api.test/planning-areas/${indreby.id}`, `GET http://api.test/planning-areas/${indreby.id}/boundaries?limit=200`])
    assert.deepEqual(bodyOf(calls[0]), { name: "Indre By" })
    assert.equal(answer.name, "Indre By")
    assert.deepEqual(answer.boundaries.map((version) => version.id), [indrebyBoundary.id])

    const ended = { ...indrebyBoundary, validTo: "2027-01-01" }
    const second = scripted([() => json(ended), () => json(renamed), () => json({ items: [ended], nextCursor: null })])
    const answer2 = await planningAreaAdapter.update(clientOver(second.fetch), indreby.id, { area: { name: "Indre By" }, boundary: { id: indrebyBoundary.id, patch: { validTo: "2027-01-01" } } })
    assert.deepEqual(second.calls.map((call) => `${call.init.method} ${call.url}`), [`PATCH http://api.test/planning-area-boundaries/${indrebyBoundary.id}`, `PATCH http://api.test/planning-areas/${indreby.id}`, `GET http://api.test/planning-areas/${indreby.id}/boundaries?limit=200`])
    assert.equal(answer2.boundaries[0].validTo, "2027-01-01")

    const third = scripted([() => json(indrebyBoundary, 201, { location: `/planning-area-boundaries/${indrebyBoundary.id}` }), () => json(indreby), () => json({ items: [indrebyBoundary], nextCursor: null })])
    await planningAreaAdapter.update(clientOver(third.fetch), indreby.id, { boundary: { create: { boundary: polygon, validFrom: "2026-01-01" } } })
    assert.deepEqual(third.calls.map((call) => `${call.init.method} ${call.url}`), [`POST http://api.test/planning-areas/${indreby.id}/boundaries`, `GET http://api.test/planning-areas/${indreby.id}`, `GET http://api.test/planning-areas/${indreby.id}/boundaries?limit=200`])

    const refused = scripted([() => problem(409, "This planning area already has a boundary in force over that period; end it first")])
    await assert.rejects(() => planningAreaAdapter.update(clientOver(refused.fetch), indreby.id, { area: { name: "Indre By" }, boundary: { id: indrebyBoundary.id, patch: { validTo: "2027-01-01" } } }))
    assert.equal(refused.calls.length, 1, "the area's patch is never sent when the version's is refused")
  })
})

describe("a collection calendar read", () => {
  test("is calendar-<uuid>, never the fixture's id, since nothing names a calendar by id: the project's calendars are found by project", () => {
    const record = collectionCalendarAdapter.toRecord(central2026, calendarContext())
    assert.equal(record.id, `calendar-${central2026.id}`)
    assert.equal(record.name, "Copenhagen Central 2026")
    assert.equal(record.status, "Active")
    assert.deepEqual(record.projectIds, [FIXTURE_PROJECT_IDS.copenhagen])
    assert.equal(record.recordKind, "Collection Calendar")
    assert.equal(record.facts.Project, "Copenhagen Central")
    assert.equal(record.facts.Holidays, "4")
    assert.equal(record.facts.Validity, "2026-01-01 – 2026-12-31")
    assert.equal(record.submittedValues?.projectId, FIXTURE_PROJECT_IDS.copenhagen)
    assert.equal(record.submittedValues?.validFrom, "2026-01-01")
    assert.equal(record.submittedValues?.validTo, "2026-12-31", "the last day in force, as the form and the readers spell it")
    assert.equal(record.submittedValues?.holidayDates, "2026-01-01, 2026-04-02, 2026-06-05, 2026-12-25")
    assert.deepEqual(JSON.parse(String(record.submittedValues?.holidayNames)), { "2026-01-01": "Nytårsdag", "2026-04-02": "Skærtorsdag", "2026-06-05": "Grundlovsdag" })
    assert.equal(collectionCalendarAdapter.statuses, undefined)
  })

  test("the domain reads it as it reads a fixture calendar: the dates, the period, and the names carried with the project's list naming the rest", () => {
    const record = collectionCalendarAdapter.toRecord(central2026, calendarContext())
    const calendar = calendarFromRecord(record)
    assert.deepEqual(calendar?.holidayDates, ["2026-01-01", "2026-04-02", "2026-06-05", "2026-12-25"])
    assert.equal(calendar?.validFrom, "2026-01-01")
    assert.equal(calendar?.validTo, "2026-12-31")
    const resolved = resolveProjectCalendar(FIXTURE_PROJECT_IDS.copenhagen, { projects: [copenhagenRecord], calendars: [record] })
    assert.equal(resolved.list?.name, "Danish public holidays")
    assert.equal(resolved.list?.dates.size, 4)
    assert.ok(resolved.list?.dates.has("2026-06-05"))
    assert.ok(resolved.list?.dates.has("2026-12-25"), "a day nobody named is still a holiday")
    const open = collectionCalendarAdapter.toRecord({ ...harborCalendar, validTo: null }, calendarContext())
    assert.equal(open.submittedValues?.validTo, undefined, "an open period has no last day")
    assert.equal(open.facts.Validity, "2026-09-01 – open")
    assert.equal(open.submittedValues?.holidayNames, undefined)
  })
})

describe("the record the Collection calendars pane writes", () => {
  const values = { calendarName: "Copenhagen Central 2028", projectId: FIXTURE_PROJECT_IDS.copenhagen, weekStart: "monday", validFrom: "2028-01-01", validTo: "2028-12-31", timezone: "Europe/Copenhagen", holidayDates: "2028-12-25, 2028-01-01" }
  const made = (overrides: Record<string, string> = {}) => createCollectionCalendarRecord({ ...values, ...overrides }, { now: 1_700_000_000_000, actorName: "Olivia Larsen", lookups })
  const danish = holidayNamesFor("Danish public holidays")

  test("becomes a CollectionCalendarCreate the contracts accept: the project by its server id, the period with its end as the first day out of force, and the holidays by day, named by the project's list where nobody named them", () => {
    const record = made()
    assert.ok(collectionCalendarAdapter.owns(record))
    const body = collectionCalendarAdapter.toCreateBody?.(record, calendarContext())
    assert.deepEqual(body, {
      projectId: copenhagen.id,
      name: "Copenhagen Central 2028",
      validFrom: "2028-01-01",
      validTo: "2029-01-01",
      holidays: [
        { day: "2028-01-01", name: danish("2028-01-01") ?? null },
        { day: "2028-12-25", name: danish("2028-12-25") ?? null },
      ],
    })
    assert.ok(typeof danish("2028-01-01") === "string", "the list names New Year's Day")
    const parsed = CollectionCalendarCreate.safeParse(body)
    assert.ok(parsed.success, JSON.stringify(parsed.error))
  })

  test("a name the Holiday lists pane carried wins over the list's, an open end is no end, and a project without a list leaves the days unnamed", () => {
    const carried = collectionCalendarAdapter.toCreateBody?.(made({ holidayNames: JSON.stringify({ "2028-12-25": "Christmas Day" }), validTo: "" }), calendarContext()) as { validTo?: string; holidays: { day: string; name: string | null }[] }
    assert.equal(carried.validTo, undefined)
    assert.deepEqual(carried.holidays.find((holiday) => holiday.day === "2028-12-25"), { day: "2028-12-25", name: "Christmas Day" })
    const harborBody = collectionCalendarAdapter.toCreateBody?.(made({ projectId: FIXTURE_PROJECT_IDS.harbor, holidayDates: "2028-05-01" }), calendarContext()) as { holidays: { day: string; name: string | null }[] }
    assert.deepEqual(harborBody.holidays, [{ day: "2028-05-01", name: null }])
  })

  test("is refused here, naming the field, without a project the store loaded or a first day in force", () => {
    assert.deepEqual(collectionCalendarAdapter.toCreateBody?.(made({ projectId: "project-nowhere" }), calendarContext()), { path: "projectId", message: "Pick a project" })
    assert.deepEqual(collectionCalendarAdapter.toCreateBody?.(made({ validFrom: "" }), calendarContext()), { path: "validFrom", message: "A calendar needs the first day it is in force" })
  })

  test("goes out as POST /collection-calendars through the store's write; a name the project has and a holiday outside the period come back as the API's sentences", async () => {
    const written: CollectionCalendar = { ...central2026, id: "019995e0-0000-7000-8000-0000000000f1", name: "Copenhagen Central 2028", validFrom: "2028-01-01", validTo: "2029-01-01", holidays: [{ day: "2028-01-01", name: "Nytårsdag" }, { day: "2028-12-25", name: "Juledag" }] }
    const current = loaded({ records: [], serverIds: new Map() }, 1)
    const { fetch, calls } = scripted([() => json(written, 201, { location: `/collection-calendars/${written.id}` })])
    const outcome = await writeRecord(clientOver(fetch), collectionCalendarsModule, current, made(), { fixtures: calendarFixtures, state, now: NOW })
    assert.equal(calls[0].url, "http://api.test/collection-calendars")
    assert.equal((bodyOf(calls[0]) as { name: string }).name, "Copenhagen Central 2028")
    assert.equal(outcome.kind, "created")
    if (outcome.kind === "created") {
      assert.equal(outcome.record.id, `calendar-${written.id}`)
      assert.equal(outcome.record.submittedValues?.holidayDates, "2028-01-01, 2028-12-25")
    }

    const taken = scripted([() => problem(409, 'This project already has a collection calendar called "Copenhagen Central 2028"')])
    const refused = await writeRecord(clientOver(taken.fetch), collectionCalendarsModule, current, made(), { fixtures: calendarFixtures, state, now: NOW })
    assert.equal(refused.kind, "refused")
    if (refused.kind === "refused") assert.equal(problemSentence(refused.problem), 'This project already has a collection calendar called "Copenhagen Central 2028"')

    const outside = scripted([() => problem(400, "The request body is invalid", [{ path: "holidays.1.day", message: "Outside the calendar's period" }])])
    const stranded = await writeRecord(clientOver(outside.fetch), collectionCalendarsModule, current, made({ holidayDates: "2028-01-01, 2029-01-01" }), { fixtures: calendarFixtures, state, now: NOW })
    assert.equal(stranded.kind, "refused")
    if (stranded.kind === "refused") assert.equal(problemSentence(stranded.problem), "The request body is invalid — holidays.1.day: Outside the calendar's period")
  })
})

describe("an edited collection calendar", () => {
  const before = collectionCalendarAdapter.toRecord(central2026, calendarContext())
  const edited = (values: Record<string, string>): BusinessRecord => ({ ...before, name: values.calendarName ?? before.name, submittedValues: { ...before.submittedValues, ...values } })

  test("a new name or period is a CollectionCalendarPatch, the end as the first day out of force and a cleared end null; the project does not move", () => {
    const body = collectionCalendarAdapter.toPatchBody(before, edited({ calendarName: "Copenhagen Central 2026 (revised)", validTo: "2026-06-30" }), calendarContext())
    assert.deepEqual(body, { calendar: { name: "Copenhagen Central 2026 (revised)", validTo: "2026-07-01" } })
    assert.ok(CollectionCalendarPatch.safeParse((body as { calendar: unknown }).calendar).success)
    assert.deepEqual(collectionCalendarAdapter.toPatchBody(before, edited({ validTo: "" }), calendarContext()), { calendar: { validTo: null } })
    assert.deepEqual(collectionCalendarAdapter.toPatchBody(before, edited({ projectId: FIXTURE_PROJECT_IDS.harbor }), calendarContext()), { path: "projectId", message: "A calendar stays in its project" })
    assert.equal(collectionCalendarAdapter.toPatchBody(before, before, calendarContext()), null)
  })

  test("changed holidays are the whole set, replaced, the names carried from the record and the list", () => {
    const body = collectionCalendarAdapter.toPatchBody(before, edited({ holidayDates: "2026-01-01, 2026-06-05, 2026-12-24" }), calendarContext()) as { holidays: unknown }
    assert.deepEqual(body, {
      holidays: [
        { day: "2026-01-01", name: "Nytårsdag" },
        { day: "2026-06-05", name: "Grundlovsdag" },
        { day: "2026-12-24", name: holidayNamesFor("Danish public holidays")("2026-12-24") ?? null },
      ],
    })
    assert.ok(CollectionCalendarHolidaysSet.safeParse(body).success)
    const renamed = collectionCalendarAdapter.toPatchBody(before, edited({ holidayNames: JSON.stringify({ "2026-12-25": "Juledag" }) }), calendarContext()) as { holidays: { day: string; name: string | null }[] }
    assert.deepEqual(renamed.holidays.find((holiday) => holiday.day === "2026-12-25"), { day: "2026-12-25", name: "Juledag" })
  })

  test("the order follows the change: a period that grows goes first so new holidays fit it, and holidays that shrink go first so the period may follow — the API's own two-step", () => {
    const shrunk = collectionCalendarAdapter.toPatchBody(before, edited({ validTo: "2026-06-30", holidayDates: "2026-01-01, 2026-04-02, 2026-06-05" }), calendarContext()) as { calendar: unknown; holidays: unknown; holidaysFirst: boolean }
    assert.deepEqual(shrunk.calendar, { validTo: "2026-07-01" })
    assert.equal(shrunk.holidaysFirst, true, "December's holidays must go before the period can end in June")
    const grown = collectionCalendarAdapter.toPatchBody(before, edited({ validTo: "2027-06-30", holidayDates: "2026-01-01, 2026-04-02, 2026-06-05, 2026-12-25, 2027-03-01" }), calendarContext()) as { calendar: unknown; holidays: unknown; holidaysFirst: boolean }
    assert.deepEqual(grown.calendar, { validTo: "2027-07-01" })
    assert.equal(grown.holidaysFirst, false, "March 2027 lies outside the period as stored")
    const renamedOnly = collectionCalendarAdapter.toPatchBody(before, edited({ calendarName: "Renamed" }), calendarContext()) as { holidaysFirst?: boolean }
    assert.equal(renamedOnly.holidaysFirst, undefined, "nothing to order with one request")
  })

  test("the update sends the two requests in the order the body says, and answers the calendar as it now stands", async () => {
    const renamed = { ...central2026, name: "Copenhagen Central 2026 (revised)" }
    const { fetch, calls } = scripted([() => json(renamed), () => json({ ...renamed, holidays: [{ day: "2026-01-01", name: "Nytårsdag" }] })])
    const answer = await collectionCalendarAdapter.update(clientOver(fetch), central2026.id, { calendar: { name: "Copenhagen Central 2026 (revised)" }, holidays: [{ day: "2026-01-01", name: "Nytårsdag" }], holidaysFirst: false })
    assert.deepEqual(calls.map((call) => `${call.init.method} ${call.url}`), [`PATCH http://api.test/collection-calendars/${central2026.id}`, `PUT http://api.test/collection-calendars/${central2026.id}/holidays`])
    assert.deepEqual(bodyOf(calls[1]), { holidays: [{ day: "2026-01-01", name: "Nytårsdag" }] })
    assert.equal(answer.name, "Copenhagen Central 2026 (revised)")
    assert.equal(answer.holidays.length, 1)

    const shortened = { ...central2026, validTo: "2026-07-01", holidays: [{ day: "2026-01-01", name: "Nytårsdag" }] }
    const second = scripted([() => json({ ...central2026, holidays: shortened.holidays }), () => json(shortened)])
    const answer2 = await collectionCalendarAdapter.update(clientOver(second.fetch), central2026.id, { calendar: { validTo: "2026-07-01" }, holidays: shortened.holidays, holidaysFirst: true })
    assert.deepEqual(second.calls.map((call) => `${call.init.method} ${call.url}`), [`PUT http://api.test/collection-calendars/${central2026.id}/holidays`, `PATCH http://api.test/collection-calendars/${central2026.id}`])
    assert.equal(answer2.validTo, "2026-07-01")
  })
})

describe("the modules", () => {
  test("configure.areas and configure.calendars are switched, after the organisation the two resolve their projects against", () => {
    assert.deepEqual([planningAreasModule.workspaceId, planningAreasModule.moduleId], [PLANNING_AREAS_MODULE.workspaceId, PLANNING_AREAS_MODULE.moduleId])
    assert.deepEqual([collectionCalendarsModule.workspaceId, collectionCalendarsModule.moduleId], [COLLECTION_CALENDARS_MODULE.workspaceId, COLLECTION_CALENDARS_MODULE.moduleId])
    assert.ok(isServerBacked("configure", "areas"))
    assert.ok(isServerBacked("configure", "calendars"))
    assert.ok(SERVER_MODULE_KEYS.indexOf("configure.organization") < SERVER_MODULE_KEYS.indexOf("configure.areas"))
    assert.ok(SERVER_MODULE_KEYS.indexOf("configure.organization") < SERVER_MODULE_KEYS.indexOf("configure.calendars"))
  })
})
