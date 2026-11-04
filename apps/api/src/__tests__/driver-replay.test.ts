// The driver door (Issue #104, slice 4): replay and the receipt, a container
// confirmed at a stop by its code, and a Service Provider's driver, over the
// setup driver-door-suite.ts shares with driver.test.ts and
// driver-stops.test.ts.
import assert from "node:assert/strict"
import { before, describe, test } from "node:test"

import { DriverIdentification, DriverMe } from "@waste/contracts/driver-commands"
import { Session } from "@waste/contracts/sessions"
import { type Database } from "@waste/db/client"
import { container as containerTable } from "@waste/db/schema/containers"
import { route as routeTable, session as sessionTable } from "@waste/db/schema/execution"
import { withCompany } from "@waste/db/tenant"
import { alreadyOnRoute, noPickupOnRoute, noRouteAssigned, notTheStopsContainer } from "@waste/domain/execution/commands"
import { notActive } from "@waste/domain/execution/transitions"
import { and, eq, sql } from "drizzle-orm"

import { ANOTHER_DEVICES_COMMAND, HELD_AT_WRITE } from "../routes/driver"
import { type Call } from "./calls"
import { at, database, driverDoor, driverDoorCalls, envelope, mint, MORNING, owner, type Envelope } from "./driver-door-suite"
import { routeFor, type DriverFixtures } from "./execution-fixtures"
import { type FleetFixtures } from "./scheme-fixtures"
import { testId, type Tenant } from "./tenant"

describe("the driver door", { skip: database.skip || owner.skip }, () => {
  let now = MORNING
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
  let ungranted: Call
  let theirMads: Call

  before(() => {
    ;({ pool, a, b, fleet, theirFleet, fixtures, theirFixtures, mads, ali, ungranted, theirMads } = door.current)
  })

  const { refused, minted, detail, send, one, applied, rejected, valueOf, started, receipts, written, sessionRow, photoKey, fix } = driverDoorCalls(() => door.current)

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
        envelope("record-positions", route.id, { points: [fix(at("07:51")), fix(at("07:52"))] }, { occurredAt: at("07:52") }),
        envelope("complete-pickup", route.id, { pickupId: p1 }, { occurredAt: at("07:55") }),
        envelope("end-route", route.id, {}, { occurredAt: at("08:00") }),
      ]
      const first = await send(day)
      assert.deepEqual(
        first.map((outcome) => outcome.outcome),
        [...Array.from({ length: 14 }, () => "applied"), "rejected", "applied"],
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
        // The envelope is compared too, not the body alone: another device, another instant, another kind or another route replaying the id is the same note.
        for (const [what, changed] of [
          ["the device", { ...day[3], deviceId: "device-mads-02" }],
          ["the instant", { ...day[3], occurredAt: at("06:51") }],
          ["the kind", { ...day[3], kind: "fail-pickup" as const }],
          ["the route", { ...day[7], routeId: testId() }],
        ] as const) {
          logged.length = 0
          const [again] = await send([changed])
          assert.equal(again.outcome, "replayed", what)
          assert.equal(logged.length, 1, `${what} differs: logged`)
        }
        logged.length = 0
        const [same] = await send([day[3]])
        assert.equal(same.outcome, "replayed")
        assert.equal(logged.length, 0, "the same command again is not logged")
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

    test("an id another device's command holds is refused, never replayed and recorded nowhere, while the device that sent it still replays it", async () => {
      const route = await minted()
      const alis = await routeFor(pool, a, fleet, fixtures, { driver: fixtures.drivers.ali, serviceProviderId: a.serviceProviders.nordren.id })
      const theirs = await routeFor(pool, b, theirFleet, theirFixtures, { driver: theirFleet.drivers.mads })
      const start = envelope("start-route", route.id, { vehicleId: fleet.vehicles.wh24.id, location: { type: "Point", coordinates: [12.5951, 55.7089] } })
      await applied(start)
      const before = await written()
      logged.length = 0
      // Ali's device claims Mads's command id: for a start of his own route, whose session would take the id (`session_pkey`), and for a pause, which makes no row and meets the receipt's key.
      for (const [what, claimed, call] of [
        ["Ali starting his route on Mads's id", envelope("start-route", alis.id, { vehicleId: fleet.vehicles.wh25.id }, { id: start.id, deviceId: "device-ali-01" }), ali],
        ["Ali pausing on Mads's id", envelope("pause", alis.id, {}, { id: start.id, deviceId: "device-ali-01" }), ali],
        ["another company's driver on Mads's id", envelope("start-route", theirs.id, { vehicleId: theirFleet.vehicles.wh24.id }, { id: start.id, deviceId: "device-their-mads" }), theirMads],
      ] as const) {
        const outcome = await one(claimed, call)
        assert.equal(outcome.outcome, "rejected", what)
        assert.deepEqual([outcome.problem?.status, outcome.problem?.detail, outcome.result], [409, ANOTHER_DEVICES_COMMAND, undefined], what)
      }
      assert.equal(ANOTHER_DEVICES_COMMAND, "That command id belongs to another device's command")
      assert.deepEqual(await written(), before, "no session, no receipt, no event: the id's receipt is Mads's and stays his")
      assert.equal((await detail(alis.id, ali)).status, "ready", "Ali's route did not start")
      assert.equal((await receipts("?limit=200", ali)).items.some((receipt) => receipt.id === start.id), false, "and Ali has no receipt under the id")
      assert.equal(logged.length, 3, "the one rejection no receipt can hold goes to the log")
      assert.deepEqual((logged[0] as { detail: unknown; driverId: unknown }).detail, ANOTHER_DEVICES_COMMAND)
      assert.equal((logged[0] as { driverId: unknown }).driverId, fixtures.drivers.ali.id)
      // Mads's own replay still answers the first outcome, the session read back, and the other device learned nothing of it.
      const [replay] = await send([start])
      assert.equal(replay.outcome, "replayed")
      assert.equal(valueOf(replay, "session", Session).id, start.id)
      assert.deepEqual(await written(), before)
    })

    test("two of one driver's routes started at once meet on the one-live-session-per-driver index: one starts, the other is that command's rejection naming the winner — by the rule or at the write, whichever the timing gives — and both batches go on", async () => {
      const first = await minted()
      const second = await minted()
      const batches = [first, second].map((route) => [envelope("start-route", route.id, { vehicleId: fleet.vehicles.wh24.id }), envelope("pause", route.id, {}, { occurredAt: at("06:31") })])
      const [left, right] = await Promise.all(batches.map((batch) => send(batch)))
      const outcomes = [left, right].map((batch) => batch.map((outcome) => outcome.outcome).join(","))
      assert.deepEqual([...outcomes].sort(), ["applied,applied", "rejected,rejected"], "one start went through with its pause; the other's start and pause were both answered")
      const won = outcomes[0] === "applied,applied" ? first : second
      const lost = won === first ? second : first
      const loser = won === first ? right : left
      assert.equal(loser[0].problem?.status, 409)
      assert.equal(loser[0].problem?.detail, alreadyOnRoute("Mads Jensen", won.label), "the rule's sentence naming the route that won, whether the rule or the index refused; the test below pins the index")
      assert.equal(loser[1].problem?.detail, notActive(lost.label), "the rest of the losing batch was judged and recorded, not lost")
      assert.deepEqual((await detail(lost.id)).sessions, [], "the loser's session was rolled back")
      assert.equal((await detail(lost.id)).status, "ready")
      assert.equal((await detail(won.id)).status, "active")
      for (const [route, batch] of [
        [won, won === first ? batches[0] : batches[1]],
        [lost, lost === first ? batches[0] : batches[1]],
      ] as const) {
        assert.deepEqual(
          (await receipts(`?routeId=${route.id}`)).items.map((receipt) => receipt.id),
          batch.map((command) => command.id),
          `${route.label}: both commands have their receipt`,
        )
      }
    })

    test("a start the index holds at the write — the winner's session uncommitted when the loser's rule read it, committed when the loser's insert landed — is that command's rejection naming the winner, recorded, and noted in the log as held at the write", async () => {
      // What the concurrent test above cannot pin: its loser may lose by the rule (`driverOpenOn` read the winner's committed row a statement before the write) or at the write (the index refused the insert), and the sentence is the same either way, so that test passes without the catch ever running. Here the winner is hand-driven — Mads's session on the first route, inserted the way the fixtures insert one, in a transaction held open — so the loser's rule read cannot see it (READ COMMITTED: an uncommitted row is invisible) and its insert waits on the winner's outcome under `session_driver_open_idx`; the winner commits only once Postgres reports the loser blocked behind it (`pg_blocking_pids`), and the insert then fails with 23505 on a row the loser could not have read.
      const first = await minted()
      const second = await minted()
      const batch = [envelope("start-route", second.id, { vehicleId: fleet.vehicles.wh24.id }), envelope("pause", second.id, {}, { occurredAt: at("06:31") })]
      const winnersSession = mint()
      const released = Promise.withResolvers<void>()
      const inserted = Promise.withResolvers<number>()
      const winner = withCompany(pool.db, a.companyId, async (tx) => {
        const [{ pid }] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
        await tx.insert(sessionTable).values({
          id: winnersSession,
          companyId: a.companyId,
          projectId: a.projects.copenhagen.id,
          routeId: first.id,
          driverId: fleet.drivers.mads.id,
          vehicleId: fleet.vehicles.wh24.id,
          deviceId: "device-mads-01",
          appVersion: "1.4.0",
          startedAt: new Date(at("06:30")),
          lastSeenAt: MORNING,
        })
        await tx
          .update(routeTable)
          .set({ status: "active", startedAt: new Date(at("06:30")), actualVehicleId: fleet.vehicles.wh24.id, actualDriverId: fleet.drivers.mads.id })
          .where(and(eq(routeTable.companyId, a.companyId), eq(routeTable.id, first.id)))
        inserted.resolve(pid)
        await released.promise
      })
      /** Rejects if the winner ends before it is released — an insert refused, say — so a broken winner fails the test instead of hanging it on the pid. */
      const endedEarly = winner.then(() => Promise.reject(new Error("the winner's transaction ended before it was released")))
      void endedEarly.catch(() => undefined)
      logged.length = 0
      const losing = send(batch)
      try {
        const pid = await Promise.race([inserted.promise, endedEarly])
        // Postgres names the backends a process blocks: the loser's insert is waiting on the winner's transaction once this answers a row, and not before.
        const blocked = async (): Promise<boolean> => (await pool.sql`select pid from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`).length > 0
        const deadline = Date.now() + 10_000
        while (!(await blocked())) {
          assert.ok(Date.now() < deadline, "the loser's insert never waited on the winner: the index did not hold it")
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      } finally {
        released.resolve()
        await winner
        await losing.catch(() => undefined)
      }
      const loser = await losing
      assert.deepEqual(loser.map((outcome) => outcome.outcome), ["rejected", "rejected"])
      assert.deepEqual([loser[0].problem?.status, loser[0].problem?.detail], [409, alreadyOnRoute("Mads Jensen", first.label)], "the rule's sentence, naming the route that won")
      assert.equal(loser[1].problem?.detail, notActive(second.label), "the rest of the batch was judged and recorded")
      assert.deepEqual(
        logged,
        [{ event: HELD_AT_WRITE, constraint: "session_driver_open_idx", commandId: batch[0].id, kind: "start-route", routeId: second.id, driverId: fleet.drivers.mads.id }],
        "the write is what held it, and the log says so: the one way to tell this door from the rule's",
      )
      assert.equal(HELD_AT_WRITE, "driver-command-held-at-write")
      const page = await receipts(`?routeId=${second.id}`)
      assert.deepEqual(
        page.items.map((receipt) => [receipt.id, receipt.outcome, receipt.problem?.detail]),
        [
          [batch[0].id, "rejected", alreadyOnRoute("Mads Jensen", first.label)],
          [batch[1].id, "rejected", notActive(second.label)],
        ],
        "both commands have their receipt",
      )
      const lost = await detail(second.id)
      assert.deepEqual([lost.status, lost.sessions], ["ready", []], "the loser's session was rolled back")
      const won = await detail(first.id)
      assert.deepEqual([won.status, won.sessions.map((session) => session.id)], ["active", [winnersSession]], "the winner's stands")
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

  describe("a container confirmed at a stop by its code (O19 of #290)", () => {
    /** Gives the fixture containers a barcode and an RFID tag each, the way a registry holds them. */
    const tagged = () =>
      withCompany(pool.db, a.companyId, async (tx) => {
        for (const [index, bin] of fixtures.containers.entries()) {
          await tx
            .update(containerTable)
            .set({ barcode: `WH9000${index}`, rfid: `E2009000${index}`, serialNumber: index === 0 ? null : `SN-${index}` })
            .where(and(eq(containerTable.companyId, a.companyId), eq(containerTable.id, bin.id)))
        }
      })
    const identify = async (routeId: string, code: string, call = mads): Promise<DriverIdentification> => {
      const response = await call(`/driver/routes/${routeId}/identify?code=${encodeURIComponent(code)}`)
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
      return DriverIdentification.parse(await response.json())
    }

    test("the identify read names the stops of the route whose container the code names, by which identifier, and nothing of a bin elsewhere", async () => {
      await tagged()
      const route = await minted({ pickups: 2 })
      const [first, second] = fixtures.containers
      assert.deepEqual(await identify(route.id, " wh90000 "), {
        code: "wh90000",
        stops: [{ pickupId: route.pickupIds[0], position: 1, containerId: first.id, containerLabel: first.label, matchedBy: "barcode", replacement: false }],
      })
      assert.deepEqual((await identify(route.id, "E20090001")).stops.map((stop) => [stop.pickupId, stop.matchedBy]), [[route.pickupIds[1], "rfid"]])
      assert.deepEqual((await identify(route.id, second.label)).stops.map((stop) => stop.matchedBy), ["label"])
      assert.deepEqual((await identify(route.id, "SN-1")).stops.map((stop) => stop.matchedBy), ["serial-number"])
      // The third bin is the company's but on no stop of this route: the code answers nothing, so a device learns nothing of the company's other bins.
      assert.deepEqual((await identify(route.id, "WH90002")).stops, [])
      assert.deepEqual((await identify(route.id, "NO-SUCH-BIN")).stops, [])
      assert.deepEqual((await refused(await mads(`/driver/routes/${route.id}/identify`), 400)).errors?.map((error) => error.path), ["code"])
      assert.deepEqual((await refused(await mads(`/driver/routes/${route.id}/identify?code=%20%20`), 400)).errors?.map((error) => error.path), ["code"])
      const theirs = await minted({ driver: fleet.drivers.freja })
      assert.equal((await refused(await mads(`/driver/routes/${theirs.id}/identify?code=WH90000`), 404)).detail, noRouteAssigned(theirs.id))
      assert.equal((await refused(await theirMads(`/driver/routes/${route.id}/identify?code=WH90000`), 404)).detail, noRouteAssigned(route.id))
      assert.equal((await ungranted(`/driver/routes/${route.id}/identify?code=WH90000`)).status, 403)
    })

    test("an arrival carrying the stop's own code is applied and read back as the stop's confirmation; another bin's code is refused at the code, and an arrival without one confirms nothing", async () => {
      await tagged()
      const route = await minted({ pickups: 2 })
      await started(route)
      const before = await detail(route.id)
      assert.deepEqual(before.pickups.map((stop) => stop.containerConfirmedAt), [null, null])

      await applied(envelope("arrive", route.id, { pickupId: route.pickupIds[1] }, { occurredAt: at("06:40") }))
      const wrong = await rejected(envelope("arrive", route.id, { pickupId: route.pickupIds[0], identification: { code: "WH90001", method: "camera" } }, { occurredAt: at("06:41") }), 400, notTheStopsContainer("WH90001", 1))
      assert.deepEqual(wrong.errors?.map((error) => error.path), ["body.identification.code"])
      await rejected(envelope("arrive", route.id, { pickupId: route.pickupIds[0], identification: { code: "WH90002", method: "typed" } }, { occurredAt: at("06:42") }), 400, notTheStopsContainer("WH90002", 1))
      const shapeless = await one(envelope("arrive", route.id, { pickupId: route.pickupIds[0], identification: { code: "WH90000", method: "nfc" } }, { occurredAt: at("06:42") }))
      assert.equal(shapeless.outcome, "rejected", "a method outside the vocabulary is the body's rejection")
      assert.equal((await detail(route.id)).pickups[0].arrivedAt, null, "a refused confirmation is no arrival")

      await applied(envelope("arrive", route.id, { pickupId: route.pickupIds[0], identification: { code: "wh90000", method: "camera" } }, { occurredAt: at("06:43") }))
      await applied(envelope("arrive", route.id, { pickupId: route.pickupIds[0], identification: { code: fixtures.containers[0].label, method: "typed" } }, { occurredAt: at("06:45") }))
      const after = await detail(route.id)
      assert.deepEqual(
        after.pickups.map((stop) => [stop.arrivedAt, stop.containerConfirmedAt]),
        [
          [at("06:43"), at("06:45")],
          [at("06:40"), null],
        ],
        "the first arrival sets arrivedAt; the latest confirmation is the stop's",
      )
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
      // What a start and an unload pick from is bounded by the driver profile and the company, never by Project Access: Ali's account works in no project, and his profile is Copenhagen Central's, as Mads's is.
      const madsMe = DriverMe.parse(await (await mads("/driver/me")).json())
      assert.ok(me.vehicles.length > 0 && me.unloadingStations.length > 0 && me.wasteFractions.length > 0, "an account in no project picks from the lists all the same")
      assert.deepEqual([me.vehicles, me.unloadingStations, me.wasteFractions], [madsMe.vehicles, madsMe.unloadingStations, madsMe.wasteFractions])
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
