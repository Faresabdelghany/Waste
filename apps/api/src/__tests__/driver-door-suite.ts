import assert from "node:assert/strict"
import { after, before, beforeEach } from "node:test"

import { CommandOutcomeRow, DriverCommandBatchOutcome, DriverCommandReceipt, DriverRouteDetail, type CommandResult } from "@waste/contracts/driver-commands"
import { Page } from "@waste/contracts/pagination"
import { Route } from "@waste/contracts/routes"
import { Session } from "@waste/contracts/sessions"
import { createDb, type Database } from "@waste/db/client"
import { createJobSender } from "@waste/db/jobs"
import { driverCommand, outboxEvent, proofOfService, session as sessionTable, sessionPosition } from "@waste/db/schema/execution"
import { withCompany } from "@waste/db/tenant"
import { objectKeyOf } from "@waste/domain/storage-objects"
import type { DriverCommandKind } from "@waste/domain/execution/vocabulary"
import { and, asc, count, eq, isNull } from "drizzle-orm"
import { Hono } from "hono"

import { type createApp } from "../app"
import { routeDeps } from "../deps"
import { errorHandler } from "../problem"
import { driverDoorRoutes } from "../routes/driver"
import { routeRoutes } from "../routes/routes"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { FIXTURE_DAY, routeFor, seedDriverFixtures, TOWN_HALL, type DriverFixtures, type FixtureRoute, type RouteOptions } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures } from "./scheme-fixtures"
import { dropTenant, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

// The driver door's suites share one setup: its tests are three files —
// driver.test.ts, driver-stops.test.ts and driver-replay.test.ts — since
// node's test timeout bounds a whole file, and one file of them all ran near
// it under CI's parallel load.

export const database = databaseUnderTest()
/** The owner sweeps the three ledgers and the outbox these suites write, which `wms_api` may not delete. */
export const owner = ownerUnderTest()

export const RoutePage = Page(Route)
/** A page of receipts as the door answers it, every item the contract's shape — a rejection for a route of another project, another company or none included, its `routeId` null. */
export const ReceiptPage = Page(DriverCommandReceipt)

/** The request's clock: the afternoon of the operating date, pinned, so every instant a command carries (06:30 to 12:30) is behind it; moved by the tests that need it to move. */
export const MORNING = new Date(`${FIXTURE_DAY}T14:00:00Z`)
/** An instant of the operating date, UTC. */
export const at = (time: string): string => `${FIXTURE_DAY}T${time}:00.000Z`
/** An instant so many milliseconds from the pinned clock. */
export const fromNow = (ms: number): string => new Date(MORNING.getTime() + ms).toISOString()

/** Ids that sort in the order they were minted: one millisecond apart, so a page over `id` is a page over upload order. */
let tick = Date.now()
export const mint = (): string => testId((tick += 1))
/** Rows in the order the door lists them, by id: the order Postgres gives a uuid, which is the string order of its lowercase spelling. */
export const byId = <Row extends { id: string }>(rows: Row[]): Row[] => [...rows].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))

export type Envelope = { id: string; kind: DriverCommandKind; routeId: string; occurredAt: string; deviceId: string; body: unknown }
type EnvelopeOptions = { id?: string; occurredAt?: string; deviceId?: string }

/** One command as a device sends it: a fresh id and the morning's clock unless said. */
export const envelope = (kind: DriverCommandKind, routeId: string, body: unknown, options: EnvelopeOptions = {}): Envelope => ({
  id: options.id ?? mint(),
  kind,
  routeId,
  occurredAt: options.occurredAt ?? at("06:30"),
  deviceId: options.deviceId ?? "device-mads-01",
  body,
})

export type DriverDoor = {
  pool: Database
  ownerPool: Database
  keys: SigningKeys
  /** The company under test, and the other one. */
  a: Tenant
  b: Tenant
  fleet: FleetFixtures
  theirFleet: FleetFixtures
  fixtures: DriverFixtures
  theirFixtures: DriverFixtures
  app: ReturnType<typeof createApp>
  mads: Call
  ali: Call
  freja: Call
  sofie: Call
  karen: Call
  olivia: Call
  lars: Call
  ungranted: Call
  theirMads: Call
  /** The other company's dispatcher, for the yard-clearing cancel there. */
  theirOlivia: Call
}

/**
 * Registers the suite's hooks inside the calling `describe` and answers the
 * door, filled once its `before` has run. The file keeps the request's clock
 * and the door's log, since its tests move the one and read the other.
 */
export function driverDoor({ now, logged }: { now: () => Date; logged: unknown[] }): { readonly current: DriverDoor } {
  const held: { current?: DriverDoor } = {}
  const door = {
    get current(): DriverDoor {
      assert.ok(held.current, "the driver door is set up in the suite's before")
      return held.current
    },
  }
  const { cancelled } = driverDoorCalls(() => door.current)

  before(async () => {
    const pool = createDb(database.url, { max: 6 })
    const ownerPool = createDb(owner.url, { max: 1 })
    const keys = await signingKeys()
    const a = await seedTenant(pool)
    const b = await seedTenant(pool)
    const fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
    const theirFleet = await seedFleet(pool, b, await seedPlanning(pool, b))
    const fixtures = await seedDriverFixtures(pool, a, fleet)
    const theirFixtures = await seedDriverFixtures(pool, b, theirFleet)
    // The door under test, mounted with its own log so the two things it notes can be read, beside the office's route commands (routes/routes.ts) for the cancel that clears the yard between tests and the one a test sends mid-route; the whole app is what app.test.ts documents.
    const deps = routeDeps({ probe: pool, pool, verifier: keys.verifier, now, log: (entry) => logged.push(entry), jobs: createJobSender(pool) })
    const mounted = new Hono()
    mounted.onError(errorHandler())
    mounted.route("/", driverDoorRoutes(deps).app)
    mounted.route("/", routeRoutes(deps).app)
    const app = mounted as unknown as ReturnType<typeof createApp>
    held.current = {
      pool,
      ownerPool,
      keys,
      a,
      b,
      fleet,
      theirFleet,
      fixtures,
      theirFixtures,
      app,
      mads: callingAs(app, keys, fixtures.accounts.mads, a.companyId),
      ali: callingAs(app, keys, fixtures.accounts.ali, a.companyId),
      freja: callingAs(app, keys, fixtures.accounts.freja, a.companyId),
      sofie: callingAs(app, keys, fixtures.accounts.sofie, a.companyId),
      karen: callingAs(app, keys, fixtures.accounts.karen, a.companyId),
      olivia: callingAs(app, keys, a.users.olivia, a.companyId),
      lars: callingAs(app, keys, a.users.lars, a.companyId),
      ungranted: callingAs(app, keys, a.users.viewer, a.companyId),
      theirMads: callingAs(app, keys, theirFixtures.accounts.mads, b.companyId),
      theirOlivia: callingAs(app, keys, b.users.olivia, b.companyId),
    }
  })
  /**
   * A driver runs one route at a time (`session_driver_open_idx`), so a
   * session one test leaves open would refuse the next test's `start-route`
   * for the driver's sake. Before each test the yard is quiet in both
   * companies: every route with an open session is cancelled through the
   * office's own command, which ends the session and closes the open pickups
   * the way a dispatcher would — the other company's too, since a test that
   * starts a route there would otherwise trip its Mads's index later.
   */
  beforeEach(async () => {
    if (!held.current) return
    const { pool, a, b, olivia, theirOlivia } = held.current
    for (const [tenant, dispatcher] of [
      [a, olivia],
      [b, theirOlivia],
    ] as const) {
      const open = await withCompany(pool.db, tenant.companyId, (tx) => tx.select({ routeId: sessionTable.routeId }).from(sessionTable).where(and(eq(sessionTable.companyId, tenant.companyId), isNull(sessionTable.endedAt))))
      for (const found of open) await cancelled(found.routeId, "Cleared by the suite", dispatcher)
    }
  })
  after(async () => {
    const current = held.current
    if (!current) return
    await dropTenant(current.pool, current.a.companyId, current.ownerPool)
    await dropTenant(current.pool, current.b.companyId, current.ownerPool)
    await current.pool.close()
    await current.ownerPool.close()
  })
  return door
}

/** The suites' calls and reads, over the door `of` answers once its `before` has run. */
export function driverDoorCalls(of: () => DriverDoor) {
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  /** A route of company a, Mads's and ready unless said. */
  const minted = (options: Partial<RouteOptions> = {}) => {
    const { pool, a, fleet, fixtures } = of()
    return routeFor(pool, a, fleet, fixtures, { driver: fleet.drivers.mads, ...options })
  }
  /** The office's cancel (`POST /routes/:id/cancel`) as the dispatcher sends it: the route cancelled with the reason as its note, its open session ended, its open pickups closed. */
  const cancelled = async (routeId: string, reason: string, dispatcher: Call = of().olivia): Promise<void> => {
    const response = await dispatcher(`/routes/${routeId}/cancel`, { method: "POST", body: { reasonCode: "other", reason } })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
  }
  /** The driver's route read, parsed with its own contract: the pickups carry their places. */
  const detail = async (id: string, call: Call = of().mads): Promise<DriverRouteDetail> => {
    const response = await call(`/driver/routes/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return DriverRouteDetail.parse(await response.json())
  }
  const send = async (commands: unknown[], call: Call = of().mads): Promise<CommandOutcomeRow[]> => {
    const response = await call("/driver/commands", { method: "POST", body: { commands } })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return DriverCommandBatchOutcome.parse(await response.json()).outcomes
  }
  const one = async (command: Envelope, call: Call = of().mads): Promise<CommandOutcomeRow> => {
    const [outcome] = await send([command], call)
    assert.equal(outcome.commandId, command.id)
    return outcome
  }
  const applied = async (command: Envelope, call: Call = of().mads): Promise<CommandOutcomeRow> => {
    const outcome = await one(command, call)
    assert.equal(outcome.outcome, "applied", JSON.stringify(outcome.problem))
    return outcome
  }
  /** Sends the command and holds it rejected with the status and the sentence; answers the problem for the field checks. */
  const rejected = async (command: Envelope, status: number, detail: string, call: Call = of().mads) => {
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
    const command = envelope("start-route", route.id, { vehicleId: options.vehicleId ?? of().fleet.vehicles.wh24.id, appVersion: "1.4.0" }, { occurredAt: options.occurredAt })
    const outcome = await applied(command, options.call)
    assert.equal(valueOf(outcome, "session", Session).id, command.id, "the session's id is the command's")
    return command.id
  }
  /** The outbox rows about one aggregate, in id order, as `wms_api` reads them. */
  const events = (aggregateId: string) => {
    const { pool, a } = of()
    return withCompany(pool.db, a.companyId, (tx) =>
      tx
        .select({ kind: outboxEvent.kind, aggregateKind: outboxEvent.aggregateKind, occurredAt: outboxEvent.occurredAt, payload: outboxEvent.payload, publishedAt: outboxEvent.publishedAt, projectId: outboxEvent.projectId })
        .from(outboxEvent)
        .where(and(eq(outboxEvent.companyId, a.companyId), eq(outboxEvent.aggregateId, aggregateId)))
        .orderBy(asc(outboxEvent.id)),
    )
  }
  const receipts = async (query = "?limit=200", call: Call = of().mads) => {
    const response = await call(`/driver/commands${query}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return ReceiptPage.parse(await response.json())
  }
  /** How many rows the company has in each of the tables a replay must not touch. */
  const written = () => {
    const { pool, a } = of()
    return withCompany(pool.db, a.companyId, async (tx) => {
      const [[proofs], [commands], [outbox], [positions]] = await Promise.all([
        tx.select({ n: count() }).from(proofOfService).where(eq(proofOfService.companyId, a.companyId)),
        tx.select({ n: count() }).from(driverCommand).where(eq(driverCommand.companyId, a.companyId)),
        tx.select({ n: count() }).from(outboxEvent).where(eq(outboxEvent.companyId, a.companyId)),
        tx.select({ n: count() }).from(sessionPosition).where(eq(sessionPosition.companyId, a.companyId)),
      ])
      return { proofs: proofs.n, commands: commands.n, outbox: outbox.n, positions: positions.n }
    })
  }
  const sessionRow = async (id: string) => {
    const { pool, a } = of()
    const [row] = await withCompany(pool.db, a.companyId, (tx) => tx.select().from(sessionTable).where(and(eq(sessionTable.companyId, a.companyId), eq(sessionTable.id, id))))
    assert.ok(row, `session ${id}`)
    return row
  }
  const photoKey = (route: FixtureRoute, commandId: string) => objectKeyOf({ companyId: of().a.companyId, routeId: route.id, commandId }, "jpg")
  /** One fix as the Driver App keeps it, at the town hall unless said. */
  const fix = (instant: string, over: object = {}) => ({ at: instant, location: TOWN_HALL, accuracyM: 12, ...over })
  /** A session's positions as `wms_api` reads them, in the order the fixes were taken. */
  const positionsOf = (sessionId: string) => {
    const { pool, a } = of()
    return withCompany(pool.db, a.companyId, (tx) =>
      tx
        .select({ sessionId: sessionPosition.sessionId, routeId: sessionPosition.routeId, driverId: sessionPosition.driverId, fixedAt: sessionPosition.fixedAt, location: sessionPosition.location, accuracyM: sessionPosition.accuracyM, speedKmh: sessionPosition.speedKmh, headingDeg: sessionPosition.headingDeg })
        .from(sessionPosition)
        .where(and(eq(sessionPosition.companyId, a.companyId), eq(sessionPosition.sessionId, sessionId)))
        .orderBy(asc(sessionPosition.fixedAt)),
    )
  }
  /** The receipt of one command as `wms_api` reads it. */
  const receiptRow = async (id: string) => {
    const { pool, a } = of()
    const [row] = await withCompany(pool.db, a.companyId, (tx) => tx.select().from(driverCommand).where(and(eq(driverCommand.companyId, a.companyId), eq(driverCommand.id, id))))
    assert.ok(row, `receipt ${id}`)
    return row
  }

  return { refused, minted, cancelled, detail, send, one, applied, rejected, valueOf, started, events, receipts, written, sessionRow, photoKey, fix, positionsOf, receiptRow }
}
