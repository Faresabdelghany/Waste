import assert from "node:assert/strict"
import { after, before, beforeEach, describe, test } from "node:test"

import { CommandOutcomeRow, DriverCommandBatchOutcome, DriverCommandReceipt, DriverMe, EACH_COMMAND_ONCE, type CommandResult } from "@waste/contracts/driver-commands"
import { OBJECT_KEY_SHAPE } from "@waste/contracts/execution"
import { Page } from "@waste/contracts/pagination"
import { ProofOfService } from "@waste/contracts/proofs"
import { Route, RouteDetail } from "@waste/contracts/routes"
import { Session } from "@waste/contracts/sessions"
import { NET_IS_GROSS_LESS_TARE, Unload } from "@waste/contracts/unloads"
import { createDb, type Database } from "@waste/db/client"
import { driverCommand, outboxEvent, proofOfService, session as sessionTable } from "@waste/db/schema/execution"
import { vehicle as vehicleTable } from "@waste/db/schema/fleet"
import { withCompany } from "@waste/db/tenant"
import {
  alreadyOnRoute,
  BEFORE_THE_SESSION_STARTED,
  noPickupOnRoute,
  noRouteAssigned,
  NOT_A_FRACTION,
  NOT_A_POWERED_VEHICLE,
  NOT_A_STATION,
  NOT_A_TRAILER,
  notInService,
  OBJECT_KEY_NAMES_ANOTHER,
  objectKeyOf,
  RECORDED_AFTER_IT_HAPPENED,
  recordedTooLate,
  ROUTE_CANCELLED_NOTHING_TO_END,
} from "@waste/domain/execution/commands"
import { alreadyActive, alreadyDecided, doesNotChange, notActive, notDispatched } from "@waste/domain/execution/transitions"
import type { DriverCommandKind } from "@waste/domain/execution/vocabulary"
import { and, asc, count, eq, isNull } from "drizzle-orm"
import { Hono } from "hono"

import { createApp } from "../app"
import { NOT_A_DRIVERS_LOGIN } from "../auth/driver"
import { authenticate } from "../auth/principal"
import { errorHandler } from "../problem"
import { driverDoorRoutes } from "../routes/driver"
import { routeRoutes } from "../routes/routes"
import { COMMAND_BACKDATE_MS, OCCURRED_AT_SKEW_MS } from "../routes/shared"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { FIXTURE_DAY, routeFor, seedDriverFixtures, type DriverFixtures, type FixtureRoute, type RouteOptions } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures } from "./scheme-fixtures"
import { dropTenant, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the three ledgers and the outbox this suite writes, which `wms_api` may not delete. */
const owner = ownerUnderTest()

const RoutePage = Page(Route)
/** A page of receipts as the door answers it, every item the contract's shape — a rejection for a route the driver does not reach included, its `routeId` null. */
const ReceiptPage = Page(DriverCommandReceipt)

/** The request's clock: the afternoon of the operating date, pinned, so every instant a command carries (06:30 to 12:30) is behind it; moved by the tests that need it to move. */
const MORNING = new Date(`${FIXTURE_DAY}T14:00:00Z`)
/** An instant of the operating date, UTC. */
const at = (time: string): string => `${FIXTURE_DAY}T${time}:00.000Z`
/** An instant so many milliseconds from the pinned clock. */
const fromNow = (ms: number): string => new Date(MORNING.getTime() + ms).toISOString()

/** Ids that sort in the order they were minted: one millisecond apart, so a page over `id` is a page over upload order. */
let tick = Date.now()
const mint = (): string => testId((tick += 1))

type Envelope = { id: string; kind: DriverCommandKind; routeId: string; occurredAt: string; deviceId: string; body: unknown }
type EnvelopeOptions = { id?: string; occurredAt?: string; deviceId?: string }

/** One command as a device sends it: a fresh id and the morning's clock unless said. */
const envelope = (kind: DriverCommandKind, routeId: string, body: unknown, options: EnvelopeOptions = {}): Envelope => ({
  id: options.id ?? mint(),
  kind,
  routeId,
  occurredAt: options.occurredAt ?? at("06:30"),
  deviceId: options.deviceId ?? "device-mads-01",
  body,
})

describe("the driver door", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let now = MORNING
  /** The company under test, and the other one. */
  let a: Tenant
  let b: Tenant
  let fleet: FleetFixtures
  let theirFleet: FleetFixtures
  let fixtures: DriverFixtures
  let theirFixtures: DriverFixtures
  let app: ReturnType<typeof createApp>
  /** Where the door's log goes, for the two things it notes. */
  const logged: unknown[] = []
  let mads: Call
  let ali: Call
  let freja: Call
  let sofie: Call
  let karen: Call
  let olivia: Call
  let lars: Call
  let ungranted: Call
  let theirMads: Call

  before(async () => {
    pool = createDb(database.url, { max: 6 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
    theirFleet = await seedFleet(pool, b, await seedPlanning(pool, b))
    fixtures = await seedDriverFixtures(pool, a, fleet)
    theirFixtures = await seedDriverFixtures(pool, b, theirFleet)
    // The door under test, mounted with its own log so the two things it notes can be read, beside the office's route commands (routes/routes.ts) for the cancel that clears the yard between tests and the one a test sends mid-route; the whole app is what app.test.ts documents.
    const guard = authenticate({ pool, verifier: keys.verifier })
    const door = new Hono()
    door.onError(errorHandler())
    door.route("/", driverDoorRoutes(guard, { now: () => now, log: (entry) => logged.push(entry) }))
    door.route("/", routeRoutes(guard, { now: () => now }))
    app = door as unknown as ReturnType<typeof createApp>
    mads = callingAs(app, keys, fixtures.accounts.mads, a.companyId)
    ali = callingAs(app, keys, fixtures.accounts.ali, a.companyId)
    freja = callingAs(app, keys, fixtures.accounts.freja, a.companyId)
    sofie = callingAs(app, keys, fixtures.accounts.sofie, a.companyId)
    karen = callingAs(app, keys, fixtures.accounts.karen, a.companyId)
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    lars = callingAs(app, keys, a.users.lars, a.companyId)
    ungranted = callingAs(app, keys, a.users.viewer, a.companyId)
    theirMads = callingAs(app, keys, theirFixtures.accounts.mads, b.companyId)
  })
  /**
   * A driver runs one route at a time (`session_driver_open_idx`), so a
   * session one test leaves open would refuse the next test's `start-route`
   * for the driver's sake. Before each test the yard is quiet: every route of
   * the company with an open session is cancelled through the office's own
   * command, which ends the session and closes the open pickups the way a
   * dispatcher would.
   */
  beforeEach(async () => {
    if (!a) return
    const open = await withCompany(pool.db, a.companyId, (tx) => tx.select({ routeId: sessionTable.routeId }).from(sessionTable).where(and(eq(sessionTable.companyId, a.companyId), isNull(sessionTable.endedAt))))
    for (const found of open) await cancelled(found.routeId, "Cleared by the suite")
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    if (b) await dropTenant(pool, b.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  /** A route of company a, Mads's and ready unless said. */
  const minted = (options: Partial<RouteOptions> = {}) => routeFor(pool, a, fleet, fixtures, { driver: fleet.drivers.mads, ...options })
  /** The office's cancel (`POST /routes/:id/cancel`) as the dispatcher sends it: the route cancelled with the reason as its note, its open session ended, its open pickups closed. */
  const cancelled = async (routeId: string, reason: string): Promise<void> => {
    const response = await olivia(`/routes/${routeId}/cancel`, { method: "POST", body: { reason } })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
  }
  const detail = async (id: string, call = mads): Promise<RouteDetail> => {
    const response = await call(`/driver/routes/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return RouteDetail.parse(await response.json())
  }
  const send = async (commands: unknown[], call = mads): Promise<CommandOutcomeRow[]> => {
    const response = await call("/driver/commands", { method: "POST", body: { commands } })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return DriverCommandBatchOutcome.parse(await response.json()).outcomes
  }
  const one = async (command: Envelope, call = mads): Promise<CommandOutcomeRow> => {
    const [outcome] = await send([command], call)
    assert.equal(outcome.commandId, command.id)
    return outcome
  }
  const applied = async (command: Envelope, call = mads): Promise<CommandOutcomeRow> => {
    const outcome = await one(command, call)
    assert.equal(outcome.outcome, "applied", JSON.stringify(outcome.problem))
    return outcome
  }
  /** Sends the command and holds it rejected with the status and the sentence; answers the problem for the field checks. */
  const rejected = async (command: Envelope, status: number, detail: string, call = mads) => {
    const outcome = await one(command, call)
    assert.equal(outcome.outcome, "rejected", `${command.kind}: ${JSON.stringify(outcome)}`)
    assert.equal(outcome.problem?.status, status, `${command.kind}: ${JSON.stringify(outcome.problem)}`)
    assert.equal(outcome.problem?.detail, detail, command.kind)
    assert.equal(outcome.result, undefined)
    return outcome.problem!
  }
  /** The row an outcome carries, tagged as the resource asked for and parsed with its contract. */
  const valueOf = <T>(outcome: CommandOutcomeRow, resource: CommandResult["resource"], schema: { parse: (value: unknown) => T }): T => {
    assert.equal(outcome.result?.resource, resource, JSON.stringify(outcome))
    return schema.parse(outcome.result?.value)
  }
  /** Starts the route as Mads on WH-24 at 06:30 and answers the session's id, which is the command's. */
  const started = async (route: FixtureRoute, options: { call?: Call; vehicleId?: string; occurredAt?: string } = {}): Promise<string> => {
    const command = envelope("start-route", route.id, { vehicleId: options.vehicleId ?? fleet.vehicles.wh24.id, appVersion: "1.4.0" }, { occurredAt: options.occurredAt })
    const outcome = await applied(command, options.call)
    assert.equal(valueOf(outcome, "session", Session).id, command.id, "the session's id is the command's")
    return command.id
  }
  /** The outbox rows about one aggregate, in id order, as `wms_api` reads them. */
  const events = (aggregateId: string) =>
    withCompany(pool.db, a.companyId, (tx) =>
      tx
        .select({ kind: outboxEvent.kind, aggregateKind: outboxEvent.aggregateKind, occurredAt: outboxEvent.occurredAt, payload: outboxEvent.payload, publishedAt: outboxEvent.publishedAt, projectId: outboxEvent.projectId })
        .from(outboxEvent)
        .where(and(eq(outboxEvent.companyId, a.companyId), eq(outboxEvent.aggregateId, aggregateId)))
        .orderBy(asc(outboxEvent.id)),
    )
  const receipts = async (query = "?limit=200", call = mads) => {
    const response = await call(`/driver/commands${query}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return ReceiptPage.parse(await response.json())
  }
  /** How many rows the company has in each of the tables a replay must not touch. */
  const written = () =>
    withCompany(pool.db, a.companyId, async (tx) => {
      const [[proofs], [commands], [outbox]] = await Promise.all([
        tx.select({ n: count() }).from(proofOfService).where(eq(proofOfService.companyId, a.companyId)),
        tx.select({ n: count() }).from(driverCommand).where(eq(driverCommand.companyId, a.companyId)),
        tx.select({ n: count() }).from(outboxEvent).where(eq(outboxEvent.companyId, a.companyId)),
      ])
      return { proofs: proofs.n, commands: commands.n, outbox: outbox.n }
    })
  const sessionRow = async (id: string) => {
    const [row] = await withCompany(pool.db, a.companyId, (tx) => tx.select().from(sessionTable).where(and(eq(sessionTable.companyId, a.companyId), eq(sessionTable.id, id))))
    assert.ok(row, `session ${id}`)
    return row
  }
  const photoKey = (route: FixtureRoute, commandId: string) => objectKeyOf({ companyId: a.companyId, routeId: route.id, commandId }, "jpg")

  describe("who may knock", () => {
    test("an account no active driver profile is bound to is refused for the whole request, whatever its grants", async () => {
      for (const [who, call] of [
        ["Olivia, the administrator", olivia],
        ["Karen, an inactive driver", karen],
      ] as const) {
        for (const path of ["/driver/me", "/driver/routes", `/driver/routes/${testId()}`, "/driver/commands"]) {
          const problem = await refused(await call(path), 403)
          assert.equal(problem.detail, NOT_A_DRIVERS_LOGIN, `${who} on ${path}`)
        }
        const problem = await refused(await call("/driver/commands", { method: "POST", body: { commands: [envelope("pause", testId(), {})] } }), 403)
        assert.equal(problem.detail, NOT_A_DRIVERS_LOGIN, `${who} commanding`)
      }
    })

    test("the grant comes first: a role without operate.driver-app is refused as a role, and view without edit reads and does not command", async () => {
      const problem = await refused(await ungranted("/driver/me"), 403)
      assert.equal(problem.detail, "This account's role does not allow view on operate.driver-app")
      // Lars's charter grants `operate` view: he may read (and is then not a driver) but may not command.
      assert.equal((await refused(await lars("/driver/me"), 403)).detail, NOT_A_DRIVERS_LOGIN)
      assert.equal((await refused(await lars("/driver/commands", { method: "POST", body: { commands: [envelope("pause", testId(), {})] } }), 403)).detail, "This account's role does not allow edit on operate.driver-app")
    })
  })

  describe("GET /driver/me and GET /driver/routes", () => {
    test("answer the driver's profile, no session yet, and the ready routes assigned to them — not a planned one, not another driver's", async () => {
      const ready = await minted({ pickups: 3 })
      const planned = await minted({ status: "planned" })
      const jonass = await minted({ driver: fleet.drivers.jonas })
      const response = await mads("/driver/me")
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
      const me = DriverMe.parse(await response.json())
      assert.deepEqual([me.driver.id, me.driver.name, me.driver.userAccountId, me.driver.employment, me.driver.licenceClass], [fleet.drivers.mads.id, "Mads Jensen", fixtures.accounts.mads.id, "employee", "ce"])
      assert.equal(me.openSession, null)
      const ids = me.routes.map((route) => route.id)
      assert.ok(ids.includes(ready.id), "the ready route is the day's")
      assert.ok(!ids.includes(planned.id), "a planned route reaches no device")
      assert.ok(!ids.includes(jonass.id), "Jonas's route is not Mads's")
      const found = me.routes.find((route) => route.id === ready.id)!
      assert.deepEqual([found.label, found.number, found.status, found.planned.driverId, found.planned.vehicleId, found.progress], [ready.label, ready.number, "ready", fleet.drivers.mads.id, fleet.vehicles.wh24.id, { planned: 3, completed: 0, skipped: 0, failed: 0, total: 3, fraction: 0 }])
      assert.equal(found.actual.driverId, null)
      assert.ok(found.dispatchedAt !== null, "a ready route was dispatched")

      const page = RoutePage.parse(await (await mads("/driver/routes?limit=200")).json())
      assert.deepEqual(
        page.items.map((route) => route.id).sort(),
        me.routes.map((route) => route.id).sort(),
        "the list is the same routes",
      )
      const readyOnly = RoutePage.parse(await (await mads("/driver/routes?status=ready&limit=200")).json())
      assert.ok(readyOnly.items.every((route) => route.status === "ready"))
      assert.deepEqual(RoutePage.parse(await (await mads("/driver/routes?status=planned")).json()).items, [], "planned is not a status of the day")
      const bad = await refused(await mads("/driver/routes?status=draft"), 400)
      assert.deepEqual(bad.errors?.map((error) => error.path), ["status"])
      await minted()
      const cursor = RoutePage.parse(await (await mads("/driver/routes?limit=1")).json())
      assert.equal(cursor.items.length, 1)
      assert.ok(cursor.nextCursor !== null, "two ready routes today, one per page")
    })

    test("another company's driver sees their own routes and none of these", async () => {
      const ours = await minted()
      const theirs = await routeFor(pool, b, theirFleet, theirFixtures, { driver: theirFleet.drivers.mads })
      const page = RoutePage.parse(await (await theirMads("/driver/routes?limit=200")).json())
      assert.ok(page.items.some((route) => route.id === theirs.id))
      assert.ok(!page.items.some((route) => route.id === ours.id))
      assert.equal((await refused(await theirMads(`/driver/routes/${ours.id}`), 404)).detail, noRouteAssigned(ours.id))
    })
  })

  describe("GET /driver/routes/:id", () => {
    test("answers the route with its pickups by position, no session and no unloads yet", async () => {
      const route = await minted({ pickups: 3 })
      const found = await detail(route.id)
      assert.deepEqual([found.id, found.label, found.status, found.session, found.sessions, found.unloads], [route.id, route.label, "ready", null, [], []])
      assert.deepEqual(
        found.pickups.map((pickup) => [pickup.id, pickup.position, pickup.status, pickup.reason, pickup.arrivedAt, pickup.outcomeAt, pickup.propertyId, pickup.wasteFractionId]),
        route.pickupIds.map((id, index) => [id, index + 1, "planned", null, null, null, fixtures.property.id, fixtures.residual.id]),
      )
      assert.deepEqual(found.planned, { vehicleId: fleet.vehicles.wh24.id, driverId: fleet.drivers.mads.id, trailerId: null, serviceProviderId: null, depotId: fleet.depots.nordhavn.id, unloadingStationId: fleet.stations.amager.id })
      assert.equal(found.plannedStartTime, "06:30")
      assert.equal(found.operatingDate, FIXTURE_DAY)
      const planned = await minted({ status: "planned" })
      assert.equal((await detail(planned.id)).status, "planned", "assigned is assigned, whatever the status")
    })

    test("a route not assigned to this driver, of another company, or not there is one sentence (404)", async () => {
      const jonass = await minted({ driver: fleet.drivers.jonas })
      const nobodys = await minted({ driver: null })
      const theirs = await routeFor(pool, b, theirFleet, theirFixtures, { driver: theirFleet.drivers.mads })
      for (const id of [jonass.id, nobodys.id, theirs.id, testId()]) {
        assert.equal((await refused(await mads(`/driver/routes/${id}`), 404)).detail, noRouteAssigned(id))
      }
      assert.deepEqual((await refused(await mads("/driver/routes/not-an-id"), 400)).errors?.map((error) => error.path), ["id"])
    })
  })

  describe("POST /driver/commands: the batch", () => {
    test("refuses a batch that does not parse with a 400 and records nothing", async () => {
      const route = await minted()
      const before = await written()
      const empty = await refused(await mads("/driver/commands", { method: "POST", body: { commands: [] } }), 400)
      assert.deepEqual(empty.errors?.map((error) => error.path), ["commands"])
      const twice = envelope("pause", route.id, {})
      const doubled = await refused(await mads("/driver/commands", { method: "POST", body: { commands: [twice, { ...twice }] } }), 400)
      assert.deepEqual(doubled.errors, [{ path: "commands", message: EACH_COMMAND_ONCE }])
      const many = await refused(await mads("/driver/commands", { method: "POST", body: { commands: Array.from({ length: 201 }, () => envelope("pause", route.id, {})) } }), 400)
      assert.deepEqual(many.errors?.map((error) => error.path), ["commands"])
      const shapeless = await refused(
        await mads("/driver/commands", { method: "POST", body: { commands: [{ ...envelope("pause", route.id, {}), id: "not-a-uuid", kind: "teleport", extra: 1 }] } }),
        400,
      )
      // The member the envelope does not know is refused at its own path (#74), beside the id and the kind that do not parse.
      assert.deepEqual(new Set(shapeless.errors?.map((error) => error.path)), new Set(["commands.0.id", "commands.0.kind", "commands.0.extra"]))
      assert.deepEqual(await written(), before, "nothing applied, nothing recorded")
    })

    test("records a body that fails its kind's schema as a rejection with the schema's issues, and applies the rest of the batch in order", async () => {
      const route = await minted({ pickups: 2 })
      const start = envelope("start-route", route.id, { vehicleId: fleet.vehicles.wh24.id })
      const shapeless = envelope("arrive", route.id, { pickupId: "twelve", where: "here" }, { occurredAt: at("06:40") })
      const arrive = envelope("arrive", route.id, { pickupId: route.pickupIds[0] }, { occurredAt: at("06:41") })
      const outcomes = await send([start, shapeless, arrive])
      assert.deepEqual(
        outcomes.map((outcome) => [outcome.commandId, outcome.outcome]),
        [
          [start.id, "applied"],
          [shapeless.id, "rejected"],
          [arrive.id, "applied"],
        ],
        "one rejection, the rest applied, in body order",
      )
      const problem = outcomes[1].problem!
      assert.equal(problem.status, 400)
      assert.equal(problem.detail, "The request body is invalid")
      assert.deepEqual(new Set(problem.errors?.map((error) => error.path)), new Set(["body.pickupId", "body"]), "the paths are dotted into the command")

      const page = await receipts(`?routeId=${route.id}`)
      assert.deepEqual(
        page.items.map((receipt) => [receipt.id, receipt.kind, receipt.outcome]),
        [
          [start.id, "start-route", "applied"],
          [shapeless.id, "arrive", "rejected"],
          [arrive.id, "arrive", "applied"],
        ],
      )
      const [, refusedReceipt] = page.items
      assert.deepEqual(refusedReceipt.body, { pickupId: "twelve", where: "here" }, "the body verbatim")
      assert.deepEqual(refusedReceipt.problem, problem)
      assert.deepEqual([refusedReceipt.sessionId, refusedReceipt.pickupId, refusedReceipt.driverId, refusedReceipt.deviceId, refusedReceipt.occurredAt], [start.id, null, fleet.drivers.mads.id, "device-mads-01", at("06:40")])
      const [rejection] = await events(shapeless.id)
      assert.equal(rejection.kind, "command-rejected")
      assert.equal(rejection.aggregateKind, "command")
      assert.deepEqual(rejection.payload, refusedReceipt, "the receipt is the payload")
      assert.equal(rejection.occurredAt.toISOString(), at("06:40"), "the command's instant, not the request's")
      assert.equal(rejection.publishedAt, null)
    })

    test("a command naming a route the driver does not reach — another company's, another project's, or none — is its 404, and is recorded without a route with the claimed id kept in the body", async () => {
      const theirs = await routeFor(pool, b, theirFleet, theirFixtures, { driver: theirFleet.drivers.mads })
      const harbors = await routeFor(pool, a, fleet, fixtures, { driver: fleet.drivers.henrik, project: "harbor" })
      const jonass = await minted({ driver: fleet.drivers.jonas })
      const nowhere = testId()
      const before = await written()
      const sent: Envelope[] = []
      for (const id of [theirs.id, harbors.id, nowhere]) {
        const command = envelope("start-route", id, { vehicleId: fleet.vehicles.wh24.id })
        sent.push(command)
        await rejected(command, 404, noRouteAssigned(id))
      }
      const unassigned = envelope("start-route", jonass.id, { vehicleId: fleet.vehicles.wh24.id })
      await rejected(unassigned, 404, noRouteAssigned(jonass.id))
      assert.equal((await written()).commands - before.commands, 4, "every rejection is recorded")

      const page = await receipts("?limit=200")
      for (const command of sent) {
        const receipt = page.items.find((item) => item.id === command.id)
        assert.ok(receipt, `${command.routeId} recorded`)
        assert.deepEqual(
          [receipt.routeId, receipt.projectId, receipt.sessionId, receipt.pickupId, receipt.outcome, receipt.problem?.detail, receipt.body],
          [null, a.projects.copenhagen.id, null, null, "rejected", noRouteAssigned(command.routeId), { routeId: command.routeId, body: { vehicleId: fleet.vehicles.wh24.id } }],
          "no route, the driver's project, the claimed id beside the body",
        )
        assert.deepEqual(DriverCommandReceipt.parse(receipt), receipt, "a receipt without a route is the contract's shape: `routeId` is nullable there as in the column")
        const [rejection] = await events(command.id)
        assert.deepEqual([rejection.kind, rejection.projectId, (rejection.payload as { routeId: unknown }).routeId], ["command-rejected", a.projects.copenhagen.id, null])
      }
      // Jonas's route is a Copenhagen route the driver does not reach but the receipt can name: recorded with it.
      const jonasReceipt = page.items.find((item) => item.id === unassigned.id)
      assert.deepEqual([jonasReceipt?.routeId, jonasReceipt?.body], [jonass.id, { vehicleId: fleet.vehicles.wh24.id }])
      assert.deepEqual((await receipts(`?routeId=${jonass.id}`)).items.map((item) => item.id), [unassigned.id], "and filtered by it")
    })
  })

  describe("start-route", () => {
    test("opens the session with the command's id, moves the route to active with its actual assignment, stamps the instants, and writes route-started", async () => {
      const route = await minted({ pickups: 2 })
      const command = envelope("start-route", route.id, { vehicleId: fleet.vehicles.wh24.id, trailerId: fleet.vehicles.trailer.id, appVersion: "1.4.0", location: { type: "Point", coordinates: [12.5951, 55.7089] } })
      const outcome = await applied(command)
      const session = valueOf(outcome, "session", Session)
      assert.deepEqual(
        [session.id, session.routeId, session.driverId, session.vehicleId, session.trailerId, session.deviceId, session.appVersion, session.startedAt, session.endedAt, session.pausedAt, session.lastSeenAt, session.projectId],
        [command.id, route.id, fleet.drivers.mads.id, fleet.vehicles.wh24.id, fleet.vehicles.trailer.id, "device-mads-01", "1.4.0", at("06:30"), null, null, now.toISOString(), a.projects.copenhagen.id],
      )
      const found = await detail(route.id)
      assert.equal(found.status, "active")
      assert.deepEqual(found.actual, { vehicleId: fleet.vehicles.wh24.id, driverId: fleet.drivers.mads.id, trailerId: fleet.vehicles.trailer.id })
      assert.equal(found.startedAt, at("06:30"))
      assert.deepEqual(found.session, session)
      assert.deepEqual(found.sessions, [session])
      const me = DriverMe.parse(await (await mads("/driver/me")).json())
      assert.deepEqual(me.openSession, session)

      const [startedEvent] = await events(route.id)
      assert.deepEqual([startedEvent.kind, startedEvent.aggregateKind, startedEvent.projectId, startedEvent.occurredAt.toISOString()], ["route-started", "route", a.projects.copenhagen.id, at("06:30")])
      const payload = Route.parse(startedEvent.payload)
      assert.deepEqual([payload.id, payload.status, payload.actual.driverId, payload.progress.total], [route.id, "active", fleet.drivers.mads.id, 2])

      const page = await receipts(`?routeId=${route.id}`)
      assert.deepEqual(page.items.map((receipt) => [receipt.id, receipt.kind, receipt.outcome, receipt.sessionId, receipt.problem]), [[command.id, "start-route", "applied", command.id, null]])
    })

    test("refuses a planned route, another driver's, nobody's, an active one, and a completed one, each in its sentence", async () => {
      const planned = await minted({ status: "planned" })
      await rejected(envelope("start-route", planned.id, { vehicleId: fleet.vehicles.wh24.id }), 409, notDispatched(planned.label))
      const jonass = await minted({ driver: fleet.drivers.jonas })
      await rejected(envelope("start-route", jonass.id, { vehicleId: fleet.vehicles.wh24.id }), 404, noRouteAssigned(jonass.id))
      const nobodys = await minted({ driver: null })
      await rejected(envelope("start-route", nobodys.id, { vehicleId: fleet.vehicles.wh24.id }), 404, noRouteAssigned(nobodys.id))

      const running = await minted()
      await started(running)
      await rejected(envelope("start-route", running.id, { vehicleId: fleet.vehicles.wh24.id }), 409, alreadyActive(running.label))
      // With a session open, a second ready route is refused for the driver's sake, not the route's.
      const second = await minted()
      await rejected(envelope("start-route", second.id, { vehicleId: fleet.vehicles.wh24.id }), 409, alreadyOnRoute("Mads Jensen", running.label))
      await applied(envelope("end-route", running.id, {}, { occurredAt: at("12:00") }))
      await rejected(envelope("start-route", running.id, { vehicleId: fleet.vehicles.wh24.id }, { occurredAt: at("12:30") }), 409, doesNotChange(running.label, "completed"))
      // The session ended, the second route may start.
      await started(second, { occurredAt: at("12:30") })
    })

    test("holds the vehicle and the trailer to the project and their kinds (400), the licence to the operating date (400), then their status (409)", async () => {
      const route = await minted()
      const vehicleIs = (vehicleId: string, trailerId?: string) => envelope("start-route", route.id, trailerId === undefined ? { vehicleId } : { vehicleId, trailerId })
      for (const [what, id] of [
        ["a trailer", fleet.vehicles.trailer.id],
        ["Harbor's truck", fleet.vehicles.harborTruck.id],
        ["another company's", theirFleet.vehicles.wh24.id],
        ["nobody's", testId()],
      ] as const) {
        const problem = await rejected(vehicleIs(id), 400, NOT_A_POWERED_VEHICLE)
        assert.deepEqual(problem.errors, [{ path: "body.vehicleId", message: NOT_A_POWERED_VEHICLE }], what)
      }
      const asTrailer = await rejected(vehicleIs(fleet.vehicles.wh24.id, fleet.vehicles.wh25.id), 400, NOT_A_TRAILER)
      assert.deepEqual(asTrailer.errors, [{ path: "body.trailerId", message: NOT_A_TRAILER }])
      await rejected(vehicleIs(fleet.vehicles.retired.id), 409, notInService("WH-99", "retired", "vehicle"))
      await rejected(vehicleIs(fleet.vehicles.wh24.id, fleet.vehicles.retiredTrailer.id), 409, notInService("WH-T99", "retired", "trailer"))
      assert.equal(notInService("WH-99", "retired", "vehicle"), "WH-99 is retired; a route needs a vehicle in service", "the sentence, pinned")
      // Not only retired: a truck in the workshop today does not go out today, and the sentence names the status.
      await withCompany(pool.db, a.companyId, (tx) => tx.update(vehicleTable).set({ status: "maintenance" }).where(and(eq(vehicleTable.companyId, a.companyId), eq(vehicleTable.id, fleet.vehicles.drifting.id))))
      await rejected(vehicleIs(fleet.vehicles.drifting.id), 409, "WH-77 is maintenance; a route needs a vehicle in service")

      const frejas = await minted({ driver: fleet.drivers.freja })
      const tooLow = await rejected(envelope("start-route", frejas.id, { vehicleId: fleet.vehicles.wh24.id }), 400, "Freja Holm needs a C licence for WH-24", freja)
      assert.deepEqual(tooLow.errors, [{ path: "body.vehicleId", message: "Freja Holm needs a C licence for WH-24" }])
      const sofies = await minted({ driver: fleet.drivers.sofie })
      await rejected(envelope("start-route", sofies.id, { vehicleId: fleet.vehicles.wh24.id }), 400, "Sofie Nielsen's licence expires on 2026-09-05, before the operating date", sofie)
      // The licence is judged before the status: a retired truck Freja may not drive is her licence's refusal first.
      await rejected(envelope("start-route", frejas.id, { vehicleId: fleet.vehicles.retired.id }), 400, "Freja Holm needs a C licence for WH-99", freja)
    })
  })

  describe("the clock", () => {
    test("refuses an instant more than five minutes ahead or forty-eight hours behind the request, and one before the session started", async () => {
      const route = await minted()
      const ahead = await rejected(envelope("start-route", route.id, { vehicleId: fleet.vehicles.wh24.id }, { occurredAt: fromNow(6 * 60_000) }), 400, RECORDED_AFTER_IT_HAPPENED)
      assert.deepEqual(ahead.errors, [{ path: "occurredAt", message: RECORDED_AFTER_IT_HAPPENED }])
      assert.equal(RECORDED_AFTER_IT_HAPPENED, "Recorded after it happened")
      const late = await rejected(envelope("start-route", route.id, { vehicleId: fleet.vehicles.wh24.id }, { occurredAt: fromNow(-49 * 3_600_000) }), 400, recordedTooLate(COMMAND_BACKDATE_MS))
      assert.deepEqual(late.errors, [{ path: "occurredAt", message: "Recorded more than 48 hours after it happened" }])
      assert.equal(COMMAND_BACKDATE_MS, 48 * 3_600_000)
      assert.equal(OCCURRED_AT_SKEW_MS, 5 * 60_000)
      // Inside both bounds: four minutes ahead is a device's clock.
      await started(route, { occurredAt: fromNow(4 * 60_000) })
      const early = await rejected(envelope("arrive", route.id, { pickupId: route.pickupIds[0] }, { occurredAt: at("06:00") }), 400, BEFORE_THE_SESSION_STARTED)
      assert.deepEqual(early.errors, [{ path: "occurredAt", message: "Before the session started" }])
    })
  })

  describe("every later command on a route that is not active", () => {
    /** A valid body of each kind after start-route, for a route with a first pickup. */
    const bodies = (route: FixtureRoute, commandId: string): [DriverCommandKind, unknown][] => [
      ["arrive", { pickupId: route.pickupIds[0] }],
      ["complete-pickup", { pickupId: route.pickupIds[0] }],
      ["skip-pickup", { pickupId: route.pickupIds[0], reason: "inaccessible" }],
      ["fail-pickup", { pickupId: route.pickupIds[0], reason: "contamination" }],
      ["report-problem", { reason: "safety", note: "Road closed" }],
      ["add-photo", { objectKey: photoKey(route, commandId) }],
      ["add-weight", { pickupId: route.pickupIds[0], weightKg: 148 }],
      ["add-signature", { pickupId: route.pickupIds[0], objectKey: photoKey(route, commandId) }],
      ["add-note", { note: "Gate code 1234" }],
      ["record-unload", { unloadingStationId: fleet.stations.amager.id, wasteFractionId: fixtures.residual.id, netKg: 4200 }],
      ["pause", {}],
      ["resume", {}],
      ["end-route", {}],
    ]

    test("is refused with the route's sentence on a ready route, a planned one and a completed one", async () => {
      const ready = await minted()
      const planned = await minted({ status: "planned" })
      const done = await minted()
      await started(done)
      await applied(envelope("end-route", done.id, {}, { occurredAt: at("12:00") }))
      for (const route of [ready, planned, done]) {
        for (const [kind, body] of bodies(route, "")) {
          const id = mint()
          const command = envelope(kind, route.id, kind === "add-photo" || kind === "add-signature" ? { ...(body as object), objectKey: photoKey(route, id) } : body, { id, occurredAt: at("12:30") })
          await rejected(command, 409, notActive(route.label))
        }
      }
      assert.equal(notActive("RC-1042"), "Route RC-1042 is not active")
    })

    test("end-route on a route the office cancelled meanwhile is applied as nothing, with the reason in the log", async () => {
      const route = await minted()
      const sessionId = await started(route)
      // The office's cancel, while the device is out: the route cancelled with the reason as its note, the session ended.
      await cancelled(route.id, "Truck broke down")
      assert.equal((await sessionRow(sessionId)).endedAt?.toISOString(), now.toISOString(), "the dispatcher ended the session")
      logged.length = 0
      const end = envelope("end-route", route.id, { note: "Heading home" }, { occurredAt: at("07:30") })
      const outcome = await applied(end)
      assert.equal(valueOf(outcome, "route", Route).status, "cancelled", "the route as it stands, read back")
      assert.deepEqual(logged, [{ commandId: end.id, kind: "end-route", routeId: route.id, note: ROUTE_CANCELLED_NOTHING_TO_END }])
      const [receipt] = (await receipts(`?routeId=${route.id}`)).items.filter((item) => item.id === end.id)
      assert.deepEqual([receipt.outcome, receipt.sessionId, receipt.problem], ["applied", null, null], "recorded as applied, on no open session")
      assert.deepEqual((await events(route.id)).map((event) => event.kind), ["route-started", "route-cancelled"], "the cancel was the last word; the end has nothing to tell anyone")
      // Anything else on it is the route's refusal.
      await rejected(envelope("arrive", route.id, { pickupId: route.pickupIds[0] }, { occurredAt: at("07:31") }), 409, notActive(route.label))
    })

    test("is refused on another driver's active route with the assignment's 404", async () => {
      const alis = await routeFor(pool, a, fleet, fixtures, { driver: fixtures.drivers.ali, serviceProviderId: a.serviceProviders.nordren.id })
      await started(alis, { call: ali })
      await rejected(envelope("arrive", alis.id, { pickupId: alis.pickupIds[0] }, { occurredAt: at("07:00") }), 404, noRouteAssigned(alis.id))
    })
  })

  describe("the stops", () => {
    test("arrive appends an arrival and sets the first arrivedAt; a second arrival appends and moves nothing", async () => {
      const route = await minted()
      const sessionId = await started(route)
      const [pickupId] = route.pickupIds
      const first = envelope("arrive", route.id, { pickupId, location: { type: "Point", coordinates: [12.5951, 55.7089] }, accuracyM: 8 }, { occurredAt: at("06:40") })
      const proof = valueOf(await applied(first), "proof", ProofOfService)
      assert.deepEqual(
        [proof.id, proof.kind, proof.source, proof.routeId, proof.pickupId, proof.sessionId, proof.occurredAt, proof.recordedBy, proof.deviceId, proof.location, proof.locationAccuracyM, proof.reason, proof.note, proof.weightKg, proof.objectKey, proof.outcome],
        [first.id, "arrival", "driver-app", route.id, pickupId, sessionId, at("06:40"), fixtures.accounts.mads.id, "device-mads-01", { type: "Point", coordinates: [12.5951, 55.7089] }, 8, null, null, null, null, null],
      )
      assert.equal((await detail(route.id)).pickups[0].arrivedAt, at("06:40"))
      const second = valueOf(await applied(envelope("arrive", route.id, { pickupId }, { occurredAt: at("06:50") })), "proof", ProofOfService)
      assert.equal(second.kind, "arrival")
      assert.equal((await detail(route.id)).pickups[0].arrivedAt, at("06:40"), "the first arrival stands")
      assert.deepEqual(await events(pickupId), [], "an arrival is nobody else's news")
    })

    test("complete, skip and fail move a planned pickup once with their proof and event; a second outcome is refused, and the progress counts them", async () => {
      const route = await minted({ pickups: 3 })
      await started(route)
      const [p1, p2, p3] = route.pickupIds
      const complete = envelope("complete-pickup", route.id, { pickupId: p1, note: "Both bins" }, { occurredAt: at("06:45") })
      const completion = valueOf(await applied(complete), "proof", ProofOfService)
      assert.deepEqual([completion.kind, completion.pickupId, completion.note, completion.reason], ["completion", p1, "Both bins", null])
      let found = await detail(route.id)
      assert.deepEqual([found.pickups[0].status, found.pickups[0].reason, found.pickups[0].outcomeAt], ["completed", null, at("06:45")])
      const [completed] = await events(p1)
      assert.deepEqual([completed.kind, completed.aggregateKind, completed.occurredAt.toISOString()], ["pickup-completed", "pickup", at("06:45")])
      const payload = completed.payload as { status: string; proofs: unknown[] }
      assert.equal(payload.status, "completed")
      assert.deepEqual(payload.proofs, [completion], "the pickup with the proof the command made")

      await rejected(envelope("complete-pickup", route.id, { pickupId: p1 }, { occurredAt: at("06:46") }), 409, alreadyDecided(1, "completed"))
      await rejected(envelope("skip-pickup", route.id, { pickupId: p1, reason: "other" }, { occurredAt: at("06:46") }), 409, alreadyDecided(1, "completed"))
      assert.equal(alreadyDecided(1, "completed"), "Pickup 1 is already completed")

      const skip = valueOf(await applied(envelope("skip-pickup", route.id, { pickupId: p2, reason: "inaccessible", note: "Car parked in front" }, { occurredAt: at("06:55") })), "proof", ProofOfService)
      assert.deepEqual([skip.kind, skip.reason, skip.note], ["skip", "inaccessible", "Car parked in front"])
      const fail = valueOf(await applied(envelope("fail-pickup", route.id, { pickupId: p3, reason: "contamination" }, { occurredAt: at("07:05") })), "proof", ProofOfService)
      assert.deepEqual([fail.kind, fail.reason], ["failure", "contamination"])
      found = await detail(route.id)
      assert.deepEqual(
        found.pickups.map((pickup) => [pickup.status, pickup.reason, pickup.outcomeAt]),
        [
          ["completed", null, at("06:45")],
          ["skipped", "inaccessible", at("06:55")],
          ["failed", "contamination", at("07:05")],
        ],
      )
      assert.deepEqual(found.progress, { planned: 0, completed: 1, skipped: 1, failed: 1, total: 3, fraction: 1 })
      assert.deepEqual((await events(p2)).map((event) => event.kind), ["pickup-skipped"])
      assert.deepEqual((await events(p3)).map((event) => event.kind), ["pickup-failed"])
      await rejected(envelope("fail-pickup", route.id, { pickupId: p2, reason: "other" }, { occurredAt: at("07:10") }), 409, alreadyDecided(2, "skipped"))
    })

    test("a pickup that is not the route's is the route's 404, whichever command names it", async () => {
      const route = await minted()
      const other = await minted({ driver: fleet.drivers.jonas })
      await started(route)
      const strangers = [other.pickupIds[0], testId()]
      for (const pickupId of strangers) {
        for (const [kind, body] of [
          ["arrive", { pickupId }],
          ["complete-pickup", { pickupId }],
          ["skip-pickup", { pickupId, reason: "other" }],
          ["fail-pickup", { pickupId, reason: "other" }],
          ["report-problem", { pickupId, reason: "safety", note: "Dog" }],
          ["add-weight", { pickupId, weightKg: 12 }],
          ["add-note", { pickupId, note: "Hm" }],
        ] as [DriverCommandKind, unknown][]) {
          await rejected(envelope(kind, route.id, body, { occurredAt: at("07:00") }), 404, noPickupOnRoute(pickupId, route.label))
        }
        const id = mint()
        await rejected(envelope("add-signature", route.id, { pickupId, objectKey: photoKey(route, id) }, { id, occurredAt: at("07:00") }), 404, noPickupOnRoute(pickupId, route.label))
      }
    })

    test("report-problem, add-photo, add-weight, add-signature and add-note append their proofs, on a stop or on the route alone", async () => {
      const route = await minted()
      const sessionId = await started(route)
      const [pickupId] = route.pickupIds
      const onStop = valueOf(await applied(envelope("report-problem", route.id, { pickupId, reason: "safety", note: "Loose dog" }, { occurredAt: at("07:00") })), "proof", ProofOfService)
      assert.deepEqual([onStop.kind, onStop.pickupId, onStop.reason, onStop.note, onStop.sessionId], ["problem", pickupId, "safety", "Loose dog", sessionId])
      assert.deepEqual((await events(pickupId)).map((event) => [event.kind, event.aggregateKind]), [["pickup-problem-reported", "pickup"]])
      const onRoute = valueOf(await applied(envelope("report-problem", route.id, { reason: "other", note: "Road closed at Parkvej" }, { occurredAt: at("07:01") })), "proof", ProofOfService)
      assert.deepEqual([onRoute.kind, onRoute.pickupId], ["problem", null])
      assert.ok((await events(route.id)).some((event) => event.kind === "pickup-problem-reported" && event.aggregateKind === "route"), "a route-level problem is the route's event")
      assert.equal((await detail(route.id)).pickups[0].status, "planned", "a reported problem moves no status")

      const photoId = mint()
      const photo = valueOf(await applied(envelope("add-photo", route.id, { objectKey: photoKey(route, photoId) }, { id: photoId, occurredAt: at("07:02") })), "proof", ProofOfService)
      assert.deepEqual([photo.kind, photo.pickupId, photo.objectKey], ["photo", null, `${a.companyId}/${route.id}/${photoId}.jpg`])
      const weight = valueOf(await applied(envelope("add-weight", route.id, { pickupId, weightKg: 148 }, { occurredAt: at("07:03") })), "proof", ProofOfService)
      assert.deepEqual([weight.kind, weight.pickupId, weight.weightKg], ["weight", pickupId, 148])
      const signatureId = mint()
      const signature = valueOf(await applied(envelope("add-signature", route.id, { pickupId, objectKey: objectKeyOf({ companyId: a.companyId, routeId: route.id, commandId: signatureId }, "png") }, { id: signatureId, occurredAt: at("07:04") })), "proof", ProofOfService)
      assert.deepEqual([signature.kind, signature.pickupId, signature.objectKey], ["signature", pickupId, `${a.companyId}/${route.id}/${signatureId}.png`])
      const note = valueOf(await applied(envelope("add-note", route.id, { note: "Gate code 1234" }, { occurredAt: at("07:05") })), "proof", ProofOfService)
      assert.deepEqual([note.kind, note.pickupId, note.note], ["note", null, "Gate code 1234"])
    })

    test("an object key is this command's own: another command's, another route's or another company's is refused at body.objectKey, and a malformed one by the schema", async () => {
      const route = await minted()
      const other = await minted({ driver: fleet.drivers.jonas })
      await started(route)
      const [pickupId] = route.pickupIds
      const id = mint()
      for (const key of [
        photoKey(route, mint()),
        objectKeyOf({ companyId: a.companyId, routeId: other.id, commandId: id }, "jpg"),
        objectKeyOf({ companyId: b.companyId, routeId: route.id, commandId: id }, "jpg"),
      ]) {
        const problem = await rejected(envelope("add-photo", route.id, { pickupId, objectKey: key }, { id: mint(), occurredAt: at("07:10") }), 400, OBJECT_KEY_NAMES_ANOTHER)
        assert.deepEqual(problem.errors, [{ path: "body.objectKey", message: OBJECT_KEY_NAMES_ANOTHER }])
      }
      assert.equal(OBJECT_KEY_NAMES_ANOTHER, "The object key names another route or another command")
      const malformed = await rejected(envelope("add-signature", route.id, { pickupId, objectKey: "photo.jpg" }, { occurredAt: at("07:10") }), 400, "The request body is invalid")
      assert.deepEqual(malformed.errors, [{ path: "body.objectKey", message: OBJECT_KEY_SHAPE }])
      const signatureless = await rejected(envelope("add-signature", route.id, { objectKey: photoKey(route, id) }, { id, occurredAt: at("07:10") }), 400, "The request body is invalid")
      assert.deepEqual(signatureless.errors?.map((error) => error.path), ["body.pickupId"], "a signature is a stop's")
      // The key rule holds for a record-unload's photo too.
      const unloadKeyed = await rejected(
        envelope("record-unload", route.id, { unloadingStationId: fleet.stations.amager.id, wasteFractionId: fixtures.residual.id, netKg: 100, objectKey: photoKey(route, mint()) }, { occurredAt: at("07:11") }),
        400,
        OBJECT_KEY_NAMES_ANOTHER,
      )
      assert.deepEqual(unloadKeyed.errors, [{ path: "body.objectKey", message: OBJECT_KEY_NAMES_ANOTHER }])
    })

    test("record-unload appends the unload with its event; the station and the fraction are the company's, the weights the contracts' rule", async () => {
      const route = await minted()
      const sessionId = await started(route)
      const command = envelope("record-unload", route.id, { unloadingStationId: fleet.stations.amager.id, wasteFractionId: fixtures.residual.id, netKg: 4200, grossKg: 12_400, tareKg: 8_200, weighbridgeTicket: "WB-2026-3901", note: "First tip" }, { occurredAt: at("11:00") })
      const unload = valueOf(await applied(command), "unload", Unload)
      assert.deepEqual(
        [unload.id, unload.routeId, unload.sessionId, unload.unloadingStationId, unload.wasteFractionId, unload.source, unload.occurredAt, unload.recordedBy, unload.deviceId, unload.grossKg, unload.tareKg, unload.netKg, unload.weighbridgeTicket, unload.objectKey, unload.note, unload.location],
        [command.id, route.id, sessionId, fleet.stations.amager.id, fixtures.residual.id, "driver-app", at("11:00"), fixtures.accounts.mads.id, "device-mads-01", 12_400, 8_200, 4200, "WB-2026-3901", null, "First tip", null],
      )
      assert.deepEqual((await detail(route.id)).unloads, [unload])
      const [recorded] = await events(command.id)
      assert.deepEqual([recorded.kind, recorded.aggregateKind, recorded.payload], ["unload-recorded", "unload", unload])

      const noStation = await rejected(envelope("record-unload", route.id, { unloadingStationId: testId(), wasteFractionId: fixtures.residual.id, netKg: 100 }, { occurredAt: at("11:01") }), 400, NOT_A_STATION)
      assert.deepEqual(noStation.errors, [{ path: "body.unloadingStationId", message: NOT_A_STATION }])
      const theirFraction = await rejected(envelope("record-unload", route.id, { unloadingStationId: fleet.stations.amager.id, wasteFractionId: theirFixtures.residual.id, netKg: 100 }, { occurredAt: at("11:01") }), 400, NOT_A_FRACTION)
      assert.deepEqual(theirFraction.errors, [{ path: "body.wasteFractionId", message: NOT_A_FRACTION }])
      const weights = await rejected(envelope("record-unload", route.id, { unloadingStationId: fleet.stations.amager.id, wasteFractionId: fixtures.residual.id, netKg: 60, grossKg: 100, tareKg: 50 }, { occurredAt: at("11:01") }), 400, "The request body is invalid")
      assert.deepEqual(weights.errors, [{ path: "body.netKg", message: NET_IS_GROSS_LESS_TARE }])
    })

    test("pause sets pausedAt and resume clears it; a pause on a paused session and a resume on a running one are applied without a write", async () => {
      const route = await minted()
      const sessionId = await started(route)
      const paused = await applied(envelope("pause", route.id, {}, { occurredAt: at("09:00") }))
      assert.equal(paused.result, undefined, "a pause makes no row")
      assert.equal((await detail(route.id)).session?.pausedAt, at("09:00"))
      const second = await applied(envelope("pause", route.id, {}, { occurredAt: at("09:05") }))
      assert.equal(second.result, undefined)
      const stillPaused = await sessionRow(sessionId)
      assert.equal(stillPaused.pausedAt?.toISOString(), at("09:00"), "the first pause stands; the second decided no effect")
      assert.equal(stillPaused.lastSeenAt.toISOString(), now.toISOString(), "and the device was seen, as on every applied command")
      await applied(envelope("resume", route.id, {}, { occurredAt: at("09:20") }))
      assert.equal((await detail(route.id)).session?.pausedAt, null)
      await applied(envelope("resume", route.id, {}, { occurredAt: at("09:21") }))
      assert.equal((await detail(route.id)).session?.pausedAt, null)
      assert.deepEqual((await receipts(`?routeId=${route.id}`)).items.map((receipt) => receipt.kind), ["start-route", "pause", "pause", "resume", "resume"], "every command's receipt is written, the no-ops' too")
    })

    test("end-route closes the open pickups as skipped · route-ended, completes the route, ends the session, and writes one event per pickup closed", async () => {
      const route = await minted({ pickups: 3 })
      const sessionId = await started(route)
      const [p1, p2, p3] = route.pickupIds
      await applied(envelope("complete-pickup", route.id, { pickupId: p1 }, { occurredAt: at("07:00") }))
      const end = envelope("end-route", route.id, { note: "Truck full, two stops left" }, { occurredAt: at("12:00") })
      const outcome = await applied(end)
      const result = valueOf(outcome, "route", Route)
      assert.deepEqual([result.id, result.status, result.completedAt, result.progress], [route.id, "completed", at("12:00"), { planned: 0, completed: 1, skipped: 2, failed: 0, total: 3, fraction: 1 }])
      const found = await detail(route.id)
      assert.deepEqual(
        found.pickups.map((pickup) => [pickup.status, pickup.reason, pickup.outcomeAt]),
        [
          ["completed", null, at("07:00")],
          ["skipped", "route-ended", at("12:00")],
          ["skipped", "route-ended", at("12:00")],
        ],
      )
      assert.equal(found.session, null, "no open session")
      assert.deepEqual([found.sessions[0].id, found.sessions[0].endedAt], [sessionId, at("12:00")])
      assert.deepEqual((await events(route.id)).map((event) => event.kind), ["route-started", "route-completed"])
      for (const closed of [p2, p3]) {
        const [skipped] = await events(closed)
        assert.deepEqual([skipped.kind, skipped.occurredAt.toISOString(), (skipped.payload as { status: string; reason: string; proofs: unknown[] }).status, (skipped.payload as { reason: string }).reason], ["pickup-skipped", at("12:00"), "skipped", "route-ended"])
      }
      // After the end nothing more is recorded on the route by the device: an unload is the office's then (#104 §7.21).
      await rejected(envelope("record-unload", route.id, { unloadingStationId: fleet.stations.amager.id, wasteFractionId: fixtures.residual.id, netKg: 100 }, { occurredAt: at("12:10") }), 409, notActive(route.label))
      await rejected(envelope("end-route", route.id, {}, { occurredAt: at("12:10") }), 409, notActive(route.label))
      const me = DriverMe.parse(await (await mads("/driver/me")).json())
      assert.equal(me.openSession, null)
      assert.ok(me.routes.some((found) => found.id === route.id), "completed today is still the day's")
    })
  })

  describe("replay and the receipt", () => {
    test("every kind replayed with its own id answers the first outcome and writes nothing, not even lastSeenAt", async () => {
      const route = await minted({ pickups: 3 })
      const [p1, p2, p3] = route.pickupIds
      const photoId = mint()
      const signatureId = mint()
      const day: Envelope[] = [
        envelope("start-route", route.id, { vehicleId: fleet.vehicles.wh24.id }),
        envelope("arrive", route.id, { pickupId: p1 }, { occurredAt: at("06:40") }),
        envelope("complete-pickup", route.id, { pickupId: p1 }, { occurredAt: at("06:45") }),
        envelope("skip-pickup", route.id, { pickupId: p2, reason: "not-presented" }, { occurredAt: at("06:50") }),
        envelope("fail-pickup", route.id, { pickupId: p3, reason: "capacity" }, { occurredAt: at("06:55") }),
        envelope("report-problem", route.id, { pickupId: p3, reason: "capacity", note: "Overfull" }, { occurredAt: at("06:56") }),
        envelope("add-photo", route.id, { pickupId: p3, objectKey: photoKey(route, photoId) }, { id: photoId, occurredAt: at("06:57") }),
        envelope("add-weight", route.id, { pickupId: p1, weightKg: 120 }, { occurredAt: at("06:58") }),
        envelope("add-signature", route.id, { pickupId: p1, objectKey: photoKey(route, signatureId) }, { id: signatureId, occurredAt: at("06:59") }),
        envelope("add-note", route.id, { note: "Done early" }, { occurredAt: at("07:00") }),
        envelope("record-unload", route.id, { unloadingStationId: fleet.stations.amager.id, wasteFractionId: fixtures.residual.id, netKg: 900 }, { occurredAt: at("07:30") }),
        envelope("pause", route.id, {}, { occurredAt: at("07:40") }),
        envelope("resume", route.id, {}, { occurredAt: at("07:50") }),
        envelope("complete-pickup", route.id, { pickupId: p1 }, { occurredAt: at("07:55") }),
        envelope("end-route", route.id, {}, { occurredAt: at("08:00") }),
      ]
      const first = await send(day)
      assert.deepEqual(
        first.map((outcome) => outcome.outcome),
        [...Array.from({ length: 13 }, () => "applied"), "rejected", "applied"],
        "the second completion is the one rejection",
      )
      const before = await written()
      const seen = (await sessionRow(day[0].id)).lastSeenAt.toISOString()
      assert.equal(seen, now.toISOString())
      now = new Date(MORNING.getTime() + 60 * 60_000)
      try {
        const again = await send(day)
        assert.deepEqual(
          again.map((outcome) => outcome.outcome),
          day.map(() => "replayed"),
        )
        for (const [index, outcome] of again.entries()) {
          assert.equal(outcome.commandId, day[index].id)
          if (day[index].kind === "start-route") {
            // The row it made, read back as it stands: the session has since been paused, resumed and ended, and the replay says so.
            const session = valueOf(outcome, "session", Session)
            assert.deepEqual([session.id, session.startedAt, session.endedAt, session.pausedAt], [day[0].id, at("06:30"), at("08:00"), null])
          } else {
            assert.deepEqual(outcome.result, first[index].result, `${day[index].kind}: the row it made, read back`)
          }
          assert.deepEqual(outcome.problem, first[index].problem, `${day[index].kind}: the problem it was refused with`)
        }
        assert.deepEqual(await written(), before, "nothing written")
        assert.equal((await sessionRow(day[0].id)).lastSeenAt.toISOString(), seen, "lastSeenAt did not move")
        // Replayed one by one, out of order, with a body that differs: still the first answer.
        logged.length = 0
        const [differing] = await send([{ ...day[3], body: { pickupId: p2, reason: "other" } }])
        assert.equal(differing.outcome, "replayed")
        assert.deepEqual(differing.result, first[3].result)
        assert.equal(logged.length, 1, "the difference is logged")
        assert.deepEqual(await written(), before)
      } finally {
        now = MORNING
      }
    })

    test("lastSeenAt is moved by an applied batch and not by a replay", async () => {
      const route = await minted()
      const start = envelope("start-route", route.id, { vehicleId: fleet.vehicles.wh24.id })
      await applied(start)
      assert.equal((await sessionRow(start.id)).lastSeenAt.toISOString(), MORNING.toISOString())
      try {
        now = new Date(MORNING.getTime() + 10 * 60_000)
        const [replay] = await send([start])
        assert.equal(replay.outcome, "replayed")
        assert.equal((await sessionRow(start.id)).lastSeenAt.toISOString(), MORNING.toISOString(), "a replay is not the device being seen")
        await applied(envelope("add-note", route.id, { note: "Still here" }, { occurredAt: at("08:05") }))
        assert.equal((await sessionRow(start.id)).lastSeenAt.toISOString(), now.toISOString(), "an applied command is")
        const seen = now
        now = new Date(MORNING.getTime() + 20 * 60_000)
        const stranger = testId()
        await rejected(envelope("arrive", route.id, { pickupId: stranger }, { occurredAt: at("08:06") }), 404, noPickupOnRoute(stranger, route.label))
        assert.equal((await sessionRow(start.id)).lastSeenAt.toISOString(), seen.toISOString(), "a rejection is not")
      } finally {
        now = MORNING
      }
    })

    test("two overlapping uploads of one batch leave one receipt per command and answer one applied and one replayed", async () => {
      const route = await minted()
      const batch = [envelope("start-route", route.id, { vehicleId: fleet.vehicles.wh24.id }), envelope("arrive", route.id, { pickupId: route.pickupIds[0] }, { occurredAt: at("06:40") })]
      const [left, right] = await Promise.all([send(batch), send(batch)])
      const outcomes = [left.map((outcome) => outcome.outcome).join(","), right.map((outcome) => outcome.outcome).join(",")].sort()
      assert.deepEqual(outcomes, ["applied,applied", "replayed,replayed"])
      assert.deepEqual(left[0].result, right[0].result, "the same session read back")
      const page = await receipts(`?routeId=${route.id}`)
      assert.deepEqual(page.items.map((receipt) => [receipt.id, receipt.outcome]), batch.map((command) => [command.id, "applied"]), "one receipt each")
      assert.equal((await detail(route.id)).sessions.length, 1)
    })

    test("the receipts read oldest first, per route or all, rejections with their problem, and never another driver's", async () => {
      const route = await minted()
      const alis = await routeFor(pool, a, fleet, fixtures, { driver: fixtures.drivers.ali, serviceProviderId: a.serviceProviders.nordren.id })
      const start = envelope("start-route", route.id, { vehicleId: fleet.vehicles.wh24.id })
      const strangerId = testId()
      const stranger = envelope("arrive", route.id, { pickupId: strangerId }, { occurredAt: at("06:40") })
      const arrive = envelope("arrive", route.id, { pickupId: route.pickupIds[0] }, { occurredAt: at("06:41") })
      await send([start, stranger, arrive])
      const alisStart = envelope("start-route", alis.id, { vehicleId: fleet.vehicles.wh25.id }, { deviceId: "device-ali-01" })
      await applied(alisStart, ali)

      const page = await receipts(`?routeId=${route.id}`)
      assert.deepEqual(page.items.map((receipt) => [receipt.id, receipt.kind, receipt.outcome]), [
        [start.id, "start-route", "applied"],
        [stranger.id, "arrive", "rejected"],
        [arrive.id, "arrive", "applied"],
      ])
      const [, refusedReceipt] = page.items
      assert.deepEqual([refusedReceipt.problem?.status, refusedReceipt.problem?.detail, refusedReceipt.pickupId, refusedReceipt.sessionId], [404, noPickupOnRoute(strangerId, route.label), null, start.id])
      assert.equal(page.nextCursor, null)

      const all = await receipts("?limit=200")
      assert.ok(all.items.some((receipt) => receipt.id === start.id))
      assert.ok(!all.items.some((receipt) => receipt.id === alisStart.id), "Ali's receipts are Ali's")
      const alisPage = await receipts("?limit=200", ali)
      assert.ok(alisPage.items.some((receipt) => receipt.id === alisStart.id))
      assert.ok(!alisPage.items.some((receipt) => receipt.id === start.id))
      assert.equal(alisPage.items.find((receipt) => receipt.id === alisStart.id)?.deviceId, "device-ali-01")

      const firstPage = await receipts(`?routeId=${route.id}&limit=2`)
      assert.deepEqual(firstPage.items.map((receipt) => receipt.id), [start.id, stranger.id])
      assert.ok(firstPage.nextCursor)
      const secondPage = await receipts(`?routeId=${route.id}&limit=2&cursor=${firstPage.nextCursor}`)
      assert.deepEqual(secondPage.items.map((receipt) => receipt.id), [arrive.id])
      assert.equal(secondPage.nextCursor, null)
      assert.deepEqual((await refused(await mads("/driver/commands?cursor=nope"), 400)).errors?.map((error) => error.path), ["cursor"])
      assert.deepEqual((await refused(await mads("/driver/commands?routeId=nope"), 400)).errors?.map((error) => error.path), ["routeId"])
    })
  })

  describe("a Service Provider's driver", () => {
    test("reaches exactly the routes assigned to them through this door, whatever project their account works in (none)", async () => {
      const alis = await routeFor(pool, a, fleet, fixtures, { driver: fixtures.drivers.ali, serviceProviderId: a.serviceProviders.nordren.id, pickups: 1 })
      const madss = await minted()
      const me = DriverMe.parse(await (await ali("/driver/me")).json())
      assert.deepEqual([me.driver.id, me.driver.employment, me.driver.serviceProviderId], [fixtures.drivers.ali.id, "service-provider", a.serviceProviders.nordren.id])
      const ids = me.routes.map((route) => route.id)
      assert.ok(ids.includes(alis.id))
      assert.ok(!ids.includes(madss.id))
      assert.equal(me.routes.find((route) => route.id === alis.id)?.planned.serviceProviderId, a.serviceProviders.nordren.id)
      assert.equal((await refused(await ali(`/driver/routes/${madss.id}`), 404)).detail, noRouteAssigned(madss.id))
      await rejected(envelope("start-route", madss.id, { vehicleId: fleet.vehicles.wh24.id }), 404, noRouteAssigned(madss.id), ali)
      await started(alis, { call: ali, vehicleId: fleet.vehicles.wh25.id })
      const found = await detail(alis.id, ali)
      assert.deepEqual([found.status, found.actual.driverId, found.actual.vehicleId], ["active", fixtures.drivers.ali.id, fleet.vehicles.wh25.id])
      await applied(envelope("complete-pickup", alis.id, { pickupId: alis.pickupIds[0] }, { occurredAt: at("07:00") }), ali)
      await applied(envelope("end-route", alis.id, {}, { occurredAt: at("08:00") }), ali)
      assert.equal((await detail(alis.id, ali)).status, "completed")
    })
  })
})
