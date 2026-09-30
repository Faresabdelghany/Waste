// Pickups on the adapter (#179, slice 6 of #81): a route's stops as the
// records of `route-studio.pickups`, which the Pickups table, the route's
// stops and the map read — the map placing an API route's stops through the
// fixture containers by label until #184 gives a server container its place
// — and the dispatcher's two commands on a stop, `remove` and
// `correct-outcome`, whose bodies are held here against the contracts' own
// zod schemas and sent through the store's seam over a scripted `fetch`. A
// pickup is never created or edited here: generation writes it, the driver
// decides it, and the office's commands move it.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { ContainerType, WasteFraction } from "@waste/contracts/catalogue"
import type { Container } from "@waste/contracts/containers"
import type { Project } from "@waste/contracts/organisation"
import { PickupCorrection, PickupRemove, REASON_WITH_A_MISS, type Pickup, type PickupDetail } from "@waste/contracts/pickups"
import type { ProofOfService } from "@waste/contracts/proofs"
import type { Route } from "@waste/contracts/routes"
import { routesInWindow } from "@waste/domain/map-planning/routes"

import { FIXTURE_COMPANY_ID, getModuleDefinition, type BusinessRecord } from "../../data/business-modules"
import { FIXTURE_GAZETTEER } from "../../data/street-gazetteer"
import { problemSentence } from "../problem"
import { NOTHING_RESOLVED, type MappingContext, type Resolver } from "../records/adapter"
import { containerAdapter } from "../records/containers"
import { containerTypeAdapter, wasteFractionAdapter } from "../records/master-data"
import { isServerBacked, SERVER_MODULE_KEYS } from "../records/modules"
import { projectAdapter } from "../records/organisation"
import { CORRECT_PICKUP, PICKUPS_MODULE, pickupAdapter, pickupProofs, pickupsModule, REASON_WITH_A_MISS as LOCAL_REASON_WITH_A_MISS, REMOVE_PICKUP } from "../records/pickups"
import { routeAdapter, routesWindowFrom } from "../records/routes"
import { commandRecord, loaded, loadModule, resolverOver, writeRecord, type ServerRecordsState } from "../records/server-records"
import { bodyOf, clientOver, json, problem, scripted } from "./scripted-fetch"

const NOW = new Date("2026-09-30T12:00:00Z")
const STAMPS = { createdAt: "2026-09-29T02:00:00.000Z", updatedAt: "2026-09-29T02:00:00.000Z" }

const fixturesOf = (workspaceId: "configure" | "resources" | "route-studio", moduleId: string) => getModuleDefinition({ workspaceId, moduleId })?.records ?? []
const fixtures = fixturesOf("route-studio", "pickups")

const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays" }
const residual: WasteFraction = { id: "01a0d2a4-a280-7005-8000-000000000001", ...STAMPS, key: "residual", name: "Residual" }
const bin240: ContainerType = { id: "01a0d2a4-a280-7008-8000-000000000002", ...STAMPS, name: "Two-wheel bin · 240 L", volumeLitres: 240 }
const container = (id: string, label: string): Container => ({ id, ...STAMPS, projectId: copenhagen.id, label, containerTypeId: bin240.id, barcode: null, rfid: null, serialNumber: null, ownership: "company", notes: null, assetState: null })
// Three seeded containers the fixtures place on the map (packages/db/src/seed/registry.ts, EXPLICIT_CONTAINERS).
const bin82014 = container("01a0d2a4-a280-7014-8000-000000000001", "BIN-82014")
const bin66420 = container("01a0d2a4-a280-7014-8000-000000000002", "BIN-66420")
const bin44831 = container("01a0d2a4-a280-7014-8000-000000000003", "BIN-44831")

const route: Route = {
  id: "01a0d2a4-a280-7030-8000-000000000001",
  ...STAMPS,
  projectId: copenhagen.id,
  routeSchemeId: "01a0d2a4-a280-7016-8000-000000000001",
  collectionGroupId: "01a0d2a4-a280-7017-8000-000000000001",
  serviceDate: "2026-10-01",
  operatingDate: "2026-10-01",
  number: 1042,
  label: "RC-1042",
  status: "active",
  note: null,
  cancelledByGeneration: false,
  generationRunId: null,
  plannedStartTime: "06:30",
  planned: { vehicleId: null, driverId: null, trailerId: null, serviceProviderId: null, depotId: null, unloadingStationId: null },
  actual: { vehicleId: null, driverId: null, trailerId: null },
  dispatchedAt: "2026-10-01T04:10:00.000Z",
  startedAt: "2026-10-01T04:31:00.000Z",
  completedAt: null,
  cancelledAt: null,
  progress: { planned: 2, completed: 1, skipped: 0, failed: 0, total: 3, fraction: 1 / 3 },
}
const pickupOf = (id: string, containerId: string, position: number, over: Partial<Pickup> = {}): Pickup => ({
  id,
  ...STAMPS,
  projectId: copenhagen.id,
  routeId: route.id,
  containerId,
  position,
  status: "planned",
  reason: null,
  note: null,
  propertyId: "01a0d2a4-a280-7011-8000-000000000001",
  sharedCollectionPointId: null,
  wasteFractionId: residual.id,
  arrivedAt: null,
  outcomeAt: null,
  ...over,
})
const first = pickupOf("01a0d2a4-a280-7033-8000-000000000001", bin82014.id, 1, { status: "completed", arrivedAt: "2026-10-01T04:12:00.000Z", outcomeAt: "2026-10-01T04:15:00.000Z" })
const second = pickupOf("01a0d2a4-a280-7033-8000-000000000002", bin66420.id, 2)
const third = pickupOf("01a0d2a4-a280-7033-8000-000000000003", bin44831.id, 3)

// What the store has loaded when the pickups load: the organisation, the master data, the containers, the routes.
const noResolve = (moduleFixtures: readonly BusinessRecord[], resolver: Resolver = NOTHING_RESOLVED): MappingContext => ({ fixtures: moduleFixtures, resolve: resolver, companyRecordId: FIXTURE_COMPANY_ID, now: NOW })
const serverIdsOf = (records: readonly BusinessRecord[], ids: readonly string[]) => new Map(records.map((record, index) => [record.id, ids[index]]))
const projectRecord = projectAdapter.toRecord(copenhagen, noResolve(fixturesOf("configure", "organization")))
const masterRecords = [wasteFractionAdapter.toRecord(residual, noResolve(fixturesOf("configure", "master"))), containerTypeAdapter.toRecord(bin240, noResolve(fixturesOf("configure", "master")))]
const before: ServerRecordsState = new Map([
  ["configure.organization", loaded({ records: [projectRecord], serverIds: serverIdsOf([projectRecord], [copenhagen.id]) }, 1)],
  ["configure.master", loaded({ records: masterRecords, serverIds: serverIdsOf(masterRecords, [residual.id, bin240.id]) }, 1)],
])
const containerRecords = [bin82014, bin66420, bin44831].map((row) => containerAdapter.toRecord({ ...row, placements: [] }, noResolve(fixturesOf("resources", "containers"), resolverOver(before))))
const routeRecord = routeAdapter.toRecord(route, noResolve(fixturesOf("route-studio", "routes"), resolverOver(before)))
const state: ServerRecordsState = new Map([
  ...before,
  ["resources.containers", loaded({ records: containerRecords, serverIds: serverIdsOf(containerRecords, [bin82014.id, bin66420.id, bin44831.id]) }, 1)],
  ["route-studio.routes", loaded({ records: [routeRecord], serverIds: serverIdsOf([routeRecord], [route.id]) }, 1)],
])
const context = (resolver: Resolver = resolverOver(state)): MappingContext => ({ fixtures, resolve: resolver, companyRecordId: FIXTURE_COMPANY_ID, now: NOW })
const options = { fixtures, state, now: NOW }
const pageOf = (items: unknown[], nextCursor: string | null = null) => json({ items, nextCursor })

describe("the pickups module", () => {
  test("is switched, after the routes, the containers and the master data its rows name", () => {
    assert.ok(isServerBacked(PICKUPS_MODULE.workspaceId, PICKUPS_MODULE.moduleId))
    const at = SERVER_MODULE_KEYS.indexOf("route-studio.pickups")
    for (const named of ["configure.organization", "configure.master", "resources.containers", "route-studio.routes"]) {
      assert.ok(at > SERVER_MODULE_KEYS.indexOf(named), `after ${named}`)
    }
  })

  test("reads every pickup of the routes' window, page after page, each pickup-<uuid>", async () => {
    const { fetch, calls } = scripted([() => pageOf([first, second], "next"), () => pageOf([third])])
    const from = routesWindowFrom()
    const result = await loadModule(clientOver(fetch), pickupsModule, options)
    assert.deepEqual(
      calls.map((call) => call.url),
      [`http://api.test/pickups?limit=200&from=${from}`, `http://api.test/pickups?limit=200&from=${from}&cursor=next`],
    )
    assert.deepEqual(
      result.records.map((record) => record.id),
      [first, second, third].map((pickup) => `pickup-${pickup.id}`),
    )
  })
})

describe("a pickup", () => {
  test("is the stop the Pickups table, the route's stops and the map read", () => {
    const record = pickupAdapter.toRecord(second, context())
    assert.equal(record.id, `pickup-${second.id}`)
    assert.equal(record.name, "Stop 2 · BIN-66420")
    assert.equal(record.context, "RC-1042 · Residual")
    assert.equal(record.status, "Planned")
    assert.equal(record.value, "Planned")
    assert.equal(record.recordKind, "Pickup")
    assert.equal(record.deepLink, `/route-studio?module=routes&record=${routeRecord.id}`)
    assert.deepEqual(record.projectIds, [projectRecord.id])
    assert.deepEqual(record.facts, {
      Route: "RC-1042",
      Stop: "2",
      Type: "Collection",
      "Container ID": "BIN-66420",
      "Waste fraction": "Residual",
      Project: "Copenhagen Central",
    })
    assert.deepEqual(record.submittedValues, {
      routeId: routeRecord.id,
      containerId: containerRecords[1].id,
      wasteFractionId: masterRecords[0].id,
      position: "2",
      schemeId: routeRecord.submittedValues?.schemeId,
      serviceDate: "2026-10-01",
      operatingDate: "2026-10-01",
      status: "planned",
    })
  })

  test("a decided stop says when, on the project's clock, and why it was missed", () => {
    const done = pickupAdapter.toRecord(first, context())
    assert.equal(done.status, "Completed")
    assert.equal(done.value, "06:15 · Completed")
    assert.equal(done.facts["Arrived at"], "06:12")
    assert.equal(done.facts["Completed at"], "06:15", "the map's playback reads the actual time here")
    const removed = pickupAdapter.toRecord({ ...second, status: "skipped", reason: "removed-by-dispatcher", note: "Blocked by roadworks", outcomeAt: "2026-10-01T04:40:00.000Z" }, context())
    assert.equal(removed.status, "Skipped")
    assert.equal(removed.value, "06:40 · Skipped")
    assert.equal(removed.facts.Reason, "Removed by dispatcher")
    assert.equal(removed.facts.Note, "Blocked by roadworks")
    assert.equal(removed.facts["Completed at"], undefined)
    assert.equal(removed.submittedValues?.reason, "removed-by-dispatcher")
  })

  test("names its route, container and fraction by id chip until their modules load", () => {
    const record = pickupAdapter.toRecord(second, context(NOTHING_RESOLVED))
    assert.equal(record.name, `Stop 2 · asset-${bin66420.id}`)
    assert.equal(record.facts.Route, `route-${route.id}`)
    assert.equal(record.submittedValues?.routeId, `route-${route.id}`)
    assert.equal(record.submittedValues?.containerId, `asset-${bin66420.id}`)
    assert.equal(record.facts["Container ID"], undefined, "no label to link a fixture container by")
  })

  test("the map draws an API route through the fixture containers, by the seeded containers' labels (#184)", () => {
    const pickups = [first, second, third].map((pickup) => pickupAdapter.toRecord(pickup, context()))
    const mapContainers = fixturesOf("resources", "containers")
    const [drawn] = routesInWindow([routeRecord], pickups, mapContainers, null, FIXTURE_GAZETTEER)
    assert.ok(drawn, "the route is drawable")
    assert.equal(drawn.id, routeRecord.id)
    assert.equal(drawn.bucket, "in-progress")
    assert.equal(drawn.stops.length, 3)
    assert.deepEqual(
      drawn.stops.map((stop) => stop.label),
      ["BIN-82014", "BIN-66420", "BIN-44831"],
    )
    assert.equal(drawn.stops[0].actual, "06:15")
    assert.equal(drawn.date, "2026-10-01")
  })

  test("is never created or edited here", async () => {
    assert.equal(pickupAdapter.toCreateBody, undefined)
    assert.equal(pickupAdapter.statuses, undefined)
    const record = pickupAdapter.toRecord(second, context())
    assert.deepEqual(pickupAdapter.toPatchBody(record, { ...record, name: "Stop 9" }, context()), { path: "", message: "A pickup is changed by its commands: remove it from a route that has not started, or correct its outcome" })
    const { fetch, calls } = scripted([])
    const current = loaded({ records: [record], serverIds: new Map([[record.id, second.id]]) }, 1)
    assert.equal((await writeRecord(clientOver(fetch), pickupsModule, current, { ...record, status: "Completed" }, options)).kind, "refused")
    assert.equal(calls.length, 0)
  })
})

describe("the pickup's commands", () => {
  const record = pickupAdapter.toRecord(second, context())
  const current = loaded({ records: [record], serverIds: new Map([[record.id, second.id]]) }, 1)
  const remove = pickupAdapter.commands?.[REMOVE_PICKUP]
  const correct = pickupAdapter.commands?.[CORRECT_PICKUP]
  const detail = (pickup: Pickup, proofs: ProofOfService[] = []): PickupDetail => ({ ...pickup, proofs })

  test("each names the route's modules too (`touches`): a stop removed or corrected moves its route's progress, on the Routes table and the Live board", () => {
    for (const [name, command] of Object.entries(pickupAdapter.commands ?? {})) assert.deepEqual(command.touches, ["route-studio.routes", "route-studio.live"], name)
  })

  test("remove carries its reason; without one it is refused here", async () => {
    const body = remove?.toBody?.({ reason: "Blocked by roadworks" }, record, context())
    assert.deepEqual(body, { reason: "Blocked by roadworks" })
    assert.ok(PickupRemove.safeParse(body).success)
    assert.deepEqual(remove?.toBody?.({ reason: "" }, record, context()), { path: "reason", message: "Say why the stop is removed" })
    const { fetch, calls } = scripted([() => json(detail({ ...second, status: "skipped", reason: "removed-by-dispatcher", note: "Blocked by roadworks", outcomeAt: "2026-10-01T04:40:00.000Z" }))])
    const outcome = await commandRecord(clientOver(fetch), pickupsModule, current, record, REMOVE_PICKUP, { reason: "Blocked by roadworks" }, options)
    assert.equal(calls[0].url, `http://api.test/pickups/${second.id}/remove`)
    assert.equal(calls[0].init.method, "POST")
    assert.equal(outcome.kind, "done")
    if (outcome.kind !== "done") return
    assert.equal(outcome.record.status, "Skipped")
    assert.equal(outcome.record.id, record.id)
  })

  test("the API's 409 on an active route's stop comes back as its sentence", async () => {
    const sentence = "Route RC-1042 is active; a stop is skipped by the driver"
    const { fetch } = scripted([() => problem(409, sentence)])
    const outcome = await commandRecord(clientOver(fetch), pickupsModule, current, record, REMOVE_PICKUP, { reason: "Blocked" }, options)
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.equal(outcome.what, "Stop 2 · BIN-66420 was not removed")
    assert.equal(problemSentence(outcome.problem), sentence)
  })

  test("a correction says the outcome and why; a reason goes with a miss and none with a completion", () => {
    const completed = correct?.toBody?.({ outcome: "completed", reason: "", note: "Collected, the driver's tap was lost" }, record, context())
    assert.deepEqual(completed, { outcome: "completed", note: "Collected, the driver's tap was lost" })
    assert.ok(PickupCorrection.safeParse(completed).success)
    const skipped = correct?.toBody?.({ outcome: "skipped", reason: "not-presented", note: "Bin was not out" }, record, context())
    assert.deepEqual(skipped, { outcome: "skipped", reason: "not-presented", note: "Bin was not out" })
    assert.ok(PickupCorrection.safeParse(skipped).success)
    assert.deepEqual(correct?.toBody?.({ outcome: "failed", reason: "", note: "x" }, record, context()), { path: "reason", message: REASON_WITH_A_MISS })
    assert.deepEqual(correct?.toBody?.({ outcome: "completed", reason: "capacity", note: "x" }, record, context()), { path: "reason", message: REASON_WITH_A_MISS })
    assert.deepEqual(correct?.toBody?.({ outcome: "planned", note: "x" }, record, context()), { path: "outcome", message: "Pick the outcome: completed, skipped or failed" })
    assert.deepEqual(correct?.toBody?.({ outcome: "skipped", reason: "lost", note: "x" }, record, context()), { path: "reason", message: "Pick a reason the API knows" })
    assert.deepEqual(correct?.toBody?.({ outcome: "completed", note: " " }, record, context()), { path: "note", message: "Say why the outcome is corrected" })
    assert.equal(LOCAL_REASON_WITH_A_MISS, REASON_WITH_A_MISS, "the web quotes the contract's sentence, since it imports no zod at runtime")
  })

  test("a correction posts to correct-outcome and the stop's answer replaces the row", async () => {
    const { fetch, calls } = scripted([() => json(detail({ ...second, status: "completed", outcomeAt: "2026-10-01T09:00:00.000Z" }))])
    const outcome = await commandRecord(clientOver(fetch), pickupsModule, current, record, CORRECT_PICKUP, { outcome: "completed", note: "Collected" }, options)
    assert.equal(calls[0].url, `http://api.test/pickups/${second.id}/correct-outcome`)
    assert.deepEqual(bodyOf(calls[0]), { outcome: "completed", note: "Collected" })
    assert.equal(outcome.kind, "done")
    if (outcome.kind !== "done") return
    assert.equal(outcome.record.status, "Completed")
    assert.equal(outcome.record.facts["Completed at"], "11:00")
  })

  test("the stop's proofs are its own read, in recording order", async () => {
    const proof: ProofOfService = { id: "01a0d2a4-a280-7034-8000-000000000001", recordedAt: "2026-10-01T04:15:00.000Z", projectId: copenhagen.id, routeId: route.id, pickupId: first.id, sessionId: "01a0d2a4-a280-7035-8000-000000000001", kind: "completion", source: "driver-app", occurredAt: "2026-10-01T04:15:00.000Z", recordedBy: "01a0d2a4-a280-7009-8000-000000000003", deviceId: "phone-1", location: null, locationAccuracyM: null, reason: null, note: null, weightKg: null, objectKey: null, outcome: null }
    const { fetch, calls } = scripted([() => json(detail(first, [proof]))])
    assert.deepEqual(await pickupProofs(clientOver(fetch), first.id), [proof])
    assert.equal(calls[0].url, `http://api.test/pickups/${first.id}`)
  })
})
