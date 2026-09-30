// Route schemes on the adapter (#177, slice 3 of #81): the schemes the API
// holds become the records of `route-studio.schemes`, their collection groups
// the prototype's group shape — the one-group legacy shape where one group
// runs every service day, the explicit JSON otherwise — and the generation
// reading the stamps the lifecycle and the drift badge read; the records the
// workspace writes become the bodies the API's contracts accept, held here
// against the contracts' own zod schemas; and a write goes out through the
// store's seam over a scripted `fetch`, as one request or as the scheme's
// and its groups' in the order the API can take them, the API's refusals
// coming back as its sentences.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { WasteFraction, ContainerType } from "@waste/contracts/catalogue"
import type { Project, ServiceProvider } from "@waste/contracts/organisation"
import type { PlanningArea, PlanningAreaBoundary } from "@waste/contracts/planning-areas"
import {
  CollectionGroupCreate,
  CollectionGroupPatch,
  CollectionGroupContainersSet,
  RouteSchemeCreate,
  RouteSchemePatch,
  StopMatchingRuleSet,
  type CollectionGroup,
  type Occurrence,
  type RouteScheme,
} from "@waste/contracts/route-schemes"
import type { VehicleType } from "@waste/contracts/vehicle-types"
import { containerDriftBetween, generationMatchHistoryOf } from "@waste/domain/route-schemes/container-drift"
import { draftGroups } from "@waste/domain/route-schemes/draft"
import type { GuidedSchemeData } from "@waste/domain/route-schemes/quick-create"
import { collectionGroupsOfRecord, collectionGroupsToValues, type CollectionGroup as SchemeGroup } from "@waste/domain/route-schemes/groups"
import { effectiveSchemeStatus } from "@waste/domain/route-schemes/lifecycle"

import { FIXTURE_COMPANY_ID, getModuleDefinition, type BusinessRecord } from "../../data/business-modules"
import { ROUTE_SCHEMES_MODULE, schemeValuesOfDraft } from "../../data/route-schemes"
import { problemSentence } from "../problem"
import { type MappingContext } from "../records/adapter"
import { containerTypeAdapter, vehicleTypeAdapter, wasteFractionAdapter } from "../records/master-data"
import { isServerBacked, SERVER_MODULE_KEYS } from "../records/modules"
import { projectAdapter, serviceProviderAdapter } from "../records/organisation"
import { planningAreaAdapter } from "../records/planning"
import { routeSchemeAdapter, routeSchemesModule, schemeOccurrences, SERVER_GROUP_IDS_KEY } from "../records/route-schemes"
import { loaded, loadModule, resolverOver, writeRecord, type ModuleState, type ServerRecordsState } from "../records/server-records"
import { bodyOf, clientOver, json, problem, scripted, type Call } from "./scripted-fetch"

const NOW = new Date("2026-09-30T12:00:00Z")
const TODAY = "2026-09-30"
const STAMPS = { createdAt: "2026-09-24T09:00:00.000Z", updatedAt: "2026-09-25T09:30:00.000Z" }

const fixturesOf = (workspaceId: "configure" | "service-providers" | "route-studio", moduleId: string) => getModuleDefinition({ workspaceId, moduleId })?.records ?? []
const schemeFixtures = fixturesOf(ROUTE_SCHEMES_MODULE.workspaceId, ROUTE_SCHEMES_MODULE.moduleId)

// The seeded rows the schemes name, as the API answers them (packages/db/src/seed).
const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays" }
const nordren: ServiceProvider = { id: "01a0d2a4-a280-7003-8000-000000000001", ...STAMPS, legalName: "NordRen ApS", registrationNumber: "40291188", country: "DK", contactName: "Lars Mikkelsen", contactEmail: "contact@nordren.example" }
const indreBy: PlanningArea = { id: "01a0d2a4-a280-7016-8000-000000000001", ...STAMPS, projectId: copenhagen.id, code: "OP-CEN-01", name: "Indre By Operations", purpose: "route-planning" }
const indreByBoundary: PlanningAreaBoundary = { id: "01a0d2a4-a280-7017-8000-000000000001", ...STAMPS, projectId: copenhagen.id, planningAreaId: indreBy.id, boundary: { type: "Polygon", coordinates: [[[12.56, 55.67], [12.59, 55.67], [12.59, 55.69], [12.56, 55.67]]] }, validFrom: "2026-01-01", validTo: null }
const residual: WasteFraction = { id: "01a0d2a4-a280-7007-8000-000000000001", ...STAMPS, key: "residual", name: "Residual" }
const organic: WasteFraction = { ...residual, id: "01a0d2a4-a280-7007-8000-000000000002", key: "organic", name: "Organic" }
const bin240: ContainerType = { id: "01a0d2a4-a280-7008-8000-000000000002", ...STAMPS, name: "Two-wheel bin · 240 L", volumeLitres: 240 }
const rearLoader: VehicleType = { id: "01a0d2a4-a280-701f-8000-000000000001", ...STAMPS, key: "rear-loader", name: "Rear loader", description: null, containerTypeIds: [bin240.id] }

// Resources is still on fixtures here (slice 5a): the fleet and the places are named by the API's ids alone.
const WH24 = "01a0d2a4-a280-7021-8000-000000000001"
const NR08 = "01a0d2a4-a280-7021-8000-000000000004"
const MADS = "01a0d2a4-a280-7022-8000-000000000001"
const NORDHAVN_DEPOT = "01a0d2a4-a280-7023-8000-000000000001"
const PICKS = ["01a0d2a4-a280-7014-8000-000000000007", "01a0d2a4-a280-7014-8000-000000000008", "01a0d2a4-a280-7014-8000-00000000000a", "01a0d2a4-a280-7014-8000-00000000000b"]
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday"] as const

const groupOf = (over: Partial<CollectionGroup> & Pick<CollectionGroup, "id" | "routeSchemeId" | "name">): CollectionGroup => ({
  ...STAMPS,
  position: 1,
  days: [...WEEKDAYS],
  stopSource: "rule",
  rule: { wasteFractionIds: [residual.id], containerTypeIds: [], vehicleTypeId: rearLoader.id },
  containerIds: [],
  serviceProviderId: null,
  vehicleId: null,
  driverId: null,
  ...over,
})

const CENTRAL_ID = "01a0d2a4-a280-701a-8000-000000000001"
const CENTRAL_GROUP_ID = "01a0d2a4-a280-701b-8000-000000000001"
const central: RouteScheme = {
  id: CENTRAL_ID,
  ...STAMPS,
  projectId: copenhagen.id,
  name: "RS-Central · Week A",
  planningAreaId: indreBy.id,
  serviceType: "container-collection",
  frequency: "weekly",
  serviceDays: [...WEEKDAYS],
  weekRotation: null,
  plannedStartTime: "06:00",
  holidayPolicy: "skip",
  editPolicy: "ask",
  planAhead: true,
  status: "validated",
  depotId: NORDHAVN_DEPOT,
  unloadingStationId: null,
  collectionGroups: [groupOf({ id: CENTRAL_GROUP_ID, routeSchemeId: CENTRAL_ID, name: "RS-Central · Week A", vehicleId: WH24, driverId: MADS })],
  generation: { lastGeneratedAt: null, groups: [] },
  validFrom: "2026-06-01",
  validTo: null,
}

const OSTERBRO_ID = "01a0d2a4-a280-701a-8000-000000000002"
const OSTERBRO_GROUP_ID = "01a0d2a4-a280-701b-8000-000000000002"
const osterbro: RouteScheme = {
  ...central,
  id: OSTERBRO_ID,
  name: "RS-Østerbro · Organic B",
  planningAreaId: null,
  frequency: "every-2-weeks",
  serviceDays: ["tuesday", "thursday"],
  weekRotation: "even",
  plannedStartTime: "06:30",
  depotId: null,
  collectionGroups: [groupOf({ id: OSTERBRO_GROUP_ID, routeSchemeId: OSTERBRO_ID, name: "RS-Østerbro · Organic B", days: ["tuesday", "thursday"], stopSource: "manual", rule: null, containerIds: PICKS, serviceProviderId: nordren.id, vehicleId: NR08 })],
  validFrom: "2026-08-04",
}

// The modules the schemes resolve against, as the store has them when the schemes load.
const projectRecord = projectAdapter.toRecord(copenhagen, { fixtures: fixturesOf("configure", "organization"), resolve: resolverOver(new Map()), now: NOW })
const organisationState = loaded({ records: [projectRecord], serverIds: new Map([[projectRecord.id, copenhagen.id]]) }, 1)
const providerRecord = serviceProviderAdapter.toRecord(nordren, { fixtures: fixturesOf("service-providers", "service-providers"), resolve: resolverOver(new Map()), now: NOW })
const withOrganisation: ServerRecordsState = new Map([
  ["configure.organization", organisationState],
  ["service-providers.service-providers", loaded({ records: [providerRecord], serverIds: new Map([[providerRecord.id, nordren.id]]) }, 1)],
])
const areaRecord = planningAreaAdapter.toRecord({ ...indreBy, boundaries: [indreByBoundary] }, { fixtures: fixturesOf("configure", "areas"), resolve: resolverOver(withOrganisation), now: NOW })
const masterContext: MappingContext = { fixtures: [], resolve: resolverOver(new Map()), now: NOW }
const masterRecords: Array<[BusinessRecord, string]> = [
  [wasteFractionAdapter.toRecord(residual, masterContext), residual.id],
  [wasteFractionAdapter.toRecord(organic, masterContext), organic.id],
  [containerTypeAdapter.toRecord(bin240, masterContext), bin240.id],
  [vehicleTypeAdapter.toRecord(rearLoader, masterContext), rearLoader.id],
]
const state: ServerRecordsState = new Map([
  ...withOrganisation,
  ["configure.areas", loaded({ records: [areaRecord], serverIds: new Map([[areaRecord.id, indreBy.id]]) }, 1)],
  ["configure.master", loaded({ records: masterRecords.map(([record]) => record), serverIds: new Map(masterRecords.map(([record, id]) => [record.id, id])) }, 1)],
])

const context = (): MappingContext => ({ fixtures: schemeFixtures, resolve: resolverOver(state), companyRecordId: FIXTURE_COMPANY_ID, now: NOW })
const recordOf = (scheme: RouteScheme): BusinessRecord => routeSchemeAdapter.toRecord(scheme, context())
const pageOf = (items: unknown[]) => json({ items, nextCursor: null })

/** The schemes module as the store holds it once a scheme has loaded: the row under its web id, beside its server id. */
function schemesState(scheme: RouteScheme): { module: ModuleState; record: BusinessRecord } {
  const record = recordOf(scheme)
  return { record, module: loaded({ records: [record], serverIds: new Map([[record.id, scheme.id]]) }, 1) }
}

/** An edit of a loaded scheme through the store's seam: the record changed as the workspace changes it, the requests the API was sent. */
async function edited(scheme: RouteScheme, change: (record: BusinessRecord) => BusinessRecord, answers: Array<(call: Call) => Response>, writeState: ServerRecordsState = state) {
  const { module, record } = schemesState(scheme)
  const { fetch, calls } = scripted(answers)
  const outcome = await writeRecord(clientOver(fetch), routeSchemesModule, module, change(record), { fixtures: schemeFixtures, state: writeState, now: NOW })
  return { outcome, calls, record }
}

/** A record's typed values changed, as the edit dialog merges the form over them. */
const withValues = (values: Record<string, string | boolean>) => (record: BusinessRecord): BusinessRecord => ({ ...record, submittedValues: { ...record.submittedValues, ...values } })

/** The record's groups replaced, as the collection groups editor saves them (business-workspace's `handleSchemeGroupsSave`). */
const withGroups = (groups: (current: SchemeGroup[]) => SchemeGroup[], serviceDays?: string[]) => (record: BusinessRecord): BusinessRecord => {
  const current = collectionGroupsOfRecord(record).map((group) => Object.fromEntries(Object.entries(group).filter(([key]) => key !== "implicit")) as SchemeGroup)
  const days = (serviceDays ?? String(record.submittedValues?.serviceDays).split(", ")) as SchemeGroup["days"]
  return withValues({ ...(serviceDays ? { serviceDays: serviceDays.join(", ") } : {}), ...collectionGroupsToValues(groups(current), days) })(record)
}

const request = (call: Call) => `${call.init.method ?? "GET"} ${call.url.replace("http://api.test", "")}`

describe("the route schemes module", () => {
  test("is switched, and loads last: after every module a scheme and its groups name a row of", () => {
    assert.ok(isServerBacked("route-studio", "schemes"))
    const at = SERVER_MODULE_KEYS.indexOf("route-studio.schemes")
    for (const before of ["configure.organization", "service-providers.service-providers", "configure.areas", "configure.master", "resources.depots", "fleet.vehicles", "fleet.drivers"]) {
      assert.ok(SERVER_MODULE_KEYS.indexOf(before) < at, before)
    }
    assert.equal(at, SERVER_MODULE_KEYS.length - 1, "a module switched later goes in ahead of the schemes (the order on #191)")
  })

  test("loads one list, and lends no fixture its id: a scheme is `scheme-<uuid>` from the start", async () => {
    const { fetch, calls } = scripted([() => pageOf([central, osterbro])])
    const result = await loadModule(clientOver(fetch), routeSchemesModule, { fixtures: schemeFixtures, state, now: NOW })
    assert.deepEqual(calls.map(request), ["GET /route-schemes?limit=200"])
    assert.deepEqual(
      result.records.map((record) => record.id),
      [`scheme-${CENTRAL_ID}`, `scheme-${OSTERBRO_ID}`],
    )
    assert.equal(result.serverIds.get(`scheme-${CENTRAL_ID}`), CENTRAL_ID)
  })
})

describe("a scheme read", () => {
  test("is the prototype's scheme: its recurrence, period and policies as the forms spell them, its project and area by web id", () => {
    const record = recordOf(central)
    assert.equal(record.name, "RS-Central · Week A")
    assert.equal(record.status, "Validated")
    assert.equal(record.recordKind, "Route Scheme")
    assert.deepEqual(record.projectIds, ["project-copenhagen"])
    assert.equal(record.companyId, FIXTURE_COMPANY_ID)
    const values = record.submittedValues ?? {}
    assert.equal(values.schemeName, "RS-Central · Week A")
    assert.equal(values.projectId, "project-copenhagen")
    assert.equal(values.planningAreaId, "area-indreby", "the area by the id its module lends it")
    assert.equal(values.serviceType, "Container collection", "the form's word for the wire's token")
    assert.equal(values.frequency, "weekly")
    assert.equal(values.weekRotation, "")
    assert.equal(values.serviceDays, "monday, tuesday, wednesday, thursday, friday")
    assert.equal(values.effectiveFrom, "2026-06-01")
    assert.equal(values.effectiveTo, "", "an open period has no last day")
    assert.equal(values.plannedStartTime, "06:00")
    assert.equal(values.holidayPolicy, "skip")
    assert.equal(values.editPolicy, "ask")
    assert.equal(values.planAhead, true)
    assert.equal(values.depotId, `depot-${NORDHAVN_DEPOT}`, "a place not read from the API yet is an id chip")
    assert.equal(values.unloadingStationId, "")
    assert.equal(record.facts.Project, "Copenhagen Central")
    assert.equal(record.facts["Planning area"], "Indre By Operations")
  })

  test("one group running every service day reads as the legacy shape: the rule by name, the fleet as id chips, the group's server id kept beside it", () => {
    const record = recordOf(central)
    const values = record.submittedValues ?? {}
    assert.equal(values.stopSelection, "rule")
    assert.equal(values.matchFractions, "Residual", "a rule names its fractions by the master data's names, which the domain matches by")
    assert.equal(values.matchVehicleType, "Rear loader")
    assert.equal(values.matchContainerTypes, "")
    assert.equal(values.wasteFraction, "Residual", "the scheme's one fraction, as the quick form writes it")
    assert.equal(values.plannedVehicleId, `vehicle-${WH24}`)
    assert.equal(values.plannedDriverId, `driver-${MADS}`)
    assert.equal(values.serviceProviderId, "")
    assert.equal(values.collectionGroups, "")
    assert.deepEqual(JSON.parse(String(values[SERVER_GROUP_IDS_KEY])), { default: CENTRAL_GROUP_ID })
    const [group] = collectionGroupsOfRecord(record)
    assert.deepEqual(
      { id: group.id, days: group.days, fractions: group.fractions, ruleVehicleType: group.ruleVehicleType, vehicleId: group.vehicleId, driverId: group.driverId },
      { id: "default", days: [...WEEKDAYS], fractions: ["Residual"], ruleVehicleType: "Rear loader", vehicleId: `vehicle-${WH24}`, driverId: `driver-${MADS}` },
    )
  })

  test("a manual group picks its containers by the API's ids in stop order, and names its provider by the web id the provider module lends", () => {
    const record = recordOf(osterbro)
    const values = record.submittedValues ?? {}
    assert.equal(values.stopSelection, "manual")
    assert.equal(values.containerIds, PICKS.map((id) => `asset-${id}`).join(","))
    assert.equal(values.serviceProviderId, providerRecord.id)
    assert.equal(record.serviceProviderId, providerRecord.id, "the scheme's scope is its one provider")
    assert.equal(values.plannedDriverId, "", "no driver is said until one is assigned")
    assert.equal(values.frequency, "every-2-weeks")
    assert.equal(values.weekRotation, "even")
    assert.equal(values.planningAreaId, "")
    assert.equal(record.facts["Service provider"], "NordRen ApS")
  })

  test("several groups read as the explicit shape under `group-<uuid>` ids; a parked group, which runs on no day, is left out", () => {
    const north = groupOf({ id: "01a0d2a4-a280-701b-8000-0000000000a1", routeSchemeId: CENTRAL_ID, name: "North", days: ["monday", "tuesday", "wednesday"], vehicleId: WH24 })
    const south = groupOf({ id: "01a0d2a4-a280-701b-8000-0000000000a2", routeSchemeId: CENTRAL_ID, name: "South", position: 2, days: ["thursday", "friday"], rule: { wasteFractionIds: [residual.id, organic.id], containerTypeIds: [bin240.id], vehicleTypeId: null } })
    const parked = groupOf({ id: "01a0d2a4-a280-701b-8000-0000000000a3", routeSchemeId: CENTRAL_ID, name: "Old", position: 3, days: [] })
    const record = recordOf({ ...central, collectionGroups: [north, south, parked] })
    const groups = collectionGroupsOfRecord(record)
    assert.deepEqual(
      groups.map((group) => ({ id: group.id, name: group.name, days: group.days, fractions: group.fractions, containerTypes: group.containerTypes, ruleVehicleType: group.ruleVehicleType })),
      [
        { id: `group-${north.id}`, name: "North", days: ["monday", "tuesday", "wednesday"], fractions: ["Residual"], containerTypes: undefined, ruleVehicleType: "Rear loader" },
        { id: `group-${south.id}`, name: "South", days: ["thursday", "friday"], fractions: ["Residual", "Organic"], containerTypes: ["Two-wheel bin · 240 L"], ruleVehicleType: undefined },
      ],
    )
    assert.deepEqual(JSON.parse(String(record.submittedValues?.[SERVER_GROUP_IDS_KEY])), { [`group-${north.id}`]: north.id, [`group-${south.id}`]: south.id })
    assert.equal(record.submittedValues?.wasteFraction, "", "two fractions across the groups are no one scheme fraction")
  })

  test("reads its lifecycle off the generation: Validated until a run succeeds, then Scheduled and, in its period, Effective", () => {
    assert.equal(effectiveSchemeStatus(recordOf(central), TODAY), "Validated")
    const generated = recordOf({ ...central, generation: { lastGeneratedAt: "2026-09-29T03:00:07.000Z", groups: [] } })
    assert.equal(generated.submittedValues?.lastGeneratedAt, "2026-09-29T03:00:07.000Z")
    assert.equal(effectiveSchemeStatus(generated, TODAY), "Effective")
    assert.equal(effectiveSchemeStatus(recordOf({ ...central, status: "draft", generation: generated.submittedValues ? { lastGeneratedAt: "2026-09-29T03:00:07.000Z", groups: [] } : central.generation }), TODAY), "Draft")
  })

  test("carries the two latest match stamps under the web's group ids, so the drift reading runs as it does on the browser's path", () => {
    const stamp = (containerIds: string[]) => ({ ruleSignature: `${indreBy.id}|${residual.id}|${rearLoader.id}|`, containerIds })
    const before = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10"].map((n) => `01a0d2a4-a280-7014-8000-0000000001${n.slice(1).padStart(2, "0")}`)
    const now = [...before.slice(0, 8), PICKS[0], PICKS[1]]
    const record = recordOf({ ...central, generation: { lastGeneratedAt: "2026-09-29T03:00:07.000Z", groups: [{ groupId: CENTRAL_GROUP_ID, latest: stamp(now), previous: stamp(before) }] } })
    const history = generationMatchHistoryOf(record.submittedValues)
    assert.deepEqual(Object.keys(history.last), ["default"], "keyed by the group's web id, the legacy shape's `default`")
    const [drift] = containerDriftBetween(history.previous, history.last, collectionGroupsOfRecord(record))
    assert.deepEqual({ joined: drift.joined.length, left: drift.left.length, previous: drift.previous }, { joined: 2, left: 2, previous: 10 })
    const once = recordOf({ ...central, generation: { lastGeneratedAt: "2026-09-29T03:00:07.000Z", groups: [{ groupId: CENTRAL_GROUP_ID, latest: stamp(now), previous: null }] } })
    assert.deepEqual(generationMatchHistoryOf(once.submittedValues).previous, {}, "a group stamped once has nothing to compare against")
  })
})

// The record the quick form makes, as createSchemeFromDraft spells it (business-workspace.tsx): one group, `default`, every service day.
function quickRecord(over: { values?: Record<string, string | boolean>; group?: Partial<SchemeGroup>; status?: string } = {}): BusinessRecord {
  const group: SchemeGroup = { id: "default", name: "Paper · Mondays", days: ["monday", "thursday"], fractions: ["Residual"], stopSource: "rule", ruleVehicleType: "Rear loader", containerTypes: ["Two-wheel bin · 240 L"], containerIds: [], ...over.group }
  return {
    id: "schemes-route-scheme-1759230000000",
    name: "Paper · Mondays",
    context: "",
    status: over.status ?? "Validated",
    owner: "Olivia Larsen",
    value: "",
    updated: "Now",
    freshness: "Now",
    source: "Quick create",
    description: "",
    facts: {},
    related: [],
    companyId: FIXTURE_COMPANY_ID,
    projectIds: ["project-copenhagen"],
    recordKind: "Route Scheme",
    submittedValues: {
      schemeName: "Paper · Mondays",
      projectId: "project-copenhagen",
      planningAreaId: "area-indreby",
      wasteFraction: "Residual",
      serviceType: "Container collection",
      frequency: "weekly",
      weekRotation: "",
      serviceDays: "monday, thursday",
      effectiveFrom: "2026-10-05",
      effectiveTo: "",
      plannedStartTime: "06:30",
      depotId: "",
      unloadingStationId: "",
      holidayPolicy: "skip",
      createAs: "validated",
      editPolicy: "ask",
      ...collectionGroupsToValues([group], group.days),
      ...over.values,
    },
  }
}

describe("a scheme the quick form makes", () => {
  test("becomes the create body the contract accepts: ids for every row it names, the master data by the names it picked, one group every service day", () => {
    const body = routeSchemeAdapter.toCreateBody?.(quickRecord(), context())
    assert.deepEqual(body, {
      projectId: copenhagen.id,
      name: "Paper · Mondays",
      planningAreaId: indreBy.id,
      serviceType: "container-collection",
      frequency: "weekly",
      serviceDays: ["monday", "thursday"],
      weekRotation: null,
      plannedStartTime: "06:30",
      holidayPolicy: "skip",
      editPolicy: "ask",
      status: "validated",
      depotId: null,
      unloadingStationId: null,
      collectionGroups: [
        {
          name: "Paper · Mondays",
          days: ["monday", "thursday"],
          stopSource: "rule",
          rule: { wasteFractionIds: [residual.id], containerTypeIds: [bin240.id], vehicleTypeId: rearLoader.id },
          containerIds: null,
          serviceProviderId: null,
          vehicleId: null,
          driverId: null,
        },
      ],
      validFrom: "2026-10-05",
    })
    assert.ok(RouteSchemeCreate.safeParse(body).success, JSON.stringify(RouteSchemeCreate.safeParse(body).error?.issues))
  })

  test("a draft is created a draft, an end day as the first day out, a fortnightly rotation, a manual list by the API's ids", () => {
    const record = quickRecord({
      status: "Draft",
      values: { effectiveTo: "2026-12-31", frequency: "every-2-weeks", weekRotation: "odd", planAhead: false },
      group: { stopSource: "manual", fractions: [], ruleVehicleType: undefined, containerTypes: undefined, containerIds: [`asset-${PICKS[1]}`, `asset-${PICKS[0]}`], serviceProviderId: providerRecord.id, vehicleId: `vehicle-${NR08}` },
    })
    const body = routeSchemeAdapter.toCreateBody?.(record, context()) as Record<string, unknown>
    assert.equal(body.status, "draft")
    assert.equal(body.validTo, "2027-01-01")
    assert.equal(body.weekRotation, "odd")
    assert.equal(body.planAhead, false)
    assert.deepEqual((body.collectionGroups as unknown[])[0], {
      name: "Paper · Mondays",
      days: ["monday", "thursday"],
      stopSource: "manual",
      rule: null,
      containerIds: [PICKS[1], PICKS[0]],
      serviceProviderId: nordren.id,
      vehicleId: NR08,
      driverId: null,
    })
    assert.ok(RouteSchemeCreate.safeParse(body).success, JSON.stringify(RouteSchemeCreate.safeParse(body).error?.issues))
  })

  test("goes out as one POST, and the API's answer is the record", async () => {
    const answer: RouteScheme = { ...central, id: "019995e0-0000-7000-8000-0000000000c1", name: "Paper · Mondays", collectionGroups: [groupOf({ id: "019995e0-0000-7000-8000-0000000000c2", routeSchemeId: "019995e0-0000-7000-8000-0000000000c1", name: "Paper · Mondays", days: ["monday", "thursday"] })], serviceDays: ["monday", "thursday"] }
    const { fetch, calls } = scripted([() => json(answer, 201, { location: `/route-schemes/${answer.id}` })])
    const module = loaded({ records: [], serverIds: new Map() }, 1)
    const outcome = await writeRecord(clientOver(fetch), routeSchemesModule, module, quickRecord(), { fixtures: schemeFixtures, state, now: NOW })
    assert.deepEqual(calls.map(request), ["POST /route-schemes"])
    assert.ok(RouteSchemeCreate.safeParse(bodyOf(calls[0])).success)
    assert.equal(outcome.kind, "created")
    assert.equal(outcome.kind === "created" ? outcome.record.submittedValues?.schemeName : undefined, "Paper · Mondays")
  })

  test("is refused before the API when it names what the API does not hold: a fraction by a name no master data row has, a fixture vehicle, no project", () => {
    assert.deepEqual(routeSchemeAdapter.toCreateBody?.(quickRecord({ group: { fractions: ["Garden waste"] } }), context()), { path: "wasteFraction", message: 'The API holds no waste fraction named "Garden waste"' })
    assert.deepEqual(routeSchemeAdapter.toCreateBody?.(quickRecord({ group: { containerTypes: ["Skip · 10 m³"] } }), context()), { path: "matchContainerTypes", message: 'The API holds no container type named "Skip · 10 m³"' })
    assert.deepEqual(routeSchemeAdapter.toCreateBody?.(quickRecord({ group: { ruleVehicleType: "Hook lift" } }), context()), { path: "matchVehicleType", message: 'The API holds no vehicle type named "Hook lift"' })
    assert.deepEqual(routeSchemeAdapter.toCreateBody?.(quickRecord({ group: { vehicleId: "vehicle-wh24" } }), context()), { path: "plannedVehicleId", message: "The API holds no vehicle vehicle-wh24" })
    assert.deepEqual(routeSchemeAdapter.toCreateBody?.(quickRecord({ group: { driverId: "driver-mads" } }), context()), { path: "plannedDriverId", message: "The API holds no driver driver-mads" })
    assert.deepEqual(routeSchemeAdapter.toCreateBody?.(quickRecord({ values: { projectId: "project-elsewhere" } }), context()), { path: "projectId", message: "Pick a project" })
  })

  test("a name the master data does not hold is refused at the store's seam, in the words the person reads, and nothing is sent — no rule is written without it", async () => {
    const { fetch, calls } = scripted([])
    const outcome = await writeRecord(clientOver(fetch), routeSchemesModule, loaded({ records: [], serverIds: new Map() }, 1), quickRecord({ group: { fractions: ["Residual", "Garden waste"] } }), { fixtures: schemeFixtures, state, now: NOW })
    assert.equal(calls.length, 0)
    assert.equal(outcome.kind === "refused" ? problemSentence(outcome.problem) : outcome.kind, 'The request body is invalid — wasteFraction: The API holds no waste fraction named "Garden waste"')
  })
})

describe("a scheme the guided setup makes (#178)", () => {
  // The wizard's draft as step 5 hands it over: two rule groups inheriting step 1's fraction, the fleet and the depot by the web ids their modules lend.
  const draft: GuidedSchemeData = {
    schemeName: "Guided · Residual North and South",
    projectId: "project-copenhagen",
    planningAreaId: "area-indreby",
    wasteFraction: "Residual",
    serviceType: "Kerbside collection",
    frequency: "weekly",
    weekRotation: "odd",
    serviceDays: ["monday", "thursday"],
    effectiveFrom: "2026-10-05",
    effectiveTo: "",
    plannedStartTime: "06:15",
    holidayPolicy: "shift-next",
    createAs: "validated",
    editPolicy: "future",
    depotId: `depot-${NORDHAVN_DEPOT}`,
    unloadingStationId: "",
    groups: [
      { id: "group-mo1", name: "North", days: ["monday"], fractions: [], stopSource: "rule", containerTypes: ["Two-wheel bin · 240 L"], containerIds: [], vehicleId: `vehicle-${WH24}`, driverId: `driver-${MADS}` },
      { id: "group-th1", name: "South", days: ["thursday"], fractions: [], stopSource: "rule", containerTypes: ["Two-wheel bin · 240 L"], containerIds: [], vehicleId: `vehicle-${NR08}` },
    ],
  }
  const wizardRecord = (): BusinessRecord => ({
    ...quickRecord(),
    name: draft.schemeName,
    source: "Office workspace",
    submittedValues: schemeValuesOfDraft(draft, draftGroups(draft)),
  })

  test("becomes the create body the contract accepts: the scheme's own fields, each group with its rule by the master data's ids and its fleet by the API's", () => {
    const body = routeSchemeAdapter.toCreateBody?.(wizardRecord(), context())
    assert.ok(RouteSchemeCreate.safeParse(body).success, JSON.stringify(RouteSchemeCreate.safeParse(body).error?.issues))
    assert.deepEqual(body, {
      projectId: copenhagen.id,
      name: "Guided · Residual North and South",
      planningAreaId: indreBy.id,
      serviceType: "kerbside-collection",
      frequency: "weekly",
      serviceDays: ["monday", "thursday"],
      weekRotation: null,
      plannedStartTime: "06:15",
      holidayPolicy: "shift-next",
      editPolicy: "future",
      status: "validated",
      depotId: NORDHAVN_DEPOT,
      unloadingStationId: null,
      collectionGroups: [
        { name: "North", days: ["monday"], stopSource: "rule", rule: { wasteFractionIds: [residual.id], containerTypeIds: [bin240.id], vehicleTypeId: null }, containerIds: null, serviceProviderId: null, vehicleId: WH24, driverId: MADS },
        { name: "South", days: ["thursday"], stopSource: "rule", rule: { wasteFractionIds: [residual.id], containerTypeIds: [bin240.id], vehicleTypeId: null }, containerIds: null, serviceProviderId: null, vehicleId: NR08, driverId: null },
      ],
      validFrom: "2026-10-05",
    })
  })

  test("one group running every service day is the legacy shape, and goes out as the scheme's one group", () => {
    const one: GuidedSchemeData = { ...draft, groups: [{ ...draft.groups[0], name: "Everyone", days: ["monday", "thursday"] }] }
    const record = { ...wizardRecord(), submittedValues: schemeValuesOfDraft(one, draftGroups(one)) }
    const body = routeSchemeAdapter.toCreateBody?.(record, context()) as { collectionGroups: Array<{ name: string; days: string[] }> }
    assert.ok(RouteSchemeCreate.safeParse(body).success, JSON.stringify(RouteSchemeCreate.safeParse(body).error?.issues))
    assert.deepEqual(
      body.collectionGroups.map((group) => [group.name, group.days]),
      [["Guided · Residual North and South", ["monday", "thursday"]]],
    )
  })
})

describe("an edit of a scheme", () => {
  const schemeAnswer = (over: Partial<RouteScheme> = {}) => () => json({ ...central, ...over })
  const groupAnswer = (over: Partial<CollectionGroup> = {}) => () => json({ ...central.collectionGroups[0], ...over })

  test("a rename is one PATCH of the name, and the answer is the record under its own web id", async () => {
    const { outcome, calls, record } = await edited(central, (row) => ({ ...withValues({ schemeName: "RS-Central · Week B" })(row), name: "RS-Central · Week B" }), [schemeAnswer({ name: "RS-Central · Week B" })])
    assert.deepEqual(calls.map(request), [`PATCH /route-schemes/${CENTRAL_ID}`])
    assert.deepEqual(bodyOf(calls[0]), { name: "RS-Central · Week B" })
    assert.ok(RouteSchemePatch.safeParse(bodyOf(calls[0])).success)
    assert.equal(outcome.kind, "updated")
    assert.equal(outcome.kind === "updated" ? outcome.record.id : undefined, record.id)
  })

  test("the plan-ahead toggle, the policy, the start time and the end are the scheme's own fields, the end as the first day out", async () => {
    const { calls } = await edited(central, withValues({ planAhead: false, editPolicy: "future", plannedStartTime: "08:15", effectiveTo: "2026-12-31" }), [schemeAnswer()])
    assert.deepEqual(bodyOf(calls[0]), { planAhead: false, editPolicy: "future", plannedStartTime: "08:15", validTo: "2027-01-01" })
    assert.ok(RouteSchemePatch.safeParse(bodyOf(calls[0])).success)
    const reopened = await edited({ ...central, validTo: "2027-01-01" }, withValues({ effectiveTo: "" }), [schemeAnswer()])
    assert.deepEqual(bodyOf(reopened.calls[0]), { validTo: null }, "an emptied end reopens the period")
  })

  test("the status moves between the wire's two words and no other: Draft is a PATCH, Expired is refused before the API", async () => {
    const { calls } = await edited(central, (row) => ({ ...row, status: "Draft" }), [schemeAnswer({ status: "draft" })])
    assert.deepEqual(bodyOf(calls[0]), { status: "draft" })
    const expired = await edited(central, (row) => ({ ...row, status: "Expired" }), [])
    assert.equal(expired.outcome.kind, "refused")
    assert.equal(expired.calls.length, 0)
    assert.deepEqual(routeSchemeAdapter.statuses, ["draft", "validated"])
  })

  test("the group's own fields are its PATCH, then the scheme is read back whole", async () => {
    const { calls, outcome } = await edited(central, withValues({ plannedDriverId: "" }), [groupAnswer({ driverId: null }), schemeAnswer()])
    assert.deepEqual(calls.map(request), [`PATCH /collection-groups/${CENTRAL_GROUP_ID}`, `GET /route-schemes/${CENTRAL_ID}`])
    assert.deepEqual(bodyOf(calls[0]), { driverId: null })
    assert.ok(CollectionGroupPatch.safeParse(bodyOf(calls[0])).success)
    assert.equal(outcome.kind, "updated")
  })

  test("a changed rule is the whole rule, PUT: the fractions, the container types and the vehicle type by id", async () => {
    const { calls } = await edited(central, withValues({ matchFractions: "Organic", wasteFraction: "Organic", matchContainerTypes: "Two-wheel bin · 240 L" }), [groupAnswer(), schemeAnswer()])
    assert.deepEqual(calls.map(request), [`PUT /collection-groups/${CENTRAL_GROUP_ID}/stop-matching-rule`, `GET /route-schemes/${CENTRAL_ID}`])
    assert.deepEqual(bodyOf(calls[0]), { wasteFractionIds: [organic.id], containerTypeIds: [bin240.id], vehicleTypeId: rearLoader.id })
    assert.ok(StopMatchingRuleSet.safeParse(bodyOf(calls[0])).success)
  })

  test("a manual group's picks, reordered, are the whole list, PUT", async () => {
    const reordered = [PICKS[3], PICKS[0], PICKS[1], PICKS[2]].map((id) => `asset-${id}`).join(",")
    const { calls } = await edited(osterbro, withValues({ containerIds: reordered }), [groupAnswer(), schemeAnswer()])
    assert.deepEqual(calls.map(request), [`PUT /collection-groups/${OSTERBRO_GROUP_ID}/containers`, `GET /route-schemes/${OSTERBRO_ID}`])
    assert.deepEqual(bodyOf(calls[0]), { containerIds: [PICKS[3], PICKS[0], PICKS[1], PICKS[2]] })
    assert.ok(CollectionGroupContainersSet.safeParse(bodyOf(calls[0])).success)
  })

  test("a service day added to a validated scheme goes draft, moves the group, then validates again: the API holds each request to the structural rules", async () => {
    const withSaturday = [...WEEKDAYS, "saturday"]
    const { calls } = await edited(central, withValues({ serviceDays: withSaturday.join(", ") }), [schemeAnswer({ status: "draft", serviceDays: withSaturday as RouteScheme["serviceDays"] }), groupAnswer(), schemeAnswer({ serviceDays: withSaturday as RouteScheme["serviceDays"] })])
    assert.deepEqual(calls.map(request), [`PATCH /route-schemes/${CENTRAL_ID}`, `PATCH /collection-groups/${CENTRAL_GROUP_ID}`, `PATCH /route-schemes/${CENTRAL_ID}`])
    assert.deepEqual(bodyOf(calls[0]), { serviceDays: withSaturday, status: "draft" })
    assert.deepEqual(bodyOf(calls[1]), { days: withSaturday })
    assert.deepEqual(bodyOf(calls[2]), { status: "validated" })
    for (const call of [calls[0], calls[2]]) assert.ok(RouteSchemePatch.safeParse(bodyOf(call)).success)
  })

  test("days swapped go through their union: the scheme serves both, the group moves, the scheme drops the old day", async () => {
    const swapped = ["tuesday", "wednesday", "thursday", "friday", "saturday"]
    const { calls } = await edited({ ...central, status: "draft" }, (row) => ({ ...withValues({ serviceDays: swapped.join(", ") })(row), status: "Draft" }), [schemeAnswer(), groupAnswer(), schemeAnswer()])
    assert.deepEqual(bodyOf(calls[0]), { serviceDays: [...WEEKDAYS, "saturday"] }, "a draft needs no status move")
    assert.deepEqual(bodyOf(calls[1]), { days: swapped })
    assert.deepEqual(bodyOf(calls[2]), { serviceDays: swapped })
  })

  test("a group split in two: the new group is created after the old one moved, and a removed group is parked first", async () => {
    const created = groupOf({ id: "019995e0-0000-7000-8000-0000000000d1", routeSchemeId: CENTRAL_ID, name: "Friday", days: ["friday"] })
    const split = withGroups((current) => [{ ...current[0], days: ["monday", "tuesday", "wednesday", "thursday"] }, { id: "group-2", name: "Friday", days: ["friday"], fractions: ["Residual"], stopSource: "rule", ruleVehicleType: "Rear loader", containerIds: [] }])
    const { calls } = await edited(central, split, [schemeAnswer({ status: "draft" }), groupAnswer(), () => json(created, 201, { location: `/collection-groups/${created.id}` }), schemeAnswer()])
    assert.deepEqual(calls.map(request), [`PATCH /route-schemes/${CENTRAL_ID}`, `PATCH /collection-groups/${CENTRAL_GROUP_ID}`, `POST /route-schemes/${CENTRAL_ID}/collection-groups`, `PATCH /route-schemes/${CENTRAL_ID}`])
    assert.deepEqual(bodyOf(calls[0]), { status: "draft" })
    assert.deepEqual(bodyOf(calls[1]), { days: ["monday", "tuesday", "wednesday", "thursday"] })
    assert.deepEqual(bodyOf(calls[2]), { name: "Friday", days: ["friday"], stopSource: "rule", rule: { wasteFractionIds: [residual.id], containerTypeIds: [], vehicleTypeId: rearLoader.id }, containerIds: null, serviceProviderId: null, vehicleId: null, driverId: null })
    assert.ok(CollectionGroupCreate.safeParse(bodyOf(calls[2])).success)
    assert.deepEqual(bodyOf(calls[3]), { status: "validated" })

    const north = groupOf({ id: "01a0d2a4-a280-701b-8000-0000000000a1", routeSchemeId: CENTRAL_ID, name: "North", days: ["monday", "tuesday", "wednesday"] })
    const south = groupOf({ id: "01a0d2a4-a280-701b-8000-0000000000a2", routeSchemeId: CENTRAL_ID, name: "South", position: 2, days: ["thursday", "friday"] })
    const merged = await edited({ ...central, collectionGroups: [north, south] }, withGroups((current) => [{ ...current[0], days: [...WEEKDAYS] }]), [schemeAnswer(), groupAnswer(), groupAnswer(), schemeAnswer()])
    assert.deepEqual(merged.calls.map(request), [`PATCH /route-schemes/${CENTRAL_ID}`, `PATCH /collection-groups/${south.id}`, `PATCH /collection-groups/${north.id}`, `PATCH /route-schemes/${CENTRAL_ID}`])
    assert.deepEqual(bodyOf(merged.calls[1]), { days: [] }, "no delete: a group that no longer runs is parked")
    assert.deepEqual(bodyOf(merged.calls[2]), { days: [...WEEKDAYS] }, "the one group of the legacy shape keeps its own name")
  })

  test("a group removed from the front is parked, and the others keep their positions: nothing is renumbered", async () => {
    const [a, b, c] = ["a1", "a2", "a3"].map((n, index) => groupOf({ id: `01a0d2a4-a280-701b-8000-0000000000${n}`, routeSchemeId: CENTRAL_ID, name: `Group ${index + 1}`, position: index + 1, days: index === 2 ? ["friday"] : index === 1 ? ["wednesday", "thursday"] : ["monday", "tuesday"] }))
    const { calls } = await edited({ ...central, status: "draft", collectionGroups: [a, b, c] }, (row) => ({ ...withGroups((current) => current.slice(1))(row), status: "Draft" }), [groupAnswer(), schemeAnswer()])
    assert.deepEqual(calls.map(request), [`PATCH /collection-groups/${a.id}`, `GET /route-schemes/${CENTRAL_ID}`])
    assert.deepEqual(bodyOf(calls[0]), { days: [] })
  })

  test("a container moved between two manual groups on a shared day: the group that gives it up is written before the one that takes it", async () => {
    const giver = groupOf({ id: "01a0d2a4-a280-701b-8000-0000000000b2", routeSchemeId: OSTERBRO_ID, name: "Later", position: 2, days: ["tuesday"], stopSource: "manual", rule: null, containerIds: [PICKS[1], PICKS[2]] })
    const taker = groupOf({ id: "01a0d2a4-a280-701b-8000-0000000000b1", routeSchemeId: OSTERBRO_ID, name: "Earlier", position: 1, days: ["tuesday", "thursday"], stopSource: "manual", rule: null, containerIds: [PICKS[0]] })
    const moved = withGroups((current) => [
      { ...current[0], containerIds: [`asset-${PICKS[0]}`, `asset-${PICKS[2]}`] },
      { ...current[1], containerIds: [`asset-${PICKS[1]}`] },
    ])
    const { calls } = await edited({ ...osterbro, collectionGroups: [taker, giver] }, moved, [schemeAnswer({ status: "draft" }), groupAnswer(), groupAnswer(), schemeAnswer()])
    assert.deepEqual(calls.map(request), [
      `PATCH /route-schemes/${OSTERBRO_ID}`,
      `PUT /collection-groups/${giver.id}/containers`,
      `PUT /collection-groups/${taker.id}/containers`,
      `PATCH /route-schemes/${OSTERBRO_ID}`,
    ])
    assert.deepEqual(bodyOf(calls[1]), { containerIds: [PICKS[1]] })
    assert.deepEqual(bodyOf(calls[2]), { containerIds: [PICKS[0], PICKS[2]] })
  })

  test("a waste fraction renamed on the API since the schemes loaded: an edit that leaves the rule alone is not refused, and one that changes it names the fraction by the id it was read with", async () => {
    const renamed = new Map(state).set(
      "configure.master",
      loaded({ records: masterRecords.map(([record]) => (record.name === "Residual" ? { ...record, name: "Residual waste" } : record)), serverIds: new Map(masterRecords.map(([record, id]) => [record.id, id])) }, 1),
    )
    const start = await edited(central, withValues({ plannedStartTime: "07:00" }), [schemeAnswer()], renamed)
    assert.deepEqual(start.calls.map(request), [`PATCH /route-schemes/${CENTRAL_ID}`])
    assert.deepEqual(bodyOf(start.calls[0]), { plannedStartTime: "07:00" })
    const types = await edited(central, withValues({ matchContainerTypes: "Two-wheel bin · 240 L" }), [groupAnswer(), schemeAnswer()], renamed)
    assert.deepEqual(bodyOf(types.calls[0]), { wasteFractionIds: [residual.id], containerTypeIds: [bin240.id], vehicleTypeId: rearLoader.id })
  })

  test("is refused before the API where the wire cannot follow: a group changing how it finds its stops, a scheme changing project", async () => {
    const moved = await edited(central, withValues({ stopSelection: "manual", containerIds: `asset-${PICKS[0]}` }), [])
    assert.equal(moved.outcome.kind, "refused")
    assert.equal(moved.calls.length, 0)
    assert.equal(moved.outcome.kind === "refused" ? problemSentence(moved.outcome.problem) : "", "The request body is invalid — stopSelection: A collection group keeps how it finds its stops: add a group that picks containers and remove this one")
    const elsewhere = await edited(central, withValues({ projectId: "project-harbor" }), [])
    assert.equal(elsewhere.outcome.kind === "refused" ? problemSentence(elsewhere.outcome.problem) : "", "The request body is invalid — projectId: A scheme stays in its project")
  })

  test("a request refused midway: the scheme is validated again where it can be, read back, and the row shows what the server holds under the API's sentence", async () => {
    const draftNow = { ...central, status: "draft" as const, serviceDays: [...WEEKDAYS, "saturday"] as RouteScheme["serviceDays"] }
    const { outcome, calls } = await edited(central, withValues({ serviceDays: [...WEEKDAYS, "saturday"].join(", ") }), [
      () => json(draftNow),
      () => problem(409, "Vehicle WH-24 is on two collection groups that run on saturday: North, South"),
      () => problem(409, "Service days without a collection group: saturday"),
      () => json(draftNow),
    ])
    assert.deepEqual(calls.map(request), [`PATCH /route-schemes/${CENTRAL_ID}`, `PATCH /collection-groups/${CENTRAL_GROUP_ID}`, `PATCH /route-schemes/${CENTRAL_ID}`, `GET /route-schemes/${CENTRAL_ID}`])
    assert.deepEqual(bodyOf(calls[2]), { status: "validated" }, "the validation the draft step suspended is asked for again")
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.equal(problemSentence(outcome.problem), "Vehicle WH-24 is on two collection groups that run on saturday: North, South", "the request that failed is the one the person is told of")
    assert.equal(outcome.record?.status, "Draft", "the row shows the draft the server now holds, not the row as it was")
    assert.equal(outcome.record?.id, `scheme-${CENTRAL_ID}`)
  })
})

describe("the occurrence read", () => {
  test("is the API's preview of a scheme's dates in a window, both days inclusive", async () => {
    const rows: Occurrence[] = [
      { n: 1, date: "2026-10-05", plannedDate: "2026-10-05", week: 41, status: "planned" },
      { n: null, date: "2026-12-25", plannedDate: "2026-12-25", week: 52, status: "skipped", note: "Juledag" },
    ]
    const { fetch, calls } = scripted([() => json(rows)])
    assert.deepEqual(await schemeOccurrences(clientOver(fetch), CENTRAL_ID, { from: "2026-10-01", to: "2026-12-31" }), rows)
    assert.deepEqual(calls.map(request), [`GET /route-schemes/${CENTRAL_ID}/occurrences?from=2026-10-01&to=2026-12-31`])
  })
})
