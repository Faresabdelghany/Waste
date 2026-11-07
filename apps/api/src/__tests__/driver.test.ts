// The driver door (Issue #104, slice 4): who may knock, the driver's reads,
// the command batch, start-route, the clock, and the commands a route that is
// not active refuses. The stops and the positions are driver-stops.test.ts,
// replay, the receipts, a container's code and a Service Provider's driver
// driver-replay.test.ts, over the setup driver-door-suite.ts shares.
import assert from "node:assert/strict"
import { before, describe, test } from "node:test"

import { DriverCommandReceipt, DriverMe } from "@waste/contracts/driver-commands"
import { Route } from "@waste/contracts/routes"
import { Session } from "@waste/contracts/sessions"
import { type Database } from "@waste/db/client"
import { wasteFraction } from "@waste/db/schema/catalogue"
import { property as propertyTable, sharedCollectionPoint } from "@waste/db/schema/customers"
import { pickup as pickupTable } from "@waste/db/schema/execution"
import { vehicle as vehicleTable } from "@waste/db/schema/fleet"
import { unloadingStation, unloadingStationFraction } from "@waste/db/schema/places"
import { tankInstallation } from "@waste/db/schema/tanks"
import { withCompany } from "@waste/db/tenant"
import {
  alreadyOnRoute,
  BEFORE_THE_SESSION_STARTED,
  noRouteAssigned,
  NOT_A_POWERED_VEHICLE,
  NOT_A_TRAILER,
  notInService,
  OCCURRED_AT_SKEW_MS,
  RECORDED_AFTER_IT_HAPPENED,
  recordedTooLate,
  ROUTE_CANCELLED_NOTHING_TO_END,
} from "@waste/domain/execution/commands"
import { EACH_COMMAND_ONCE } from "@waste/domain/execution/command-batches"
import { alreadyActive, doesNotChange, notActive, notDispatched } from "@waste/domain/execution/transitions"
import type { DriverCommandKind } from "@waste/domain/execution/vocabulary"
import { and, eq, inArray } from "drizzle-orm"

import { NOT_A_DRIVERS_LOGIN } from "../auth/driver"
import { COMMAND_BACKDATE_MS } from "../routes/shared"
import { type Call } from "./calls"
import { at, byId, database, driverDoor, driverDoorCalls, envelope, fromNow, mint, MORNING, owner, RoutePage, type Envelope } from "./driver-door-suite"
import { FIXTURE_DAY, routeFor, TOWN_HALL, type DriverFixtures, type FixtureRoute } from "./execution-fixtures"
import { type FleetFixtures } from "./scheme-fixtures"
import { testId, type Tenant } from "./tenant"

describe("the driver door", { skip: database.skip || owner.skip }, () => {
  const now = MORNING
  /** Where the door's log goes, for the two things it notes. */
  const logged: unknown[] = []
  const door = driverDoor({ now: () => now, logged })
  let pool: Database
  let a: Tenant
  let b: Tenant
  let fleet: FleetFixtures
  let theirFleet: FleetFixtures
  let fixtures: DriverFixtures
  let theirFixtures: DriverFixtures
  let mads: Call
  let ali: Call
  let freja: Call
  let sofie: Call
  let karen: Call
  let olivia: Call
  let lars: Call
  let ungranted: Call
  let theirMads: Call

  before(() => {
    ;({ pool, a, b, fleet, theirFleet, fixtures, theirFixtures, mads, ali, freja, sofie, karen, olivia, lars, ungranted, theirMads } = door.current)
  })

  const { refused, minted, cancelled, detail, send, applied, rejected, valueOf, started, events, receipts, written, sessionRow, photoKey } = driverDoorCalls(() => door.current)

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

    test("GET /driver/me answers what a start picks from: the active powered vehicles and trailers of the driver profile's project, by id, each by its callsign or else its plate — not another project's, not one out of service, not another company's", async () => {
      const setVehicle = (id: string, values: { status?: string; callsign?: string | null }) =>
        withCompany(pool.db, a.companyId, (tx) => tx.update(vehicleTable).set(values).where(and(eq(vehicleTable.companyId, a.companyId), eq(vehicleTable.id, id))))
      // For this test alone: WH-77 out of service, so more than a retired vehicle is seen to stay off the list, and the trailer without its callsign, so its plate names it.
      await setVehicle(fleet.vehicles.drifting.id, { status: "unavailable" })
      await setVehicle(fleet.vehicles.trailer.id, { callsign: null })
      try {
        const me = DriverMe.parse(await (await mads("/driver/me")).json())
        assert.deepEqual(
          me.vehicles,
          byId([
            { id: fleet.vehicles.wh24.id, label: fleet.vehicles.wh24.label, kind: "powered-vehicle", requiredLicenceClass: "c" },
            { id: fleet.vehicles.wh25.id, label: fleet.vehicles.wh25.label, kind: "powered-vehicle", requiredLicenceClass: "ce" },
            { id: fleet.vehicles.trailer.id, label: "CN 90 112", kind: "trailer", requiredLicenceClass: "b" },
          ]),
          "Copenhagen Central's in service: not WH-99 or WH-T99 (retired) or WH-77 (unavailable), not Harbor's HB-1, none of the other company's",
        )
      } finally {
        await setVehicle(fleet.vehicles.drifting.id, { status: "active" })
        await setVehicle(fleet.vehicles.trailer.id, { callsign: fleet.vehicles.trailer.label })
      }
    })

    test("GET /driver/me answers what an unload picks from: the company's stations that are not closed, by id, each with exactly the fractions it accepts, and the company's fractions — none of another company's", async () => {
      const { companyId } = a
      // Ids minted in order and the rows written in reverse, so the order the door answers in is its own and not the order the rows went in.
      const glass = { id: mint(), key: "glass", name: "Glass" }
      const food = { id: mint(), key: "food", name: "Food waste" }
      const station = (code: string, name: string, status: string, weighbridge: boolean, coordinates: [number, number]) => ({
        id: mint(),
        companyId,
        code,
        name,
        address: `${name}, Kystbyen`,
        location: { type: "Point" as const, coordinates },
        ownership: "company",
        weighbridge,
        status,
      })
      const seasonal = station("TS-NORDKAJ", "Nordkaj transfer station", "seasonal", true, [12.6012, 55.7121])
      const draft = station("TS-SYDKAJ", "Sydkaj transfer station", "draft", false, [12.5741, 55.6523])
      const closed = station("TS-OSTKAJ", "Østkaj transfer station", "closed", true, [12.6305, 55.6907])
      const accepts = (unloadingStationId: string, wasteFractionId: string) => ({ id: mint(), companyId, unloadingStationId, wasteFractionId })
      const memberships = [accepts(fleet.stations.amager.id, fixtures.residual.id), accepts(fleet.stations.amager.id, glass.id), accepts(seasonal.id, food.id), accepts(closed.id, fixtures.residual.id)]
      await withCompany(pool.db, companyId, async (tx) => {
        await tx.insert(wasteFraction).values([food, glass].map((fraction) => ({ ...fraction, companyId })))
        await tx.insert(unloadingStation).values([closed, draft, seasonal])
        await tx.insert(unloadingStationFraction).values([...memberships].reverse())
      })
      try {
        const me = DriverMe.parse(await (await mads("/driver/me")).json())
        const accepting = (id: string, wasteFractionIds: string[]) => ({ id, wasteFractionIds: [...wasteFractionIds].sort() })
        assert.deepEqual(
          me.unloadingStations.map(({ id, wasteFractionIds }) => ({ id, wasteFractionIds })),
          byId([accepting(fleet.stations.amager.id, [fixtures.residual.id, glass.id]), accepting(seasonal.id, [food.id]), accepting(draft.id, [])]),
          "the active, the seasonal and the draft station, each with its own fractions sorted by id and the draft one with none; not the closed one, none of the other company's",
        )
        assert.deepEqual(
          me.unloadingStations.find(({ id }) => id === seasonal.id),
          { id: seasonal.id, name: seasonal.name, location: seasonal.location, weighbridge: true, wasteFractionIds: [food.id] },
          "a station as the unload screen shows it",
        )
        assert.deepEqual(
          me.wasteFractions,
          byId([{ id: fixtures.residual.id, key: "residual", name: "Residual waste" }, glass, food]),
          "the company's three, not the other company's residual",
        )
      } finally {
        // The ground goes back to what the other tests stand on: the fixture's one station, accepting nothing on record, and its one fraction.
        await withCompany(pool.db, companyId, async (tx) => {
          await tx.delete(unloadingStationFraction).where(and(eq(unloadingStationFraction.companyId, companyId), inArray(unloadingStationFraction.id, memberships.map((row) => row.id))))
          await tx.delete(unloadingStation).where(and(eq(unloadingStation.companyId, companyId), inArray(unloadingStation.id, [seasonal.id, draft.id, closed.id])))
          await tx.delete(wasteFraction).where(and(eq(wasteFraction.companyId, companyId), inArray(wasteFraction.id, [glass.id, food.id])))
        })
      }
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
    test("answers the route with its pickups by position, each with its place joined, no session and no unloads yet", async () => {
      const route = await minted({ pickups: 3 })
      const found = await detail(route.id)
      assert.deepEqual([found.id, found.label, found.status, found.session, found.sessions, found.unloads], [route.id, route.label, "ready", null, [], []])
      assert.deepEqual(
        found.pickups.map((pickup) => [pickup.id, pickup.position, pickup.status, pickup.reason, pickup.arrivedAt, pickup.outcomeAt, pickup.propertyId, pickup.wasteFractionId]),
        route.pickupIds.map((id, index) => [id, index + 1, "planned", null, null, null, fixtures.property.id, fixtures.residual.id]),
      )
      // The place joined: the property's address and point (none until it is geocoded), its instructions (none until written), the container's label, the fraction's name — what the device shows at the stop.
      assert.deepEqual(
        found.pickups.map((pickup) => [pickup.address, pickup.location, pickup.driverInstructions, pickup.containerLabel, pickup.wasteFractionName]),
        fixtures.containers.map((bin) => ["Parkvej 18, 2100 København Ø", null, null, bin.label, "Residual waste"]),
      )
      assert.deepEqual(found.planned, { vehicleId: fleet.vehicles.wh24.id, driverId: fleet.drivers.mads.id, trailerId: null, serviceProviderId: null, depotId: fleet.depots.nordhavn.id, unloadingStationId: fleet.stations.amager.id })
      assert.equal(found.plannedStartTime, "06:30")
      assert.equal(found.operatingDate, FIXTURE_DAY)
      const planned = await minted({ status: "planned" })
      assert.equal((await detail(planned.id)).status, "planned", "assigned is assigned, whatever the status")
    })

    test("reads a geocoded property's point through the column's codec, and a shared collection point's address, point and instructions where the pickup names one — the place's words for the driver, never the office's notes", async () => {
      const route = await minted({ pickups: 2 })
      const pointId = testId()
      await withCompany(pool.db, a.companyId, async (tx) => {
        await tx
          .update(propertyTable)
          .set({ location: TOWN_HALL, notes: "Owner disputes the bill", driverInstructions: "Gate code 4711; the bins stand behind the garage" })
          .where(and(eq(propertyTable.companyId, a.companyId), eq(propertyTable.id, fixtures.property.id)))
        await tx.insert(sharedCollectionPoint).values({
          id: pointId,
          companyId: a.companyId,
          projectId: a.projects.copenhagen.id,
          name: "Havnegade island",
          kind: "underground",
          address: "Havnegade 3, 1058 København K",
          location: { type: "Point", coordinates: [12.5951, 55.7089] },
          operatingModel: "municipal",
          accessMode: "open",
          driverInstructions: "Code 2210 on the enclosure",
          billingMode: "municipal",
          status: "open",
        })
        // The second stop moves to the point: one place, the other way (`pickup_place_exactly_one`).
        await tx
          .update(pickupTable)
          .set({ propertyId: null, sharedCollectionPointId: pointId })
          .where(and(eq(pickupTable.companyId, a.companyId), eq(pickupTable.id, route.pickupIds[1])))
      })
      try {
        const found = await detail(route.id)
        assert.deepEqual(
          found.pickups.map((pickup) => [pickup.propertyId, pickup.sharedCollectionPointId, pickup.address, pickup.location]),
          [
            [fixtures.property.id, null, "Parkvej 18, 2100 København Ø", TOWN_HALL],
            [null, pointId, "Havnegade 3, 1058 København K", { type: "Point", coordinates: [12.5951, 55.7089] }],
          ],
          "the property's point once geocoded, the point's address and point where the stop is one",
        )
        assert.deepEqual(
          found.pickups.map((pickup) => pickup.driverInstructions),
          ["Gate code 4711; the bins stand behind the garage", "Code 2210 on the enclosure"],
        )
        assert.doesNotMatch(JSON.stringify(found), /Owner disputes/, "a property's notes are the office's and never reach a phone")
      } finally {
        // The one property every other route's pickups stand at goes back to being ungeocoded and uninstructed, as the fixture has it.
        await withCompany(pool.db, a.companyId, (tx) =>
          tx
            .update(propertyTable)
            .set({ location: null, notes: null, driverInstructions: null })
            .where(and(eq(propertyTable.companyId, a.companyId), eq(propertyTable.id, fixtures.property.id))),
        )
      }
    })

    test("a stop whose container stands for a tank on the route's day carries the tank, what the driver pumps; any other stop none (M11 of #293)", async () => {
      const route = await minted({ pickups: 2 })
      const tankId = testId()
      await withCompany(pool.db, a.companyId, (tx) =>
        tx.insert(tankInstallation).values({ id: tankId, companyId: a.companyId, projectId: a.projects.copenhagen.id, propertyId: fixtures.property.id, containerId: fixtures.containers[0].id, kind: "holding-tank", volumeLitres: 6000, outlet: "none", emptyingIntervalMonths: 12, validFrom: "2020-01-01" }),
      )
      try {
        const found = await detail(route.id)
        assert.deepEqual(found.pickups.map((pickup) => pickup.tank), [{ kind: "holding-tank", volumeLitres: 6000, outlet: "none" }, null])
      } finally {
        await withCompany(pool.db, a.companyId, (tx) => tx.delete(tankInstallation).where(and(eq(tankInstallation.companyId, a.companyId), eq(tankInstallation.id, tankId))))
      }
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

    test("is refused on another driver's active route with the assignment's 404, and the receipt names neither their session nor the stop", async () => {
      const alis = await routeFor(pool, a, fleet, fixtures, { driver: fixtures.drivers.ali, serviceProviderId: a.serviceProviders.nordren.id })
      await started(alis, { call: ali })
      const guess = envelope("arrive", alis.id, { pickupId: alis.pickupIds[0] }, { occurredAt: at("07:00") })
      await rejected(guess, 404, noRouteAssigned(alis.id))
      // The route is of Mads's project, so the receipt names it; but nothing else of a route he was not given is read, so it names no session (Ali's open one) and no pickup (the stop he guessed at), and hands neither back.
      const [receipt] = (await receipts(`?routeId=${alis.id}`)).items.filter((item) => item.id === guess.id)
      assert.deepEqual([receipt.routeId, receipt.sessionId, receipt.pickupId, receipt.outcome], [alis.id, null, null, "rejected"])
      const [rejection] = await events(guess.id)
      assert.deepEqual([(rejection.payload as { sessionId: unknown }).sessionId, (rejection.payload as { pickupId: unknown }).pickupId], [null, null], "the event's receipt says the same")
    })
  })
})
