// A Route Scheme's lifecycle through the API (O21 of #290): the Plan Ahead
// window on the create and the patch; the archive — the scheme's delete,
// which erases nothing — cutting the period at the effective day, turning
// Plan Ahead off and ending the routes from that day as generation ends a
// shortened scheme's (planned ones cancelled, one carrying an office stop
// trimmed, dispatched ones kept and counted), and every later write refused;
// and the successor, the next version of the name from a day, written from
// its predecessor with its groups and seasons while the predecessor is cut
// there and its routes from the day ended. Each test makes its own draft
// scheme and writes its routes on it by hand, as generation would.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { RouteDetail } from "@waste/contracts/routes"
import { PLAN_AHEAD_DAYS_BOUND, RouteScheme, SchemeEndingCounts, type RouteSchemeArchived, type RouteSchemeSuccession } from "@waste/contracts/route-schemes"
import { createDb, type Database } from "@waste/db/client"
import { GENERATE_ROUTES_QUEUE } from "@waste/db/commands/generation"
import type { Send } from "@waste/db/jobs"
import { generationRun } from "@waste/db/schema/generation"
import { pickup, route } from "@waste/db/schema/execution"
import { SCHEME_ARCHIVED_NOTE, supersededNote } from "@waste/domain/planning/lifecycle"
import { eq, inArray } from "drizzle-orm"

import { createApp } from "../app"
import { dispatchedFrom, endsTomorrowAtTheEarliest } from "../routes/scheme-lifecycle"
import { schemeArchived } from "../routes/scheme-groups"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { seedExecution, seedRoute, type ExecutionFixtures } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures } from "./scheme-fixtures"
import { dropTenant, seedTenant, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The fixtures write proofs, a ledger the API role cannot delete, so the tenant is dropped as the owner. */
const owner = ownerUnderTest()

/** A Saturday noon in Copenhagen: tomorrow is Sunday 11 October, and the Mondays around it are the routes'. */
const NOW = new Date("2026-10-10T10:00:00Z")
const TOMORROW = "2026-10-11"
const LAST_MONDAY = "2026-10-05"
const MONDAYS = ["2026-10-12", "2026-10-19", "2026-10-26"] as const

const SUMMER = { name: "Summer", startsOn: "05-01", endsOn: "10-01", frequency: "every-2-weeks", weekRotation: "odd" }

describe("a route scheme's lifecycle (O21 of #290)", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let a: Tenant
  let fleet: FleetFixtures
  let ex: ExecutionFixtures
  let olivia: Call
  let keys: SigningKeys

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
    ex = await seedExecution(pool, a, fleet)
    const app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOW })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  const ok = async (response: Response, status = 200): Promise<unknown> => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await response.json()
  }
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }

  // The fixtures' routes each stand on a group minted for them, a rule group with no rule set (execution-fixtures.ts), which the resource's
  // schema would refuse; the answers are read by their counts, and the schemes as the API wrote them.
  const archived = (body: unknown): RouteSchemeArchived => {
    const answer = body as RouteSchemeArchived
    return { ...answer, routes: SchemeEndingCounts.parse(answer.routes) }
  }
  const succession = (body: unknown): RouteSchemeSuccession => {
    const answer = body as RouteSchemeSuccession
    return { ...answer, routes: SchemeEndingCounts.parse(answer.routes) }
  }

  /** A draft residual scheme of Copenhagen Central on Mondays from the start of the year, with one rule group. */
  const schemeNamed = async (name: string, values: Record<string, unknown> = {}): Promise<RouteScheme> =>
    RouteScheme.parse(
      await ok(
        await olivia("/route-schemes", {
          method: "POST",
          body: {
            projectId: a.projects.copenhagen.id,
            name,
            serviceType: "container-collection",
            frequency: "weekly",
            serviceDays: ["monday"],
            validFrom: "2026-01-01",
            collectionGroups: [{ name: "Round 1", days: ["monday"], stopSource: "rule", rule: { wasteFractionIds: [ex.fractions.residual.id], containerTypeIds: [], vehicleTypeId: null } }],
            ...values,
          },
        }),
        201,
      ),
    )
  /** A route of the scheme on a day, its three bins planned unless said otherwise. */
  const routeOf = (scheme: RouteScheme, day: string, seed: Parameters<typeof seedRoute>[4] = {}) =>
    seedRoute(pool, a, fleet, { ...ex, schemes: { ...ex.schemes, copenhagen: { id: scheme.id } } }, { operatingDate: day, ...seed })
  const archive = (id: string, body: unknown = {}) => olivia(`/route-schemes/${id}/archive`, { method: "POST", body })
  const successor = (id: string, body: unknown) => olivia(`/route-schemes/${id}/successor`, { method: "POST", body })
  const read = async (id: string): Promise<RouteDetail> => RouteDetail.parse(await ok(await olivia(`/routes/${id}`)))
  const stops = async (ids: readonly string[]) => Object.fromEntries((await ownerPool.db.select({ id: pickup.id, status: pickup.status, reason: pickup.reason, note: pickup.note }).from(pickup).where(inArray(pickup.id, [...ids]))).map((row) => [row.id, row]))

  test("the Plan Ahead window defaults to the week, moves through a patch, and is held to 28 days", async () => {
    const scheme = await schemeNamed("Window")
    assert.equal(scheme.planAheadDays, 7)
    assert.equal(scheme.archivedAt, null)
    const moved = RouteScheme.parse(await ok(await olivia(`/route-schemes/${scheme.id}`, { method: "PATCH", body: { planAheadDays: 14 } })))
    assert.equal(moved.planAheadDays, 14)
    const problem = await refused(await olivia(`/route-schemes/${scheme.id}`, { method: "PATCH", body: { planAheadDays: 29 } }), 400)
    assert.deepEqual(problem.errors, [{ path: "planAheadDays", message: PLAN_AHEAD_DAYS_BOUND }])
    assert.equal((await schemeNamed("Fortnight window", { planAheadDays: 14 })).planAheadDays, 14)
  })

  test("an archive cuts the period at tomorrow, turns Plan Ahead off, cancels the planned routes from then and keeps the rest", async () => {
    const scheme = await schemeNamed("Archived Mondays")
    const past = await routeOf(scheme, LAST_MONDAY, { status: "completed", pickups: [] })
    const planned = await routeOf(scheme, MONDAYS[0])
    const held = await routeOf(scheme, MONDAYS[1])
    const ready = await routeOf(scheme, MONDAYS[2], { status: "ready", plannedDriverId: fleet.drivers.mads.id })
    assert.equal((await ok(await olivia(`/routes/${held.id}/reschedule`, { method: "POST", body: { plannedStartTime: "05:45" } })) as { heldAt: string | null }).heldAt !== null, true, "the office held it")

    const answer = archived(await ok(await archive(scheme.id)))
    assert.deepEqual(answer.routes, { cancelled: 2, trimmed: 0, kept: 1 })
    assert.equal(answer.scheme.archivedAt, NOW.toISOString())
    assert.equal(answer.scheme.planAhead, false)
    assert.equal(answer.scheme.validTo, TOMORROW, "the first day it no longer runs")
    assert.equal(answer.scheme.status, "draft", "a draft stays a draft")
    assert.equal(answer.scheme.collectionGroups.length, 5, "its groups stay, the history of what it planned: its own and the four its routes stand on")

    for (const id of [planned.id, held.id]) {
      const cancelled = await read(id)
      assert.deepEqual([cancelled.status, cancelled.cancelReasonCode, cancelled.note, cancelled.heldAt], ["cancelled", "regeneration", SCHEME_ARCHIVED_NOTE, null])
    }
    const [row] = await ownerPool.db.select({ cancelledByGeneration: route.cancelledByGeneration }).from(route).where(eq(route.id, planned.id))
    assert.equal(row?.cancelledByGeneration, true)
    const skipped = await stops(planned.pickupIds)
    assert.ok(Object.values(skipped).every((stop) => stop.status === "skipped" && stop.reason === "regeneration" && stop.note === SCHEME_ARCHIVED_NOTE), JSON.stringify(skipped))
    assert.equal((await read(ready.id)).status, "ready", "a dispatched route is left for the office")
    assert.equal((await read(past.id)).status, "completed", "what ran stays as it ran")
  })

  test("a planned route carrying an office stop is trimmed, never cancelled under it: the scheme's stops go, the office's stand", async () => {
    const scheme = await schemeNamed("Archived with an office stop")
    const carrying = await routeOf(scheme, MONDAYS[0], {
      pickups: [
        { containerId: ex.containers.bin1.id, propertyId: ex.properties.parkvej.id },
        { containerId: ex.containers.bin2.id, propertyId: ex.properties.havnegade.id, origin: "office" },
      ],
    })
    const answer = archived(await ok(await archive(scheme.id)))
    assert.deepEqual(answer.routes, { cancelled: 0, trimmed: 1, kept: 0 })
    const trimmed = await read(carrying.id)
    assert.deepEqual([trimmed.status, trimmed.note], ["planned", SCHEME_ARCHIVED_NOTE])
    const [own, office] = carrying.pickupIds
    const after = await stops(carrying.pickupIds)
    assert.deepEqual([after[own].status, after[own].reason], ["skipped", "regeneration"])
    assert.deepEqual([after[office].status, after[office].reason], ["planned", null])
  })

  test("an archive from a later day keeps the routes before it; one before tomorrow is refused at its field, and nothing is written", async () => {
    const scheme = await schemeNamed("Archived later")
    const first = await routeOf(scheme, MONDAYS[0])
    const second = await routeOf(scheme, MONDAYS[1])
    const early = await refused(await archive(scheme.id, { effectiveFrom: "2026-10-10" }), 400)
    assert.deepEqual(early.errors, [{ path: "effectiveFrom", message: endsTomorrowAtTheEarliest(TOMORROW) }])
    assert.equal(((await ok(await olivia(`/route-schemes/${scheme.id}`))) as RouteScheme).archivedAt, null)

    const answer = archived(await ok(await archive(scheme.id, { effectiveFrom: MONDAYS[1] })))
    assert.equal(answer.scheme.validTo, MONDAYS[1])
    assert.deepEqual(answer.routes, { cancelled: 1, trimmed: 0, kept: 0 })
    assert.equal((await read(first.id)).status, "planned")
    assert.equal((await read(second.id)).status, "cancelled")
  })

  test("a validated scheme that has not started by the day goes back to draft and keeps its period", async () => {
    const scheme = await schemeNamed("Archived before it starts", { validFrom: "2027-01-04", status: "validated", planningAreaId: (await seedPlanningArea()).id })
    const answer = archived(await ok(await archive(scheme.id)))
    assert.deepEqual([answer.scheme.status, answer.scheme.validFrom, answer.scheme.validTo, answer.scheme.planAhead], ["draft", "2027-01-04", null, false])
  })

  test("an archived scheme reads whole — its groups, its seasons and the API's warnings — and refuses every write, a second archive and a successor among them, and the list tells it apart", async () => {
    const scheme = await schemeNamed("Archived for good", { seasons: [SUMMER] })
    await ok(await archive(scheme.id))
    const archivedRead = RouteScheme.parse(await ok(await olivia(`/route-schemes/${scheme.id}`)))
    assert.deepEqual([archivedRead.collectionGroups.map((group) => group.name), archivedRead.seasons], [["Round 1"], [SUMMER]], "its history stays readable")
    assert.ok(Array.isArray(archivedRead.warnings), "the reconciliation still reads")
    assert.notEqual(archivedRead.archivedAt, null)
    const sentence = schemeArchived("Archived for good")
    assert.equal((await refused(await archive(scheme.id), 409)).detail, sentence)
    assert.equal((await refused(await olivia(`/route-schemes/${scheme.id}`, { method: "PATCH", body: { name: "Back again" } }), 409)).detail, sentence)
    assert.equal((await refused(await olivia(`/route-schemes/${scheme.id}/generate`, { method: "POST", body: { from: MONDAYS[0], to: MONDAYS[2] } }), 409)).detail, sentence)
    assert.equal((await refused(await olivia(`/collection-groups/${scheme.collectionGroups[0].id}`, { method: "PATCH", body: { days: [] } }), 409)).detail, sentence)
    assert.equal((await refused(await olivia(`/route-schemes/${scheme.id}/collection-groups`, { method: "POST", body: { name: "Round 2", days: ["monday"], stopSource: "rule", rule: { wasteFractionIds: [ex.fractions.residual.id], containerTypeIds: [], vehicleTypeId: null } } }), 409)).detail, sentence)
    assert.equal((await refused(await successor(scheme.id, { validFrom: MONDAYS[1] }), 409)).detail, sentence)

    const archivedPage = (await ok(await olivia(`/route-schemes?projectId=${a.projects.copenhagen.id}&archived=true&limit=200`))) as { items: RouteScheme[] }
    assert.ok(archivedPage.items.some((item) => item.id === scheme.id) && archivedPage.items.every((item) => item.archivedAt !== null))
    const planning = (await ok(await olivia(`/route-schemes?projectId=${a.projects.copenhagen.id}&archived=false&limit=200`))) as { items: RouteScheme[] }
    assert.ok(planning.items.every((item) => item.archivedAt === null && item.id !== scheme.id))
  })

  test("a successor is the predecessor from the day, groups and seasons and window carried over; the predecessor ends there and its routes from the day go", async () => {
    const scheme = await schemeNamed("Versioned", { seasons: [SUMMER], planAheadDays: 10, plannedStartTime: "06:30" })
    const before = await routeOf(scheme, MONDAYS[0])
    const from = await routeOf(scheme, MONDAYS[1])
    const read = (await ok(await olivia(`/route-schemes/${scheme.id}`))) as RouteScheme

    const response = await successor(scheme.id, { validFrom: MONDAYS[1] })
    const answer = succession(await ok(response.clone(), 201))
    assert.equal(response.headers.get("location"), `/route-schemes/${answer.successor.id}`)
    assert.equal(answer.predecessor.validTo, MONDAYS[1])
    assert.deepEqual(answer.routes, { cancelled: 1, trimmed: 0, kept: 0 })
    assert.equal(answer.generationRunId, null, "a draft plans nothing")
    const next = answer.successor
    assert.notEqual(next.id, scheme.id)
    assert.deepEqual([next.name, next.validFrom, next.validTo, next.planAheadDays, next.plannedStartTime, next.status], ["Versioned", MONDAYS[1], null, 10, "06:30", "draft"])
    assert.deepEqual(next.seasons, [SUMMER])
    const shape = (groups: RouteScheme["collectionGroups"]) => groups.map(({ name, position, days, stopSource, rule, containerIds, vehicleId, driverId, serviceProviderId }) => ({ name, position, days, stopSource, rule, containerIds, vehicleId, driverId, serviceProviderId }))
    assert.deepEqual(shape(next.collectionGroups), shape(read.collectionGroups))
    assert.ok(next.collectionGroups.every((group) => !read.collectionGroups.some((old) => old.id === group.id)), "groups of its own")

    assert.equal((await readRoute(before.id)).status, "planned", "the predecessor still runs before the day")
    const gone = await readRoute(from.id)
    assert.deepEqual([gone.status, gone.note], ["cancelled", supersededNote(MONDAYS[1])])
  })

  test("a successor is refused while a route of the predecessor is dispatched or running on or after its day, since the new version would collect it again, and nothing is written", async () => {
    const scheme = await schemeNamed("Versioned under a dispatched route")
    await routeOf(scheme, MONDAYS[0], { status: "ready", plannedDriverId: fleet.drivers.mads.id })
    const after = await routeOf(scheme, MONDAYS[1], { status: "ready", plannedDriverId: fleet.drivers.mads.id })
    const planned = await routeOf(scheme, MONDAYS[2])
    const problem = await refused(await successor(scheme.id, { validFrom: MONDAYS[1] }), 409)
    assert.equal(problem.detail, dispatchedFrom([after.label], MONDAYS[1]), "the route on the day, not the one before it")
    assert.equal(((await ok(await olivia(`/route-schemes/${scheme.id}`))) as RouteScheme).validTo, null, "the predecessor is not cut")
    assert.equal((await readRoute(planned.id)).status, "planned", "and its planned routes stand")
    // From the day after the dispatched routes, the next version is taken.
    assert.equal(succession(await ok(await successor(scheme.id, { validFrom: MONDAYS[2] }), 201)).routes.cancelled, 1)
  })

  test("a validated successor is planned in the same transaction over its Plan Ahead window from its first day; a draft is not", async () => {
    const sent: { name: string; singletonKey: unknown }[] = []
    const jobs: { send: Send } = { send: async (name, _data, options) => (sent.push({ name, singletonKey: options?.singletonKey }), `job-${sent.length}`) }
    const office = callingAs(createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOW, jobs }), keys, a.users.olivia, a.companyId)
    const area = await seedPlanningArea()
    const scheme = await schemeNamed("Versioned and planned", { status: "validated", planningAreaId: area.id, planAheadDays: 10 })
    const answer = succession(await ok(await office(`/route-schemes/${scheme.id}/successor`, { method: "POST", body: { validFrom: MONDAYS[0] } }), 201))
    assert.equal(answer.successor.status, "validated")
    assert.notEqual(answer.generationRunId, null)
    assert.deepEqual(sent, [{ name: GENERATE_ROUTES_QUEUE, singletonKey: answer.successor.id }])
    const [run] = await ownerPool.db.select().from(generationRun).where(eq(generationRun.id, answer.generationRunId!))
    assert.deepEqual([run.routeSchemeId, run.windowFrom, run.windowTo, run.trigger, run.status], [answer.successor.id, MONDAYS[0], "2026-10-21", "on-demand", "queued"], "ten days from its first")

    sent.length = 0
    const draft = await schemeNamed("Versioned as a draft")
    const drafted = succession(await ok(await office(`/route-schemes/${draft.id}/successor`, { method: "POST", body: { validFrom: MONDAYS[0] } }), 201))
    assert.deepEqual([drafted.generationRunId, sent], [null, []], "a draft plans nothing")
  })

  test("a successor's day lies after the predecessor's start, before its end, and tomorrow at the earliest", async () => {
    const scheme = await schemeNamed("Versioned within", { validTo: "2026-12-01" })
    for (const validFrom of ["2026-10-10", "2026-12-01", "2027-02-01"]) {
      const problem = await refused(await successor(scheme.id, { validFrom }), 400)
      assert.deepEqual(problem.errors?.map((error) => error.path), ["validFrom"], validFrom)
    }
    assert.equal(RouteScheme.parse(await ok(await olivia(`/route-schemes/${scheme.id}`))).validTo, "2026-12-01", "nothing was cut")
  })

  const readRoute = read
  /** A planning area of Copenhagen Central, for a scheme validated with a rule group. */
  async function seedPlanningArea(): Promise<{ id: string }> {
    const response = await olivia("/planning-areas", { method: "POST", body: { projectId: a.projects.copenhagen.id, code: `LC-${Date.now()}`, name: `Lifecycle ${Date.now()}`, purpose: "route-planning" } })
    return (await ok(response, 201)) as { id: string }
  }
})
