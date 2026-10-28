// A stop's estimated arrival (O8 of #290) against the Plan's own arithmetic:
// the departure, the legs in driving order on a full trip and a stops-only
// one, the kerb time, the wait for a window that has not opened, an unload
// visit's fifteen minutes, a Plan cut into parts, and the route's progress —
// a stop decided, a stop arrived at, a late vehicle, a stop the system
// closed — over plain instants and no clock of its own.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { UNLOAD_SECONDS } from "../../routing/reloads"
import { legsOfTrip, routeEta, type EtaInput, type EtaStop } from "../eta"

const DAY = Date.parse("2026-12-01T00:00:00.000Z")
/** An instant of the operating day, `HH:MM`, UTC for the test's sake. */
const at = (time: string): number => DAY + (Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))) * 60_000
const MINUTE = 60

const stop = (n: number, over: Partial<Extract<EtaStop, { kind: "pickup" }>> = {}): EtaStop => ({
  kind: "pickup",
  pickupId: `p${n}`,
  status: "planned",
  reason: null,
  outcomeAt: null,
  arrivedAt: null,
  serviceSeconds: 2 * MINUTE,
  window: null,
  ...over,
})
const UNLOAD: EtaStop = { kind: "unload" }

/** A route planned to leave at 07:00 on a full trip of three stops, ten minutes between each, before it starts. */
const planned = (over: Partial<EtaInput> = {}): EtaInput => ({
  routeStatus: "ready",
  startedAt: null,
  plannedDeparture: at("07:00"),
  trip: "full",
  stops: [stop(1), stop(2), stop(3)],
  // depot → 1, 1 → 2, 2 → 3, 3 → station, station → depot
  legs: [10 * MINUTE, 10 * MINUTE, 10 * MINUTE, 20 * MINUTE, 15 * MINUTE],
  now: at("06:00"),
  ...over,
})
const etas = (input: EtaInput) => routeEta(input).stops.map((reading) => (reading.eta === null ? null : new Date(reading.eta).toISOString().slice(11, 16)))
const finish = (input: EtaInput) => {
  const { finishAt } = routeEta(input)
  return finishAt === null ? null : new Date(finishAt).toISOString().slice(11, 16)
}

describe("legsOfTrip", () => {
  test("a full trip drives into every stop and two legs home, a stops-only trip between its stops", () => {
    assert.equal(legsOfTrip("full", 3), 5)
    assert.equal(legsOfTrip("stops-only", 3), 2)
    assert.equal(legsOfTrip("full", 0), 0)
  })
})

describe("routeEta: the Plan's arithmetic", () => {
  test("from the departure, each leg, then each stop's kerb time; the trip ends back at the depot after the final tip's drive, which adds no unload time", () => {
    assert.deepEqual(etas(planned()), ["07:10", "07:22", "07:34"])
    assert.equal(finish(planned()), "08:11", "07:34 + 2 min at the stop + 20 to the station + 15 home")
  })

  test("a stops-only trip starts at its first stop and ends there with its last", () => {
    const input = planned({ trip: "stops-only", legs: [10 * MINUTE, 10 * MINUTE] })
    assert.deepEqual(etas(input), ["07:00", "07:12", "07:24"])
    assert.equal(finish(input), "07:26")
  })

  test("a vehicle early for a window waits for it to open, as the optimiser's does; a window met, or one that cannot be, waits for nothing", () => {
    const input = planned({ stops: [stop(1), stop(2, { window: [at("08:00"), at("10:00")] }), stop(3, { window: "disjoint" })] })
    assert.deepEqual(etas(input), ["07:10", "07:22", "08:12"], "arrives at 2 at 07:22, served from 08:00 to 08:02, then 10 minutes")
    assert.deepEqual(etas(planned({ stops: [stop(1), stop(2, { window: [at("07:00"), at("10:00")] }), stop(3)] })), ["07:10", "07:22", "07:34"])
  })

  test("an unload visit on the way takes its fifteen minutes at the station", () => {
    assert.equal(UNLOAD_SECONDS, 15 * MINUTE)
    const input = planned({ stops: [stop(1), UNLOAD, stop(2)], legs: [10 * MINUTE, 20 * MINUTE, 20 * MINUTE, 20 * MINUTE, 15 * MINUTE] })
    assert.deepEqual(etas(input), ["07:10", "07:32", "08:07"], "07:12 + 20 to the station, 15 there, 20 to stop 2")
  })

  test("a Plan cut into parts is one chain of legs, read the same", () => {
    // Two parts of two stops each: the second part starts where the first ended, and only the last returns home.
    const input = planned({ stops: [stop(1), stop(2), stop(3), stop(4)], legs: [5 * MINUTE, 5 * MINUTE, 30 * MINUTE, 5 * MINUTE, 10 * MINUTE, 10 * MINUTE] })
    assert.deepEqual(etas(input), ["07:05", "07:12", "07:44", "07:51"])
  })

  test("a route not yet started leaves no earlier than now: a late start moves every estimate with it", () => {
    assert.deepEqual(etas(planned({ now: at("07:30") })), ["07:40", "07:52", "08:04"])
  })
})

describe("routeEta: the progress", () => {
  const started = (over: Partial<EtaInput> = {}) => planned({ routeStatus: "active", startedAt: at("07:05"), plannedDeparture: at("07:00"), now: at("07:05"), ...over })

  test("a running route starts its clock at its start, not its planned departure", () => {
    assert.deepEqual(etas(started()), ["07:15", "07:27", "07:39"])
  })

  test("a stop the driver decided is passed, and the clock stands at its outcome", () => {
    const input = started({ stops: [stop(1, { status: "completed", outcomeAt: at("07:30") }), stop(2), stop(3)], now: at("07:31") })
    assert.deepEqual(etas(input), [null, "07:40", "07:52"])
    const skipped = started({ stops: [stop(1, { status: "skipped", reason: "not-presented", outcomeAt: at("07:30") }), stop(2), stop(3)], now: at("07:31") })
    assert.deepEqual(etas(skipped), [null, "07:40", "07:52"], "a skip with the driver's reason is a visit")
  })

  test("a stop the vehicle is at is arrived, and it leaves no earlier than now", () => {
    const input = started({ stops: [stop(1, { arrivedAt: at("07:14") }), stop(2), stop(3)], now: at("07:20") })
    assert.deepEqual(etas(input), ["07:14", "07:30", "07:42"], "2 min from 07:14 is past: it leaves now, at 07:20")
  })

  test("a late vehicle's estimates slide forward with it: no stop still to come arrives before now", () => {
    const input = started({ stops: [stop(1, { status: "completed", outcomeAt: at("07:16") }), stop(2), stop(3)], now: at("08:00") })
    assert.deepEqual(etas(input), [null, "08:00", "08:12"])
  })

  test("a stop the system closed is never visited: no kerb time, and its outcome does not move the clock", () => {
    const removed = started({ stops: [stop(1), stop(2, { status: "skipped", reason: "removed-by-dispatcher", outcomeAt: at("09:00") }), stop(3)] })
    assert.deepEqual(etas(removed), ["07:15", null, "07:37"], "07:17 + the two legs through where 2 was, without its 2 minutes")
  })

  test("an unload visit before the last stop decided is behind the vehicle", () => {
    const input = started({
      stops: [stop(1, { status: "completed", outcomeAt: at("07:20") }), UNLOAD, stop(2, { status: "completed", outcomeAt: at("08:00") }), stop(3)],
      legs: [10 * MINUTE, 20 * MINUTE, 20 * MINUTE, 10 * MINUTE, 20 * MINUTE, 15 * MINUTE],
      now: at("08:01"),
    })
    assert.deepEqual(etas(input), [null, null, null, "08:10"])
  })
})

describe("routeEta: nothing to say", () => {
  test("for an ended route, a Plan not measured or measured over other stops, no departure, or no stops", () => {
    for (const routeStatus of ["completed", "cancelled"] as const) assert.deepEqual(etas(planned({ routeStatus })), [null, null, null], routeStatus)
    assert.deepEqual(etas(planned({ legs: null })), [null, null, null], "not measured")
    assert.deepEqual(etas(planned({ legs: [10 * MINUTE] })), [null, null, null], "legs that are not this trip's")
    assert.deepEqual(etas(planned({ plannedDeparture: null })), [null, null, null], "no departure")
    assert.equal(routeEta(planned({ stops: [], legs: [] })).finishAt, null)
  })
})
