import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { DRIVER_COMMAND_KINDS, type DriverCommandKind } from "@waste/domain/execution/vocabulary"

import {
  BATCH_MAX,
  COMMAND_BODIES,
  CommandOutcomeRow,
  DriverCommand,
  DriverCommandBatch,
  DriverCommandBatchOutcome,
  DriverCommandEnvelope,
  DriverCommandReceipt,
  DriverMe,
  DriverPickup,
  DriverRouteDetail,
  EACH_COMMAND_ONCE,
  OBJECT_KEY_SHAPE,
  PROBLEM_WITH_A_REJECTION,
  WireOutcome,
} from "../driver-commands"
import { LABEL_IS_THE_NUMBER } from "../routes"
import { BOTH_GROSS_AND_TARE, NET_IS_GROSS_LESS_TARE } from "../unloads"
import { refusal } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const THIRD = "01a0d3a5-e5e0-7000-8000-000000000003"
const COMPANY = "01a0d3a5-e5e0-7000-8000-000000000004"
const WHEN = "2026-10-05T06:20:00.000Z"
const POINT = { type: "Point", coordinates: [12.5951, 55.7089] }
const KEY = `${COMPANY}/${OTHER}/${ID}.jpg`
const STAMPS = { createdAt: WHEN, updatedAt: WHEN }

const envelope = { id: ID, routeId: OTHER, occurredAt: WHEN, deviceId: "device-7" }

/** A valid body of each kind. */
const bodies: Record<DriverCommandKind, object> = {
  "start-route": { vehicleId: THIRD, trailerId: ID, appVersion: "1.4.0", location: POINT, accuracyM: 12 },
  arrive: { pickupId: THIRD, location: POINT, accuracyM: 8 },
  "complete-pickup": { pickupId: THIRD, note: "Two bins" },
  "skip-pickup": { pickupId: THIRD, reason: "not-presented" },
  "fail-pickup": { pickupId: THIRD, reason: "contamination", note: "Paint in the bin", location: POINT },
  "report-problem": { reason: "safety", note: "Dog loose" },
  "add-photo": { pickupId: THIRD, objectKey: KEY },
  "add-weight": { pickupId: THIRD, weightKg: 148 },
  "add-signature": { pickupId: THIRD, objectKey: KEY },
  "add-note": { note: "Key under the mat" },
  "record-unload": { unloadingStationId: THIRD, wasteFractionId: ID, netKg: 4_200, grossKg: 12_400, tareKg: 8_200, weighbridgeTicket: "WB-2026-3901", objectKey: KEY, note: "Second tip", location: POINT },
  pause: {},
  resume: {},
  "end-route": { note: "Done for today", location: POINT },
}

const command = (kind: DriverCommandKind, body: object = bodies[kind]) => ({ ...envelope, kind, body })

describe("DriverCommand", () => {
  test("is the discriminated union over the fourteen kinds, each a strict envelope around a strict body", () => {
    assert.deepEqual(Object.keys(COMMAND_BODIES).sort(), [...DRIVER_COMMAND_KINDS].sort())
    for (const kind of DRIVER_COMMAND_KINDS) assert.deepEqual(DriverCommand.parse(command(kind)), command(kind), kind)
    assert.equal(DriverCommand.safeParse(command("reschedule-stop" as DriverCommandKind, {})).success, false, "a Ticket's, not a command")
    for (const key of ["id", "routeId", "occurredAt", "deviceId", "body"]) {
      const without: Record<string, unknown> = command("pause")
      delete without[key]
      assert.deepEqual(refusal(DriverCommand.safeParse(without)).map((issue) => issue.path), [key])
    }
    assert.match(refusal(DriverCommand.safeParse({ ...command("pause"), driverId: ID }))[0].message, /driverId/, "the driver is the caller's login, not the body's word")
    assert.equal(DriverCommand.safeParse({ ...command("pause"), occurredAt: "2026-10-05" }).success, false, "an instant with an offset")
  })

  test("every kind refuses a member of another kind's body, by name", () => {
    /** A member the kind's body does not have, from some other kind's. */
    const foreign: Record<DriverCommandKind, [string, unknown]> = {
      "start-route": ["pickupId", THIRD],
      arrive: ["vehicleId", THIRD],
      "complete-pickup": ["reason", "other"],
      "skip-pickup": ["weightKg", 1],
      "fail-pickup": ["objectKey", KEY],
      "report-problem": ["vehicleId", THIRD],
      "add-photo": ["reason", "other"],
      "add-weight": ["location", POINT],
      "add-signature": ["weightKg", 1],
      "add-note": ["location", POINT],
      "record-unload": ["pickupId", THIRD],
      pause: ["note", "x"],
      resume: ["pickupId", THIRD],
      "end-route": ["pickupId", THIRD],
    }
    for (const kind of DRIVER_COMMAND_KINDS) {
      const [member, value] = foreign[kind]
      const issues = refusal(DriverCommand.safeParse(command(kind, { ...bodies[kind], [member]: value })))
      assert.deepEqual(issues.map((issue) => issue.path), ["body"], kind)
      assert.match(issues[0].message, new RegExp(member), kind)
    }
  })

  test("the bodies hold their own rules: the required members, the driver's reasons, the object key's shape, the unload's weights", () => {
    const missing = (kind: DriverCommandKind, member: string) => {
      const body: Record<string, unknown> = { ...bodies[kind] }
      delete body[member]
      assert.deepEqual(refusal(DriverCommand.safeParse(command(kind, body))).map((issue) => issue.path), [`body.${member}`], `${kind} without ${member}`)
    }
    missing("start-route", "vehicleId")
    missing("arrive", "pickupId")
    missing("complete-pickup", "pickupId")
    missing("skip-pickup", "reason")
    missing("fail-pickup", "pickupId")
    missing("report-problem", "note")
    missing("add-photo", "objectKey")
    missing("add-weight", "weightKg")
    missing("add-signature", "pickupId")
    missing("add-note", "note")
    missing("record-unload", "netKg")
    // A problem, a photo and a note may stand on the route; a signature is a stop's.
    assert.equal(DriverCommand.safeParse(command("report-problem", { reason: "other", note: "Road closed" })).success, true)
    assert.equal(DriverCommand.safeParse(command("add-photo", { objectKey: KEY })).success, true)
    assert.equal(DriverCommand.safeParse(command("add-note", { note: "x" })).success, true)
    // The driver's six reasons and not the system's four.
    assert.deepEqual(refusal(DriverCommand.safeParse(command("skip-pickup", { pickupId: THIRD, reason: "route-ended" }))).map((issue) => issue.path), ["body.reason"])
    assert.deepEqual(refusal(DriverCommand.safeParse(command("report-problem", { reason: "regeneration", note: "x" }))).map((issue) => issue.path), ["body.reason"])
    // The object key's shape; which ids it names is the applier's rule.
    assert.deepEqual(refusal(DriverCommand.safeParse(command("add-photo", { objectKey: "photo.jpg" }))), [{ path: "body.objectKey", message: OBJECT_KEY_SHAPE }])
    assert.deepEqual(refusal(DriverCommand.safeParse(command("record-unload", { ...bodies["record-unload"], objectKey: "ticket.png" }))), [{ path: "body.objectKey", message: OBJECT_KEY_SHAPE }])
    // The unload's weights.
    assert.deepEqual(refusal(DriverCommand.safeParse(command("record-unload", { unloadingStationId: THIRD, wasteFractionId: ID, netKg: 4_200, grossKg: 12_400 }))), [{ path: "body.tareKg", message: BOTH_GROSS_AND_TARE }])
    assert.deepEqual(refusal(DriverCommand.safeParse(command("record-unload", { unloadingStationId: THIRD, wasteFractionId: ID, netKg: 4_000, grossKg: 12_400, tareKg: 8_200 }))), [{ path: "body.netKg", message: NET_IS_GROSS_LESS_TARE }])
    assert.equal(DriverCommand.safeParse(command("record-unload", { unloadingStationId: THIRD, wasteFractionId: ID, netKg: 4_200 })).success, true, "net alone")
    assert.equal(DriverCommand.safeParse(command("add-weight", { pickupId: THIRD, weightKg: 0 })).success, false)
    assert.equal(DriverCommand.safeParse(command("arrive", { pickupId: THIRD, location: { type: "Point", coordinates: [12.5951, 55.7089, 10] } })).success, false, "a flat point")
  })
})

describe("the batch", () => {
  test("reads envelopes loosely, so a body that fails its kind is that command's rejection and not the batch's 400", () => {
    const loose = { ...envelope, kind: "skip-pickup", body: { pickupId: THIRD, reason: "lunch" } }
    assert.deepEqual(DriverCommandEnvelope.parse(loose), loose)
    assert.equal(DriverCommand.safeParse(loose).success, false)
    assert.deepEqual(refusal(COMMAND_BODIES["skip-pickup"].safeParse(loose.body)).map((issue) => issue.path), ["reason"], "the body against its kind, afterwards")
    assert.equal(DriverCommandEnvelope.safeParse({ ...loose, kind: "retry-sync" }).success, false, "the kind is still one of the fourteen")
    assert.match(refusal(DriverCommandEnvelope.safeParse({ ...loose, extra: 1 }))[0].message, /extra/)
  })

  test("carries one to two hundred envelopes, each id once", () => {
    assert.deepEqual(DriverCommandBatch.parse({ commands: [command("pause")] }), { commands: [command("pause")] })
    assert.deepEqual(refusal(DriverCommandBatch.safeParse({ commands: [] })).map((issue) => issue.path), ["commands"])
    assert.deepEqual(refusal(DriverCommandBatch.safeParse({ commands: [command("pause"), command("resume")] })), [{ path: "commands", message: EACH_COMMAND_ONCE }])
    const many = Array.from({ length: BATCH_MAX + 1 }, (_unused, index) => ({ ...command("pause"), id: `01a0d3a5-e5e0-7000-8000-${String(index).padStart(12, "0")}` }))
    assert.deepEqual(refusal(DriverCommandBatch.safeParse({ commands: many })).map((issue) => issue.path), ["commands"])
    assert.equal(DriverCommandBatch.safeParse({ commands: many.slice(1) }).success, true)
    assert.equal(BATCH_MAX, 200)
    assert.match(refusal(DriverCommandBatch.safeParse({ commands: [command("pause")], deviceId: "x" }))[0].message, /deviceId/, "the device is each envelope's")
  })
})

describe("what the door answers and stores", () => {
  const problem = { type: "about:blank", title: "Conflict", status: 409, detail: "Pickup 12 is already completed" }

  test("an outcome row is applied with its result, replayed with the first result, or rejected with its problem", () => {
    assert.deepEqual(WireOutcome.options, ["applied", "rejected", "replayed"])
    const session = { id: ID, projectId: OTHER, routeId: THIRD, driverId: ID, vehicleId: OTHER, trailerId: null, deviceId: "device-7", appVersion: null, startedAt: WHEN, endedAt: null, pausedAt: null, lastSeenAt: WHEN, ...STAMPS }
    const result = { resource: "session", value: session }
    assert.deepEqual(CommandOutcomeRow.parse({ commandId: ID, outcome: "applied", result }), { commandId: ID, outcome: "applied", result })
    assert.deepEqual(CommandOutcomeRow.parse({ commandId: ID, outcome: "replayed", problem }), { commandId: ID, outcome: "replayed", problem })
    // The result is tagged with what it is, so a session is never taken for a route or a stripped object of either.
    assert.deepEqual(refusal(CommandOutcomeRow.safeParse({ commandId: ID, outcome: "applied", result: session })).map((issue) => issue.path), ["result.resource"])
    const mistagged = refusal(CommandOutcomeRow.safeParse({ commandId: ID, outcome: "applied", result: { resource: "route", value: session } }))
    assert.ok(mistagged.length > 0)
    for (const issue of mistagged) assert.match(issue.path, /^result\.value/, "a session tagged as a route is held to the route's shape")
    assert.equal(CommandOutcomeRow.safeParse({ commandId: ID, outcome: "applied", result: { resource: "ticket", value: session } }).success, false)
    assert.deepEqual(CommandOutcomeRow.parse({ commandId: ID, outcome: "rejected", problem }), { commandId: ID, outcome: "rejected", problem })
    assert.deepEqual(CommandOutcomeRow.parse({ commandId: ID, outcome: "applied" }), { commandId: ID, outcome: "applied" }, "a pause makes no row")
    assert.equal(CommandOutcomeRow.safeParse({ commandId: ID, outcome: "pending" }).success, false)
  })

  test("a receipt is a ledger row keyed by the device's id, carrying the body verbatim and the problem exactly when rejected", () => {
    const receipt = { id: ID, recordedAt: WHEN, projectId: OTHER, routeId: THIRD, sessionId: ID, pickupId: THIRD, driverId: OTHER, deviceId: "device-7", kind: "complete-pickup", occurredAt: WHEN, body: bodies["complete-pickup"], outcome: "applied", problem: null }
    assert.deepEqual(DriverCommandReceipt.parse(receipt), receipt)
    const rejected = { ...receipt, outcome: "rejected", problem }
    assert.deepEqual(DriverCommandReceipt.parse(rejected), rejected)
    assert.deepEqual(refusal(DriverCommandReceipt.safeParse({ ...receipt, outcome: "rejected" })), [{ path: "problem", message: PROBLEM_WITH_A_REJECTION }])
    assert.deepEqual(refusal(DriverCommandReceipt.safeParse({ ...receipt, problem })), [{ path: "problem", message: PROBLEM_WITH_A_REJECTION }])
    assert.equal(DriverCommandReceipt.safeParse({ ...receipt, outcome: "replayed" }).success, false, "never stored")
    assert.equal(Object.keys(DriverCommandReceipt.shape).includes("updatedAt"), false)
    const shapeless = { ...rejected, body: { pickupId: THIRD, reason: "lunch" } }
    assert.deepEqual(DriverCommandReceipt.parse(shapeless), shapeless, "a body that failed its kind is kept as it came")
    // A rejection for a route the driver does not reach is recorded without one: no route, no session, no pickup, the claimed id kept beside the body.
    const routeless = { ...rejected, routeId: null, sessionId: null, pickupId: null, body: { routeId: THIRD, body: bodies["start-route"] } }
    assert.deepEqual(DriverCommandReceipt.parse(routeless), routeless, "the column is nullable and so is the contract")
    assert.deepEqual(refusal(DriverCommandReceipt.safeParse({ ...receipt, routeId: undefined })).map((issue) => issue.path), ["routeId"], "null is a value; absence is not")
  })

  test("the batch's answer is the outcomes, one per command and as many as the batch carried, and nothing else", () => {
    const row = { commandId: ID, outcome: "applied" }
    assert.deepEqual(DriverCommandBatchOutcome.parse({ outcomes: [row] }), { outcomes: [row] })
    assert.deepEqual(refusal(DriverCommandBatchOutcome.safeParse({ outcomes: [] })).map((issue) => issue.path), ["outcomes"], "a batch has at least one command")
    assert.equal(DriverCommandBatchOutcome.safeParse({ outcomes: Array.from({ length: BATCH_MAX }, () => row) }).success, true)
    assert.equal(DriverCommandBatchOutcome.safeParse({ outcomes: Array.from({ length: BATCH_MAX + 1 }, () => row) }).success, false, "no more outcomes than a batch can carry commands")
    assert.match(refusal(DriverCommandBatchOutcome.safeParse({ outcomes: [row], nextCursor: null }))[0].message, /nextCursor/, "not a page")
  })

  test("the driver's start screen is the profile, the open session, today's routes and what a start and an unload pick from", () => {
    const driver = { id: OTHER, projectId: OTHER, name: "Mads Jensen", workforceReference: null, employment: "employee", serviceProviderId: null, homeDepotId: null, licenceClass: "ce", licenceNumber: null, licenceExpiry: null, userAccountId: ID, status: "active", notes: null, ...STAMPS }
    const vehicles = [
      { id: ID, label: "WH-24", kind: "powered-vehicle", requiredLicenceClass: "c" },
      { id: THIRD, label: "CN 90 112", kind: "trailer", requiredLicenceClass: "b" },
    ]
    const unloadingStations = [
      { id: OTHER, name: "Nordkaj transfer station", location: POINT, weighbridge: true, wasteFractionIds: [ID, THIRD] },
      { id: THIRD, name: "Sydhavn drop-off", location: POINT, weighbridge: false, wasteFractionIds: [] },
    ]
    const wasteFractions = [{ id: ID, key: "residual", name: "Residual waste" }]
    const me = { driver, openSession: null, routes: [], vehicles, unloadingStations, wasteFractions }
    assert.deepEqual(DriverMe.parse(me), me)
    for (const key of ["routes", "vehicles", "unloadingStations", "wasteFractions"]) {
      assert.deepEqual(refusal(DriverMe.safeParse({ ...me, [key]: undefined })).map((issue) => issue.path), [key], `${key} is always there, empty or not`)
    }

    // A vehicle is named the way a person names it, one label, and carries what the start rule reads of it.
    for (const key of ["id", "label", "kind", "requiredLicenceClass"]) {
      const without: Record<string, unknown> = { ...vehicles[0] }
      delete without[key]
      assert.deepEqual(refusal(DriverMe.safeParse({ ...me, vehicles: [without] })).map((issue) => issue.path), [`vehicles.0.${key}`], key)
    }
    assert.deepEqual(refusal(DriverMe.safeParse({ ...me, vehicles: [{ ...vehicles[0], kind: "crane" }] })).map((issue) => issue.path), ["vehicles.0.kind"], "a vehicle is powered or a trailer")
    assert.deepEqual(refusal(DriverMe.safeParse({ ...me, vehicles: [{ ...vehicles[0], requiredLicenceClass: null }] })).map((issue) => issue.path), ["vehicles.0.requiredLicenceClass"], "a vehicle's class is never unknown")
    assert.deepEqual(refusal(DriverMe.safeParse({ ...me, vehicles: [{ ...vehicles[0], label: " " }] })).map((issue) => issue.path), ["vehicles.0.label"])

    // A station is where it is and says what it accepts, by id; accepting nothing is an empty list, not an absent one.
    for (const key of ["id", "name", "location", "weighbridge", "wasteFractionIds"]) {
      const without: Record<string, unknown> = { ...unloadingStations[0] }
      delete without[key]
      assert.deepEqual(refusal(DriverMe.safeParse({ ...me, unloadingStations: [without] })).map((issue) => issue.path), [`unloadingStations.0.${key}`], key)
    }
    assert.deepEqual(refusal(DriverMe.safeParse({ ...me, unloadingStations: [{ ...unloadingStations[0], wasteFractionIds: ["residual"] }] })).map((issue) => issue.path), ["unloadingStations.0.wasteFractionIds.0"], "a fraction by its id")
    assert.equal(DriverMe.safeParse({ ...me, unloadingStations: [{ ...unloadingStations[0], location: null }] }).success, false, "a station is always located")
    assert.equal(DriverMe.safeParse({ ...me, unloadingStations: [{ ...unloadingStations[0], location: { type: "Point", coordinates: [12.5951, 55.7089, 10] } }] }).success, false, "a flat point")

    // A fraction is its id, the key the rest of the system quotes and the name a person reads.
    for (const key of ["id", "key", "name"]) {
      const without: Record<string, unknown> = { ...wasteFractions[0] }
      delete without[key]
      assert.deepEqual(refusal(DriverMe.safeParse({ ...me, wasteFractions: [without] })).map((issue) => issue.path), [`wasteFractions.0.${key}`], key)
    }
    assert.deepEqual(refusal(DriverMe.safeParse({ ...me, wasteFractions: [{ ...wasteFractions[0], key: "Residual waste" }] })).map((issue) => issue.path), ["wasteFractions.0.key"], "the key is the catalogue's slug")
  })

  test("the driver's route read is the detail with each pickup's place joined: the address, the point or null, the container's label and the fraction's name", () => {
    const pickup = { id: THIRD, projectId: OTHER, routeId: ID, containerId: COMPANY, position: 1, status: "planned", reason: null, note: null, propertyId: ID, sharedCollectionPointId: null, wasteFractionId: OTHER, arrivedAt: null, outcomeAt: null, ...STAMPS }
    const joined = { ...pickup, address: "Parkvej 18, 2100 København Ø", location: POINT, containerLabel: "BIN-82014", wasteFractionName: "Residual waste" }
    assert.deepEqual(DriverPickup.parse(joined), joined)
    assert.deepEqual(DriverPickup.parse({ ...joined, location: null }), { ...joined, location: null }, "a property not yet geocoded has no point")
    for (const key of ["address", "location", "containerLabel", "wasteFractionName"]) {
      assert.deepEqual(refusal(DriverPickup.safeParse({ ...joined, [key]: undefined })).map((issue) => issue.path), [key], `${key} is what the device shows at the stop`)
    }
    assert.equal(DriverPickup.safeParse({ ...joined, location: { type: "Point", coordinates: [12.5951, 55.7089, 10] } }).success, false, "a flat point")
    assert.equal(DriverPickup.safeParse({ ...joined, address: "   " }).success, false, "an address says something")

    const route = {
      id: ID,
      projectId: OTHER,
      routeSchemeId: THIRD,
      collectionGroupId: ID,
      serviceDate: "2026-10-05",
      operatingDate: "2026-10-05",
      number: 1042,
      label: "RC-1042",
      status: "ready",
      note: null,
      cancelledByGeneration: false,
      generationRunId: null,
      plannedStartTime: "06:30",
      planned: { vehicleId: OTHER, driverId: THIRD, trailerId: null, serviceProviderId: null, depotId: ID, unloadingStationId: OTHER },
      actual: { vehicleId: null, driverId: null, trailerId: null },
      dispatchedAt: WHEN,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      progress: { planned: 1, completed: 0, skipped: 0, failed: 0, total: 1, fraction: 0 },
      ...STAMPS,
    }
    const detail = { ...route, pickups: [joined], session: null, sessions: [], unloads: [] }
    assert.deepEqual(DriverRouteDetail.parse(detail), detail)
    assert.deepEqual(refusal(DriverRouteDetail.safeParse({ ...detail, pickups: [pickup] })).map((issue) => issue.path).sort(), ["pickups.0.address", "pickups.0.containerLabel", "pickups.0.location", "pickups.0.wasteFractionName"], "a bare pickup is the office's shape, not the driver's")
    assert.deepEqual(refusal(DriverRouteDetail.safeParse({ ...detail, label: "RC-1043" })), [{ path: "label", message: LABEL_IS_THE_NUMBER }], "the route's own rule holds here too")
  })
})
