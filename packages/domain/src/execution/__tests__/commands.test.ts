// `decide` against every rule of #104 §3, over plain shapes and no database:
// the assignment, the two clock bounds and the session's start, the route's
// status, the session, the pickup, the body — each answering its sentence at
// its status — and the effects an applied command decides, kind by kind.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { licenceSentence } from "../../resources/licence"
import {
  alreadyOnRoute,
  BEFORE_THE_SESSION_STARTED,
  decide,
  NOT_A_FRACTION,
  NOT_A_POWERED_VEHICLE,
  NOT_A_STATION,
  NOT_A_TRAILER,
  noPickupOnRoute,
  noRouteAssigned,
  notInService,
  OBJECT_KEY_NAMES_ANOTHER,
  objectKeyNames,
  objectKeyOf,
  RECORDED_AFTER_IT_HAPPENED,
  recordedTooLate,
  ROUTE_CANCELLED_NOTHING_TO_END,
  type Clock,
  type Command,
  type CommandDriver,
  type Decision,
  type Lookups,
  type PickupState,
  type RouteState,
  type SessionState,
  type VehicleState,
} from "../commands"
import { alreadyDecided, notActive, notDispatched, routeCancellation } from "../transitions"
import { DRIVER_COMMAND_KINDS, type RouteStatus } from "../vocabulary"

const COMPANY = "018f7c31-a000-7000-8000-000000000001"
const ROUTE = "018f7c31-a000-7000-8000-000000000010"
const PICKUP = "018f7c31-a000-7000-8000-000000000020"
const OTHER_PICKUP = "018f7c31-a000-7000-8000-000000000021"
const COMMAND = "018f7c31-a000-7000-8000-000000000030"
const SESSION = "018f7c31-a000-7000-8000-000000000031"
const VEHICLE = "018f7c31-a000-7000-8000-000000000040"
const TRAILER = "018f7c31-a000-7000-8000-000000000041"
const STATION = "018f7c31-a000-7000-8000-000000000050"
const FRACTION = "018f7c31-a000-7000-8000-000000000051"
const DEVICE = "device-7"

const NOW = "2026-10-05T08:00:00.000Z"
const EARLIER = "2026-10-05T07:30:00.000Z"
const clock: Clock = { now: NOW, skewAheadMs: 5 * 60_000, backdateMs: 48 * 3_600_000 }
const shifted = (ms: number): string => new Date(Date.parse(NOW) + ms).toISOString()

const mads: CommandDriver = { id: "018f7c31-a000-7000-8000-000000000060", name: "Mads Jensen", licenceClass: "c", licenceExpiry: "2030-01-01" }
const route = (status: RouteStatus, driverId: string | null = mads.id): RouteState => ({
  id: ROUTE,
  label: "RC-1042",
  status,
  plannedDriverId: driverId,
  actualDriverId: status === "active" || status === "completed" ? driverId : null,
  operatingDate: "2026-10-05",
})
const session = (over: Partial<SessionState> = {}): SessionState => ({ id: SESSION, driverId: mads.id, startedAt: "2026-10-05T06:00:00.000Z", endedAt: null, pausedAt: null, ...over })
const pickup = (over: Partial<PickupState> = {}): PickupState => ({ id: PICKUP, position: 12, status: "planned", arrivedAt: null, ...over })
const truck: VehicleState = { id: VEHICLE, label: "WH-24", kind: "powered-vehicle", status: "active", requiredLicenceClass: "c" }
const trailer: VehicleState = { id: TRAILER, label: "WH-T3", kind: "trailer", status: "active", requiredLicenceClass: "ce" }

/** The rows an active route's driver sees, with the pickup planned. */
const running = (over: Partial<Lookups> = {}): Lookups => ({
  companyId: COMPANY,
  route: route("active"),
  session: session(),
  driverOpenOn: "RC-1042",
  pickup: pickup(),
  vehicle: undefined,
  trailer: undefined,
  stationKnown: true,
  fractionKnown: true,
  ...over,
})
/** The rows a ready route's driver sees before starting it. */
const readyToStart = (over: Partial<Lookups> = {}): Lookups => running({ route: route("ready"), session: undefined, driverOpenOn: undefined, pickup: undefined, vehicle: truck, trailer, ...over })

const command = <Kind extends Command["kind"]>(kind: Kind, body: Extract<Command, { kind: Kind }>["body"], occurredAt = EARLIER): Extract<Command, { kind: Kind }> =>
  ({ id: COMMAND, kind, routeId: ROUTE, occurredAt, deviceId: DEVICE, body }) as Extract<Command, { kind: Kind }>

const point = { type: "Point" as const, coordinates: [12.5951, 55.7089] as [number, number] }
const KEY = objectKeyOf({ companyId: COMPANY, routeId: ROUTE, commandId: COMMAND }, "jpg")

/** The rejection of a decision, or a failed assertion. */
const rejected = (decision: Decision) => {
  assert.ok("reject" in decision, `applied: ${JSON.stringify(decision)}`)
  return decision.reject
}
/** The effects of a decision, or a failed assertion. */
const applied = (decision: Decision) => {
  assert.ok("apply" in decision, `rejected: ${JSON.stringify(decision)}`)
  return decision.apply
}

describe("decide: the route is the driver's", () => {
  test("a route not assigned to the driver, or not there at all, is a 404 in the route's own words, whatever the command", () => {
    for (const kind of DRIVER_COMMAND_KINDS) {
      const sent = { id: COMMAND, kind, routeId: ROUTE, occurredAt: EARLIER, deviceId: DEVICE, body: {} } as Command
      assert.deepEqual(rejected(decide(sent, mads, running({ route: undefined }), clock)), { status: 404, detail: noRouteAssigned(ROUTE) }, kind)
      assert.deepEqual(rejected(decide(sent, mads, running({ route: route("active", "someone-else") }), clock)), { status: 404, detail: noRouteAssigned(ROUTE) }, kind)
    }
  })

  test("the actual driver reaches the route as well as the planned one", () => {
    const handedOver = running({ route: { ...route("active"), plannedDriverId: "someone-else", actualDriverId: mads.id } })
    assert.equal(applied(decide(command("pause", {}), mads, handedOver, clock)).length, 1)
  })
})

describe("decide: the clock", () => {
  test("occurredAt may run ahead of the request by the skew and no further: 400 at occurredAt", () => {
    assert.equal(applied(decide(command("pause", {}, shifted(clock.skewAheadMs)), mads, running(), clock)).length, 1, "at the edge")
    assert.deepEqual(rejected(decide(command("pause", {}, shifted(clock.skewAheadMs + 1_000)), mads, running(), clock)), {
      status: 400,
      detail: RECORDED_AFTER_IT_HAPPENED,
      errors: [{ path: "occurredAt", message: RECORDED_AFTER_IT_HAPPENED }],
    })
  })

  test("and behind it by the backdate bound and no further: a queue older than two days is answered as rejections", () => {
    const twoDaysAgo = shifted(-clock.backdateMs)
    const inTime = running({ session: session({ startedAt: shifted(-clock.backdateMs - 1) }) })
    assert.equal(applied(decide(command("pause", {}, twoDaysAgo), mads, inTime, clock)).length, 1, "at the edge")
    assert.deepEqual(rejected(decide(command("pause", {}, shifted(-clock.backdateMs - 1_000)), mads, inTime, clock)), {
      status: 400,
      detail: "Recorded more than 48 hours after it happened",
      errors: [{ path: "occurredAt", message: recordedTooLate(clock.backdateMs) }],
    })
  })

  test("every command after start-route lies at or after the session started", () => {
    const state = running({ session: session({ startedAt: EARLIER }) })
    assert.equal(applied(decide(command("pause", {}, EARLIER), mads, state, clock)).length, 1, "at the start")
    assert.deepEqual(rejected(decide(command("pause", {}, "2026-10-05T07:29:59.000Z"), mads, state, clock)), {
      status: 400,
      detail: BEFORE_THE_SESSION_STARTED,
      errors: [{ path: "occurredAt", message: BEFORE_THE_SESSION_STARTED }],
    })
  })

  test("the clock is judged before the route's state, so a stale command on a completed route hears about its clock", () => {
    assert.equal(rejected(decide(command("pause", {}, shifted(60 * 60_000)), mads, running({ route: route("completed") }), clock)).errors?.[0].path, "occurredAt")
  })
})

describe("decide: start-route", () => {
  const start = (body: Partial<Command<"start-route">["body"]> = {}) => command("start-route", { vehicleId: VEHICLE, ...body })

  test("a ready route starts: the session opens with the command's id, the actual assignment is the body's, a route-started proof keeps where the device stood, and route-started is worth an event", () => {
    assert.deepEqual(applied(decide(start({ trailerId: TRAILER, appVersion: "1.4.0", location: point, accuracyM: 12 }), mads, readyToStart(), clock)), [
      { kind: "start-route", sessionId: COMMAND, vehicleId: VEHICLE, trailerId: TRAILER, appVersion: "1.4.0", at: EARLIER },
      { kind: "append-proof", proof: { id: COMMAND, kind: "route-started", pickupId: null, occurredAt: EARLIER, reason: null, note: null, weightKg: null, objectKey: null, location: point, locationAccuracyM: 12 } },
      { kind: "event", event: "route-started", aggregate: "route", aggregateId: ROUTE },
    ])
    const bare = applied(decide(start(), mads, readyToStart({ trailer: undefined }), clock))
    assert.deepEqual(bare[0], { kind: "start-route", sessionId: COMMAND, vehicleId: VEHICLE, trailerId: null, appVersion: null, at: EARLIER })
    assert.deepEqual((bare[1] as { proof: { location: unknown; kind: string } }).proof.location, null, "no place given is no place recorded, and the proof is still appended")
  })

  test("a planned route is not dispatched, an active one is already active, a completed or cancelled one does not change: 409", () => {
    assert.deepEqual(rejected(decide(start(), mads, readyToStart({ route: route("planned") }), clock)), { status: 409, detail: notDispatched("RC-1042") })
    assert.deepEqual(rejected(decide(start(), mads, readyToStart({ route: route("active") }), clock)), { status: 409, detail: "Route RC-1042 is already active" })
    assert.deepEqual(rejected(decide(start(), mads, readyToStart({ route: route("completed") }), clock)), { status: 409, detail: "Route RC-1042 is completed and does not change" })
    assert.deepEqual(rejected(decide(start(), mads, readyToStart({ route: route("cancelled") }), clock)), { status: 409, detail: "Route RC-1042 is cancelled and does not change" })
  })

  test("a driver on another route ends it first: 409", () => {
    assert.deepEqual(rejected(decide(start(), mads, readyToStart({ driverOpenOn: "RC-1039" }), clock)), { status: 409, detail: alreadyOnRoute("Mads Jensen", "RC-1039") })
    assert.equal(alreadyOnRoute("Mads Jensen", "RC-1039"), "Mads Jensen is already on route RC-1039; end it first")
  })

  test("the vehicle is a powered vehicle of the project and the trailer a trailer: 400 on the field", () => {
    const vehicleIssue = { status: 400, detail: NOT_A_POWERED_VEHICLE, errors: [{ path: "body.vehicleId", message: NOT_A_POWERED_VEHICLE }] }
    assert.deepEqual(rejected(decide(start(), mads, readyToStart({ vehicle: undefined }), clock)), vehicleIssue, "not of the project")
    assert.deepEqual(rejected(decide(start(), mads, readyToStart({ vehicle: trailer }), clock)), vehicleIssue, "a trailer named as the vehicle")
    assert.deepEqual(rejected(decide(start({ vehicleId: TRAILER }), mads, readyToStart(), clock)), vehicleIssue, "the lookup answered another id")
    const trailerIssue = { status: 400, detail: NOT_A_TRAILER, errors: [{ path: "body.trailerId", message: NOT_A_TRAILER }] }
    assert.deepEqual(rejected(decide(start({ trailerId: TRAILER }), mads, readyToStart({ trailer: undefined }), clock)), trailerIssue)
    assert.deepEqual(rejected(decide(start({ trailerId: TRAILER }), mads, readyToStart({ trailer: { ...truck, id: TRAILER } }), clock)), trailerIssue, "a powered vehicle named as the trailer")
  })

  test("the driver holds the class the vehicle requires on the operating date: 400 in the licence rule's words, before any 409 of the fleet", () => {
    const heavy: VehicleState = { ...truck, requiredLicenceClass: "ce", status: "retired" }
    const sentence = licenceSentence({ reason: "class-too-low", required: "ce" }, { driver: "Mads Jensen", vehicle: "WH-24" }, "the operating date")
    assert.equal(sentence, "Mads Jensen needs a CE licence for WH-24")
    assert.deepEqual(rejected(decide(start(), mads, readyToStart({ vehicle: heavy }), clock)), { status: 400, detail: sentence, errors: [{ path: "body.vehicleId", message: sentence }] })
    const expired = { ...mads, licenceExpiry: "2026-10-04" }
    assert.deepEqual(rejected(decide(start(), expired, readyToStart(), clock)).detail, "Mads Jensen's licence expires on 2026-10-04, before the operating date")
    assert.equal(rejected(decide(start(), { ...mads, licenceClass: null }, readyToStart(), clock)).detail, "Mads Jensen holds no licence class on record")
    assert.equal(applied(decide(start(), { ...mads, licenceExpiry: "2026-10-05" }, readyToStart(), clock)).length, 3, "the last day the licence holds is the operating date")
  })

  test("only an active vehicle or trailer goes out: retired, in the workshop or unavailable is the fleet's 409 naming the status, after every 400", () => {
    for (const status of ["retired", "maintenance", "unavailable"] as const) {
      assert.deepEqual(rejected(decide(start(), mads, readyToStart({ vehicle: { ...truck, status } }), clock)), { status: 409, detail: notInService("WH-24", status, "vehicle") }, status)
      assert.deepEqual(rejected(decide(start({ trailerId: TRAILER }), mads, readyToStart({ trailer: { ...trailer, status } }), clock)), { status: 409, detail: `WH-T3 is ${status}; a route needs a trailer in service` }, status)
    }
    assert.equal(notInService("WH-24", "maintenance", "vehicle"), "WH-24 is maintenance; a route needs a vehicle in service")
    // A trailer named but not hitched is not judged: the body did not name it.
    assert.equal(applied(decide(start(), mads, readyToStart({ trailer: { ...trailer, status: "retired" } }), clock)).length, 3)
  })
})

describe("decide: every later command", () => {
  test("the route is active and the open session is this driver's, or the route is not active: 409", () => {
    for (const status of ["planned", "ready", "completed", "cancelled"] as const) {
      assert.deepEqual(rejected(decide(command("pause", {}), mads, running({ route: route(status) }), clock)), { status: 409, detail: notActive("RC-1042") }, status)
    }
    assert.deepEqual(rejected(decide(command("pause", {}), mads, running({ session: undefined }), clock)), { status: 409, detail: notActive("RC-1042") }, "no open session")
    assert.deepEqual(rejected(decide(command("pause", {}), mads, running({ session: session({ endedAt: NOW }) }), clock)), { status: 409, detail: notActive("RC-1042") }, "the session ended")
    assert.deepEqual(rejected(decide(command("pause", {}), mads, running({ session: session({ driverId: "someone-else" }) }), clock)), { status: 409, detail: notActive("RC-1042") }, "someone else's session")
  })

  test("a record-unload after end-route is a route that is not active", () => {
    const ended = running({ route: route("completed"), session: session({ endedAt: NOW }) })
    assert.deepEqual(rejected(decide(command("record-unload", { unloadingStationId: STATION, wasteFractionId: FRACTION, netKg: 4200 }), mads, ended, clock)), { status: 409, detail: notActive("RC-1042") })
  })

  test("pause on a paused session and resume on a running one apply nothing; otherwise they move paused_at", () => {
    assert.deepEqual(applied(decide(command("pause", {}), mads, running(), clock)), [{ kind: "pause", at: EARLIER }])
    assert.deepEqual(applied(decide(command("pause", {}), mads, running({ session: session({ pausedAt: EARLIER }) }), clock)), [])
    assert.deepEqual(applied(decide(command("resume", {}), mads, running({ session: session({ pausedAt: EARLIER }) }), clock)), [{ kind: "resume" }])
    assert.deepEqual(applied(decide(command("resume", {}), mads, running(), clock)), [])
  })

  test("end-route appends a route-ended proof with the note and the place, closes the route, its session and its open pickups in one effect, and is worth route-completed; the applier emits one pickup-skipped per pickup it closed", () => {
    assert.deepEqual(applied(decide(command("end-route", { note: "Done for today", location: point, accuracyM: 6 }), mads, running(), clock)), [
      { kind: "append-proof", proof: { id: COMMAND, kind: "route-ended", pickupId: null, occurredAt: EARLIER, reason: null, note: "Done for today", weightKg: null, objectKey: null, location: point, locationAccuracyM: 6 } },
      { kind: "end-route", at: EARLIER },
      { kind: "event", event: "route-completed", aggregate: "route", aggregateId: ROUTE },
    ])
    assert.deepEqual((applied(decide(command("end-route", {}), mads, running(), clock))[0] as { proof: { note: null; location: null } }).proof.note, null)
  })

  test("end-route on a route the office cancelled meanwhile is applied as nothing, with the note for the log, so the driver is not locked out; a completed route still refuses", () => {
    // The office's cancel ended the session (routeCancellation); the device, offline, still sends its end of the day.
    const cancelled = running({ route: { ...route("cancelled"), actualDriverId: mads.id }, session: session({ endedAt: "2026-10-05T07:45:00.000Z" }) })
    const decision = decide(command("end-route", { note: "Done" }), mads, cancelled, clock)
    assert.deepEqual(decision, { apply: [], note: ROUTE_CANCELLED_NOTHING_TO_END })
    assert.equal(ROUTE_CANCELLED_NOTHING_TO_END, "The route was cancelled; nothing to end")
    assert.deepEqual(rejected(decide(command("end-route", {}), mads, running({ route: route("completed"), session: session({ endedAt: NOW }) }), clock)), { status: 409, detail: notActive("RC-1042") })
    // Every other command on the cancelled route is still refused as not active.
    assert.deepEqual(rejected(decide(command("pause", {}), mads, cancelled, clock)), { status: 409, detail: notActive("RC-1042") })
    // And with the session ended by the cancellation, the driver starts the next route.
    assert.equal(routeCancellation("active").endsSession, true)
    const next = readyToStart({ route: { ...route("ready"), id: OTHER_PICKUP, label: "RC-1043" }, driverOpenOn: undefined })
    assert.equal(applied(decide({ ...command("start-route", { vehicleId: VEHICLE }), routeId: OTHER_PICKUP }, mads, next, clock)).length, 3)
  })
})

describe("decide: the pickup", () => {
  test("a command naming a pickup that is not the route's is a 404 in the route's words, the optional pickup of a problem, a photo or a note included", () => {
    const missing = { status: 404, detail: noPickupOnRoute(OTHER_PICKUP, "RC-1042") }
    assert.deepEqual(rejected(decide(command("arrive", { pickupId: OTHER_PICKUP }), mads, running(), clock)), missing, "the lookup answered another pickup")
    assert.deepEqual(rejected(decide(command("complete-pickup", { pickupId: PICKUP }), mads, running({ pickup: undefined }), clock)), { status: 404, detail: noPickupOnRoute(PICKUP, "RC-1042") })
    assert.deepEqual(rejected(decide(command("report-problem", { pickupId: OTHER_PICKUP, reason: "safety", note: "Dog loose" }), mads, running(), clock)), missing)
    assert.deepEqual(rejected(decide(command("add-note", { pickupId: OTHER_PICKUP, note: "x" }), mads, running(), clock)), missing)
    assert.equal(noPickupOnRoute(PICKUP, "RC-1042"), `No pickup ${PICKUP} on route RC-1042`)
  })

  test("complete, skip and fail decide a planned pickup's outcome: the proof, the status with its reason, and the event", () => {
    assert.deepEqual(applied(decide(command("complete-pickup", { pickupId: PICKUP, note: "Two bins", location: point, accuracyM: 8 }), mads, running(), clock)), [
      { kind: "append-proof", proof: { id: COMMAND, kind: "completion", pickupId: PICKUP, occurredAt: EARLIER, reason: null, note: "Two bins", weightKg: null, objectKey: null, location: point, locationAccuracyM: 8 } },
      { kind: "pickup-outcome", pickupId: PICKUP, status: "completed", reason: null, at: EARLIER },
      { kind: "event", event: "pickup-completed", aggregate: "pickup", aggregateId: PICKUP },
    ])
    const skipped = applied(decide(command("skip-pickup", { pickupId: PICKUP, reason: "not-presented" }), mads, running(), clock))
    assert.deepEqual(skipped[1], { kind: "pickup-outcome", pickupId: PICKUP, status: "skipped", reason: "not-presented", at: EARLIER })
    assert.deepEqual(skipped[2], { kind: "event", event: "pickup-skipped", aggregate: "pickup", aggregateId: PICKUP })
    assert.equal((skipped[0] as { proof: { kind: string; reason: string } }).proof.kind, "skip")
    const failed = applied(decide(command("fail-pickup", { pickupId: PICKUP, reason: "contamination", note: "Paint in the bin" }), mads, running(), clock))
    assert.deepEqual(failed[1], { kind: "pickup-outcome", pickupId: PICKUP, status: "failed", reason: "contamination", at: EARLIER })
    assert.deepEqual(failed[2], { kind: "event", event: "pickup-failed", aggregate: "pickup", aggregateId: PICKUP })
    assert.equal((failed[0] as { proof: { kind: string } }).proof.kind, "failure")
  })

  test("a second outcome is a rejection Resolution sees, not a silent overwrite: the first stands, 409", () => {
    for (const status of ["completed", "skipped", "failed"] as const) {
      for (const [kind, body] of [
        ["complete-pickup", { pickupId: PICKUP }],
        ["skip-pickup", { pickupId: PICKUP, reason: "other" }],
        ["fail-pickup", { pickupId: PICKUP, reason: "other" }],
      ] as const) {
        const sent = { id: COMMAND, kind, routeId: ROUTE, occurredAt: EARLIER, deviceId: DEVICE, body } as Command
        assert.deepEqual(rejected(decide(sent, mads, running({ pickup: pickup({ status }) }), clock)), { status: 409, detail: alreadyDecided(12, status) }, `${kind} on ${status}`)
      }
    }
  })

  test("arrive appends its proof and sets arrived_at once; a second arrival appends and moves nothing, whatever the pickup's status", () => {
    assert.deepEqual(applied(decide(command("arrive", { pickupId: PICKUP, location: point, accuracyM: 12 }), mads, running(), clock)), [
      { kind: "append-proof", proof: { id: COMMAND, kind: "arrival", pickupId: PICKUP, occurredAt: EARLIER, reason: null, note: null, weightKg: null, objectKey: null, location: point, locationAccuracyM: 12 } },
      { kind: "arrive", pickupId: PICKUP, at: EARLIER },
    ])
    assert.equal(applied(decide(command("arrive", { pickupId: PICKUP }), mads, running({ pickup: pickup({ arrivedAt: "2026-10-05T07:00:00.000Z" }) }), clock)).length, 1)
    assert.equal(applied(decide(command("arrive", { pickupId: PICKUP }), mads, running({ pickup: pickup({ status: "completed", arrivedAt: EARLIER }) }), clock)).length, 1)
  })

  test("report-problem moves no status: a problem proof, and an event about the pickup, or about the route when none is named", () => {
    assert.deepEqual(applied(decide(command("report-problem", { pickupId: PICKUP, reason: "safety", note: "Dog loose" }), mads, running({ pickup: pickup({ status: "completed" }) }), clock)), [
      { kind: "append-proof", proof: { id: COMMAND, kind: "problem", pickupId: PICKUP, occurredAt: EARLIER, reason: "safety", note: "Dog loose", weightKg: null, objectKey: null, location: null, locationAccuracyM: null } },
      { kind: "event", event: "pickup-problem-reported", aggregate: "pickup", aggregateId: PICKUP },
    ])
    const onRoute = applied(decide(command("report-problem", { reason: "other", note: "Road closed" }), mads, running(), clock))
    assert.equal((onRoute[0] as { proof: { pickupId: string | null } }).proof.pickupId, null)
    assert.deepEqual(onRoute[1], { kind: "event", event: "pickup-problem-reported", aggregate: "route", aggregateId: ROUTE })
  })

  test("weight, signature and note are proofs and nothing else; a note or a photo may stand on the route", () => {
    assert.deepEqual(applied(decide(command("add-weight", { pickupId: PICKUP, weightKg: 148 }), mads, running(), clock)), [
      { kind: "append-proof", proof: { id: COMMAND, kind: "weight", pickupId: PICKUP, occurredAt: EARLIER, reason: null, note: null, weightKg: 148, objectKey: null, location: null, locationAccuracyM: null } },
    ])
    assert.deepEqual(applied(decide(command("add-signature", { pickupId: PICKUP, objectKey: KEY }), mads, running(), clock)), [
      { kind: "append-proof", proof: { id: COMMAND, kind: "signature", pickupId: PICKUP, occurredAt: EARLIER, reason: null, note: null, weightKg: null, objectKey: KEY, location: null, locationAccuracyM: null } },
    ])
    assert.deepEqual(applied(decide(command("add-note", { note: "Key under the mat" }), mads, running(), clock)), [
      { kind: "append-proof", proof: { id: COMMAND, kind: "note", pickupId: null, occurredAt: EARLIER, reason: null, note: "Key under the mat", weightKg: null, objectKey: null, location: null, locationAccuracyM: null } },
    ])
    assert.equal((applied(decide(command("add-photo", { objectKey: KEY }), mads, running(), clock))[0] as { proof: { pickupId: string | null } }).proof.pickupId, null)
  })
})

describe("decide: the body", () => {
  test("an object key is the command's own: its company, its route, its id, one of the four formats", () => {
    const ids = { companyId: COMPANY, routeId: ROUTE, commandId: COMMAND }
    assert.equal(KEY, `${COMPANY}/${ROUTE}/${COMMAND}.jpg`)
    for (const extension of ["jpg", "jpeg", "png", "webp"] as const) assert.equal(objectKeyNames(objectKeyOf(ids, extension), ids), true, extension)
    assert.equal(objectKeyNames(`${COMPANY}/${ROUTE}/${COMMAND}.gif`, ids), false, "not a format")
    assert.equal(objectKeyNames(`${COMPANY}/${ROUTE}/${COMMAND}.jpg.exe`, ids), false)
    assert.equal(objectKeyNames(`${COMPANY}/${ROUTE}/${OTHER_PICKUP}.jpg`, ids), false, "another command")
    assert.equal(objectKeyNames(`${COMPANY}/${PICKUP}/${COMMAND}.jpg`, ids), false, "another route")
    assert.equal(objectKeyNames(`${OTHER_PICKUP}/${ROUTE}/${COMMAND}.jpg`, ids), false, "another tenant")
    const issue = { status: 400, detail: OBJECT_KEY_NAMES_ANOTHER, errors: [{ path: "body.objectKey", message: OBJECT_KEY_NAMES_ANOTHER }] }
    assert.deepEqual(rejected(decide(command("add-photo", { objectKey: `${COMPANY}/${PICKUP}/${COMMAND}.jpg` }), mads, running(), clock)), issue)
    assert.deepEqual(rejected(decide(command("add-signature", { pickupId: PICKUP, objectKey: `${COMPANY}/${ROUTE}/${OTHER_PICKUP}.png` }), mads, running(), clock)), issue)
    assert.deepEqual(rejected(decide(command("record-unload", { unloadingStationId: STATION, wasteFractionId: FRACTION, netKg: 1, objectKey: "x.jpg" }), mads, running(), clock)), issue)
  })

  test("record-unload names the company's station and fraction, and appends the unload with the command's id, worth unload-recorded", () => {
    const body = { unloadingStationId: STATION, wasteFractionId: FRACTION, netKg: 4200, grossKg: 12_400, tareKg: 8_200, weighbridgeTicket: "WB-2026-3901", objectKey: KEY, note: "Second tip", location: point }
    assert.deepEqual(applied(decide(command("record-unload", body), mads, running(), clock)), [
      {
        kind: "append-unload",
        unload: { id: COMMAND, unloadingStationId: STATION, wasteFractionId: FRACTION, occurredAt: EARLIER, netKg: 4200, grossKg: 12_400, tareKg: 8_200, weighbridgeTicket: "WB-2026-3901", objectKey: KEY, note: "Second tip", location: point },
      },
      { kind: "event", event: "unload-recorded", aggregate: "unload", aggregateId: COMMAND },
    ])
    const bare = applied(decide(command("record-unload", { unloadingStationId: STATION, wasteFractionId: FRACTION, netKg: 4200 }), mads, running(), clock))
    assert.deepEqual((bare[0] as { unload: object }).unload, { id: COMMAND, unloadingStationId: STATION, wasteFractionId: FRACTION, occurredAt: EARLIER, netKg: 4200, grossKg: null, tareKg: null, weighbridgeTicket: null, objectKey: null, note: null, location: null })
    assert.deepEqual(rejected(decide(command("record-unload", body), mads, running({ stationKnown: false }), clock)), { status: 400, detail: NOT_A_STATION, errors: [{ path: "body.unloadingStationId", message: NOT_A_STATION }] })
    assert.deepEqual(rejected(decide(command("record-unload", body), mads, running({ fractionKnown: false }), clock)), { status: 400, detail: NOT_A_FRACTION, errors: [{ path: "body.wasteFractionId", message: NOT_A_FRACTION }] })
  })
})
