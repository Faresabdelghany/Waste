// The driver door (Issue #104, slice 4): the stops' commands and
// record-positions, over the setup driver-door-suite.ts shares with
// driver.test.ts and driver-replay.test.ts.
import assert from "node:assert/strict"
import { before, describe, test } from "node:test"

import { DriverMe } from "@waste/contracts/driver-commands"
import { ProofOfService } from "@waste/contracts/proofs"
import { Route } from "@waste/contracts/routes"
import { Unload } from "@waste/contracts/unloads"
import { type Database } from "@waste/db/client"
import { wasteFraction } from "@waste/db/schema/catalogue"
import { unloadingStationFraction } from "@waste/db/schema/places"
import { ticket as ticketTable } from "@waste/db/schema/resolution"
import { withCompany } from "@waste/db/tenant"
import {
  BEFORE_THE_SESSION_STARTED,
  noPickupOnRoute,
  NOT_A_FRACTION,
  NOT_A_STATION,
  OBJECT_KEY_NAMES_ANOTHER,
  OCCURRED_AT_SKEW_MS,
  RECORDED_AFTER_IT_HAPPENED,
  recordedTooLate,
} from "@waste/domain/execution/commands"
import { alreadyDecided, notActive } from "@waste/domain/execution/transitions"
import { NET_IS_GROSS_LESS_TARE } from "@waste/domain/execution/unloads"
import type { DriverCommandKind } from "@waste/domain/execution/vocabulary"
import { objectKeyOf, PROOF_KEY_SHAPE } from "@waste/domain/storage-objects"
import { and, asc, eq, inArray } from "drizzle-orm"

import { COMMAND_BACKDATE_MS } from "../routes/driver"
import { type Call } from "./calls"
import { at, database, driverDoor, driverDoorCalls, envelope, fromNow, mint, MORNING, owner } from "./driver-door-suite"
import { TOWN_HALL, type DriverFixtures } from "./execution-fixtures"
import { type FleetFixtures } from "./scheme-fixtures"
import { testId, type Tenant } from "./tenant"

describe("the driver door", { skip: database.skip || owner.skip }, () => {
  let now = MORNING
  const logged: unknown[] = []
  const door = driverDoor({ now: () => now, logged })
  let pool: Database
  let a: Tenant
  let b: Tenant
  let fleet: FleetFixtures
  let fixtures: DriverFixtures
  let theirFixtures: DriverFixtures
  let mads: Call

  before(() => {
    ;({ pool, a, b, fleet, fixtures, theirFixtures, mads } = door.current)
  })

  const { minted, detail, send, one, applied, rejected, valueOf, started, events, receipts, written, sessionRow, photoKey, fix, positionsOf, receiptRow } = driverDoorCalls(() => door.current)

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

    test("report-problem, add-photo, add-weight, record-volume, add-signature and add-note append their proofs, on a stop or on the route alone", async () => {
      const route = await minted()
      const sessionId = await started(route)
      const [pickupId] = route.pickupIds
      const onStop = valueOf(await applied(envelope("report-problem", route.id, { pickupId, reason: "safety", note: "Loose dog" }, { occurredAt: at("07:00") })), "proof", ProofOfService)
      assert.deepEqual([onStop.kind, onStop.pickupId, onStop.reason, onStop.note, onStop.sessionId], ["problem", pickupId, "safety", "Loose dog", sessionId])
      assert.deepEqual((await events(pickupId)).map((event) => [event.kind, event.aggregateKind]), [["pickup-problem-reported", "pickup"]])
      const onRoute = valueOf(await applied(envelope("report-problem", route.id, { reason: "other", note: "Road closed at Parkvej" }, { occurredAt: at("07:01") })), "proof", ProofOfService)
      assert.deepEqual([onRoute.kind, onRoute.pickupId], ["problem", null])
      const problemReported = (await events(route.id)).find((event) => event.kind === "route-problem-reported")
      assert.ok(problemReported, "a route-level problem is the route's own kind of event")
      assert.equal(problemReported.aggregateKind, "route")
      // The payload is the route with the problem proof, so the reason and the note travel with the event the way a stop's do inside its pickup.
      const reported = problemReported.payload as { id: string; status: string; proofs: unknown[] }
      assert.deepEqual([reported.id, reported.status, reported.proofs], [route.id, "active", [onRoute]], "the route as it stands, with the one proof this command made")
      assert.deepEqual([(reported.proofs[0] as ProofOfService).reason, (reported.proofs[0] as ProofOfService).note], ["other", "Road closed at Parkvej"])
      assert.equal(Route.parse(problemReported.payload).id, route.id, "and still a Route to a consumer that reads one")
      assert.equal((await detail(route.id)).pickups[0].status, "planned", "a reported problem moves no status")

      const photoId = mint()
      const photo = valueOf(await applied(envelope("add-photo", route.id, { objectKey: photoKey(route, photoId) }, { id: photoId, occurredAt: at("07:02") })), "proof", ProofOfService)
      assert.deepEqual([photo.kind, photo.pickupId, photo.objectKey], ["photo", null, `${a.companyId}/${route.id}/${photoId}.jpg`])
      const weight = valueOf(await applied(envelope("add-weight", route.id, { pickupId, weightKg: 148 }, { occurredAt: at("07:03") })), "proof", ProofOfService)
      assert.deepEqual([weight.kind, weight.pickupId, weight.weightKg], ["weight", pickupId, 148])
      // The litres a tank was emptied of (M11 of #293), the stop's evidence like a weight.
      const volume = valueOf(await applied(envelope("record-volume", route.id, { pickupId, volumeLitres: 2800 }, { occurredAt: at("07:03") })), "proof", ProofOfService)
      assert.deepEqual([volume.kind, volume.pickupId, volume.volumeLitres, volume.weightKg], ["volume", pickupId, 2800, null])
      const litreless = await rejected(envelope("record-volume", route.id, { pickupId, volumeLitres: 0 }, { occurredAt: at("07:03") }), 400, "The request body is invalid")
      assert.deepEqual(litreless.errors?.map((error) => error.path), ["body.volumeLitres"])
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
      assert.deepEqual(malformed.errors, [{ path: "body.objectKey", message: PROOF_KEY_SHAPE }])
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

    test("a load the station does not take is recorded all the same, and the office is told in an internal task in the station's sentence; a refused load and a taken one tell nothing (O9 of #290)", async () => {
      const route = await minted()
      await started(route)
      const tasksOn = () =>
        withCompany(pool.db, a.companyId, (tx) =>
          tx
            .select({ kind: ticketTable.kind, source: ticketTable.source, priority: ticketTable.priority, subject: ticketTable.subject, description: ticketTable.description, createdBy: ticketTable.createdBy, routeId: ticketTable.routeId, driverId: ticketTable.driverId })
            .from(ticketTable)
            .where(and(eq(ticketTable.companyId, a.companyId), eq(ticketTable.routeId, route.id)))
            .orderBy(asc(ticketTable.id)),
        )
      const tip = (netKg: number, occurredAt: string, extra: Record<string, unknown> = {}) =>
        envelope("record-unload", route.id, { unloadingStationId: fleet.stations.amager.id, wasteFractionId: fixtures.residual.id, netKg, ...extra }, { occurredAt })

      // The suite's station names no fraction it takes.
      const untaken = valueOf(await applied(tip(8240, at("10:12"))), "unload", Unload)
      assert.equal(untaken.refusal, null, "recorded as tipped: a rejection would lose the weighbridge's reading")
      const [task, ...more] = await tasksOn()
      assert.equal(more.length, 0)
      assert.deepEqual(
        [task.kind, task.source, task.priority, task.subject, task.createdBy, task.routeId, task.driverId],
        ["internal-task", "driver-app", "medium", `Unload of Residual waste at ARC Amager Bakke on ${route.label} not accepted`, fixtures.accounts.mads.id, route.id, fleet.drivers.mads.id],
      )
      assert.match(task.description, new RegExp(`^The driver recorded 8,240 kg of Residual waste at ARC Amager Bakke on route ${route.label} at \\d\\d:\\d\\d on \\w+ \\d+ \\w+, but Station ARC Amager Bakke has no accepted fractions set\\. Set them on the station, then review the unload in weight control\\.$`))

      // The route's next unload of the fraction there is the same news while the task is open.
      await applied(tip(6100, at("10:14")))
      assert.equal((await tasksOn()).length, 1, "one open task per route, station and fraction")

      // Refused, the load tells nothing: the station's word is on the row.
      const turnedAway = valueOf(await applied(tip(500, at("10:20"), { refusal: { reason: "contamination", note: "Plastic bags" } })), "unload", Unload)
      assert.deepEqual(turnedAway.refusal, { reason: "contamination", note: "Plastic bags" })
      assert.equal((await tasksOn()).length, 1)
      const wordless = await rejected(tip(500, at("10:21"), { refusal: { reason: "other" } }), 400, "The request body is invalid")
      assert.deepEqual(wordless.errors?.map((error) => error.path), ["body.refusal.note"])

      // The station takes glass alone, then residual waste too.
      const glass = testId()
      const memberships = [{ id: testId(), companyId: a.companyId, unloadingStationId: fleet.stations.amager.id, wasteFractionId: glass }]
      await withCompany(pool.db, a.companyId, async (tx) => {
        await tx.insert(wasteFraction).values({ id: glass, companyId: a.companyId, key: "glass", name: "Glass" })
        await tx.insert(unloadingStationFraction).values(memberships)
      })
      try {
        // The office closes the first task; the next unload not taken is news again, in the other sentence.
        await withCompany(pool.db, a.companyId, (tx) => tx.update(ticketTable).set({ status: "rejected", closedAt: new Date() }).where(and(eq(ticketTable.companyId, a.companyId), eq(ticketTable.routeId, route.id))))
        await applied(tip(900, at("10:30")))
        const [, other] = await tasksOn()
        assert.match(other.description, /but Station ARC Amager Bakke does not take Residual waste\. Check the station's accepted fractions, or review the unload in weight control\.$/)
        const taken = { id: testId(), companyId: a.companyId, unloadingStationId: fleet.stations.amager.id, wasteFractionId: fixtures.residual.id }
        memberships.push(taken)
        await withCompany(pool.db, a.companyId, (tx) => tx.insert(unloadingStationFraction).values(taken))
        await applied(tip(700, at("10:40")))
        assert.equal((await tasksOn()).length, 2, "a load the station takes tells nothing")
      } finally {
        await withCompany(pool.db, a.companyId, (tx) => tx.delete(unloadingStationFraction).where(and(eq(unloadingStationFraction.companyId, a.companyId), inArray(unloadingStationFraction.id, memberships.map((row) => row.id)))))
      }
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

  describe("record-positions (O8 of #290)", () => {
    test("appends one position per fix to the session the command ran in, moves lastSeenAt, writes no event, and keeps in the receipt the count of the fixes and none of their points", async () => {
      const route = await minted({ pickups: 1 })
      const sessionId = await started(route)
      const before = await written()
      const command = envelope("record-positions", route.id, { points: [fix(at("06:40")), fix(at("06:41"), { location: { type: "Point", coordinates: [12.5951, 55.7089] }, accuracyM: 30, speedKmh: 42, headingDeg: 270 })] }, { occurredAt: at("06:41") })
      now = new Date(MORNING.getTime() + 60_000)
      try {
        const outcome = await applied(command)
        assert.equal(outcome.result, undefined, "a position is no resource the device reads back")
        assert.equal((await sessionRow(sessionId)).lastSeenAt.toISOString(), now.toISOString(), "the device was heard from")
      } finally {
        now = MORNING
      }
      assert.deepEqual(
        (await positionsOf(sessionId)).map((row) => ({ ...row, fixedAt: row.fixedAt.toISOString() })),
        [
          { sessionId, routeId: route.id, driverId: fleet.drivers.mads.id, fixedAt: at("06:40"), location: TOWN_HALL, accuracyM: 12, speedKmh: null, headingDeg: null },
          { sessionId, routeId: route.id, driverId: fleet.drivers.mads.id, fixedAt: at("06:41"), location: { type: "Point", coordinates: [12.5951, 55.7089] }, accuracyM: 30, speedKmh: 42, headingDeg: 270 },
        ],
      )
      const after = await written()
      assert.deepEqual({ ...after, commands: after.commands - before.commands, positions: after.positions - before.positions }, { ...before, commands: 1, positions: 2 }, "a receipt and two positions, no proof and no event")
      const receipt = await receiptRow(command.id)
      assert.deepEqual([receipt.kind, receipt.outcome, receipt.sessionId, receipt.body], ["record-positions", "applied", sessionId, { points: 2 }])
      assert.equal(JSON.stringify(receipt.body).includes(String(TOWN_HALL.coordinates[0])), false, "no coordinate in the receipt")
    })

    test("judges every fix on the envelope's clock rules — five minutes ahead at most, forty-eight hours behind at most, not before the session started — at the fix's own field, and writes none of a refused command's fixes", async () => {
      const route = await minted()
      const sessionId = await started(route)
      const before = await written()
      const ahead = await rejected(envelope("record-positions", route.id, { points: [fix(at("06:40")), fix(fromNow(OCCURRED_AT_SKEW_MS + 1_000))] }, { occurredAt: at("06:41") }), 400, RECORDED_AFTER_IT_HAPPENED)
      assert.deepEqual(ahead.errors, [{ path: "body.points.1.at", message: RECORDED_AFTER_IT_HAPPENED }])
      assert.equal((await applied(envelope("record-positions", route.id, { points: [fix(fromNow(OCCURRED_AT_SKEW_MS))] }, { occurredAt: at("06:41") }))).outcome, "applied", "at the edge ahead")

      const early = await rejected(envelope("record-positions", route.id, { points: [fix(at("06:29")), fix(at("06:42"))] }, { occurredAt: at("06:42") }), 400, BEFORE_THE_SESSION_STARTED)
      assert.deepEqual(early.errors, [{ path: "body.points.0.at", message: BEFORE_THE_SESSION_STARTED }])
      assert.equal((await applied(envelope("record-positions", route.id, { points: [fix(at("06:30"))] }, { occurredAt: at("06:43") }))).outcome, "applied", "at the session's start")

      now = new Date(Date.parse(at("06:30")) + COMMAND_BACKDATE_MS + 60_000)
      try {
        const late = await rejected(envelope("record-positions", route.id, { points: [fix(at("06:30")), fix(at("06:44"))] }, { occurredAt: at("06:44") }), 400, recordedTooLate(COMMAND_BACKDATE_MS))
        assert.deepEqual(late.errors, [{ path: "body.points.0.at", message: recordedTooLate(COMMAND_BACKDATE_MS) }])
      } finally {
        now = MORNING
      }
      assert.deepEqual(
        (await positionsOf(sessionId)).map((row) => row.fixedAt.toISOString()),
        [at("06:30"), fromNow(OCCURRED_AT_SKEW_MS)],
        "the two at the edges, and nothing of the three refused",
      )
      assert.equal((await written()).positions - before.positions, 2)
    })

    test("a paused session takes the fixes kept before the pause; an ended route refuses them as not active", async () => {
      const route = await minted()
      const sessionId = await started(route)
      await applied(envelope("pause", route.id, {}, { occurredAt: at("07:00") }))
      await applied(envelope("record-positions", route.id, { points: [fix(at("06:58")), fix(at("06:59"))] }, { occurredAt: at("07:01") }))
      assert.equal((await positionsOf(sessionId)).length, 2)
      await applied(envelope("end-route", route.id, {}, { occurredAt: at("07:10") }))
      await rejected(envelope("record-positions", route.id, { points: [fix(at("07:11"))] }, { occurredAt: at("07:11") }), 409, notActive(route.label))
      assert.equal((await positionsOf(sessionId)).length, 2)
    })

    test("a body its schema refuses is recorded with the schema's issues, its points never kept in the receipt", async () => {
      const route = await minted()
      await started(route)
      const outOfOrder = envelope("record-positions", route.id, { points: [fix(at("06:45")), fix(at("06:44"))] }, { occurredAt: at("06:45") })
      const [outcome] = await send([outOfOrder])
      assert.equal(outcome.outcome, "rejected")
      assert.deepEqual(outcome.problem?.errors?.map((error) => error.path), ["body.points"])
      assert.deepEqual((await receiptRow(outOfOrder.id)).body, { points: 2 })
      const shapeless = envelope("record-positions", route.id, { points: "here" }, { occurredAt: at("06:46") })
      assert.equal((await one(shapeless)).outcome, "rejected")
      assert.deepEqual((await receiptRow(shapeless.id)).body, { points: null })
    })
  })
})
