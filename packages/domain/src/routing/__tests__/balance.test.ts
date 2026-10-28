import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { routeShift } from "../../execution/shift"
import type { FitVehicle } from "../../resources/fleet-fit"
import { BALANCE_MOVES_MAX, balanceDay, canTake, type BalanceRoute, type BalanceStop } from "../balance"
import { UNLOAD_SECONDS } from "../reloads"

const GLASS = "glass"
const PAPER = "paper"
const ORIGIN: [number, number] = [12.57, 55.68]
/** A place `east` metres east and `north` metres north of the origin, roughly. */
const near = (east: number, north = 0): [number, number] => [ORIGIN[0] + east / (111_320 * Math.cos((ORIGIN[1] * Math.PI) / 180)), ORIGIN[1] + north / 111_320]

let next = 0
const stop = (overrides: Partial<BalanceStop> = {}): BalanceStop => {
  next += 1
  return { id: `stop-${String(next).padStart(3, "0")}`, position: next, status: "planned", containerId: `bin-${next}`, service: "empty", at: near(next * 10), kg: 50, serviceSeconds: 60, wasteFractionId: GLASS, containerTypeId: null, window: null, ...overrides }
}

const route = (id: string, stops: BalanceStop[], overrides: Partial<BalanceRoute> = {}): BalanceRoute => ({
  id,
  serviceProviderId: null,
  vehicle: null,
  capacityKg: 1_000,
  shift: null,
  plannedStartTime: "07:00",
  driveSeconds: 600,
  waitingSeconds: 0,
  unloads: 0,
  kg: stops.reduce((sum, one) => sum + one.kg, 0),
  stopSeconds: stops.reduce((sum, one) => sum + one.serviceSeconds, 0),
  stops,
  ...overrides,
})

/** A vehicle whose one compartment carries the fractions, of the capacity given and lifting the container types given (null: any). */
const carrying = (fractions: string[], { capacityKg = null, lifts = null }: { capacityKg?: number | null; lifts?: string[] | null } = {}): FitVehicle => ({ capacityKg: null, compartments: [{ capacityKg, wasteFractionIds: fractions }], liftsContainerTypeIds: lifts })

/** A route over its payload by one stop of 50 kg: three stops on a vehicle that carries 100. */
const overloaded = (overrides: Partial<BalanceRoute> = {}) => route("a-over", [stop(), stop(), stop()], { capacityKg: 100, ...overrides })
/** A light route near it that carries plenty. */
const light = (overrides: Partial<BalanceRoute> = {}) => route("b-light", [stop({ at: near(40) })], overrides)

describe("balancing a day across vehicles (O15 of #290)", () => {
  test("a day with no route over proposes nothing, and every route reads the same before and after", () => {
    const proposal = balanceDay([route("a", [stop()]), route("b", [stop()])])
    assert.deepEqual(proposal.moves, [])
    for (const day of proposal.routes) assert.deepEqual(day.before, day.after)
  })

  test("a route over its payload gives a stop to a route of the day that takes it and stays within its own, and is within its own after", () => {
    const over = overloaded()
    const proposal = balanceDay([over, light()])
    assert.equal(proposal.moves.length, 1)
    assert.deepEqual([proposal.moves[0].fromRouteId, proposal.moves[0].toRouteId], ["a-over", "b-light"])
    const [a, b] = proposal.routes
    assert.deepEqual([a.before.overCapacityKg, a.after.overCapacityKg, a.after.kg, b.after.kg], [50, 0, 100, 100])
  })

  test("a route over its driver's shift gives stops until it is within it, to a route whose shift has room", () => {
    const shift = { from: "07:00", to: "08:00", breakMinutes: null, breakWindow: null }
    // An hour's shift: 600 s of drive and six stops of ten minutes each run ten minutes over.
    const long = route("a-long", Array.from({ length: 6 }, () => stop({ serviceSeconds: 600 })), { shift, capacityKg: null })
    const roomy = route("b-roomy", [stop({ at: near(30) })], { shift: { ...shift, to: "15:00" }, capacityKg: null })
    const proposal = balanceDay([long, roomy])
    const [a] = proposal.routes
    assert.ok((a.before.overShiftSeconds ?? 0) > 0)
    assert.equal(a.after.overShiftSeconds, 0)
    assert.ok(proposal.moves.every((move) => move.toRouteId === "b-roomy"))
  })

  test("weighs a route as the route read does: its Plan's drive and waiting, the stop time, each unload visit on the way, and the break, against the shift", () => {
    const shift = { from: "07:00", to: "15:00", breakMinutes: 30, breakWindow: null }
    const day = route("a", [stop()], { shift, driveSeconds: 3_000, waitingSeconds: 120, unloads: 2 })
    const read = routeShift({ shift, plannedStartTime: "07:00", driveSeconds: 3_000, waitingSeconds: 120, stopSeconds: 60, unloads: 2 })
    const [weighed] = balanceDay([day]).routes
    assert.equal(weighed.before.workSeconds, read.workSeconds)
    assert.equal(weighed.before.workSeconds, 3_000 + 120 + 60 + 2 * UNLOAD_SECONDS + 1_800)
    assert.equal(weighed.before.overShiftSeconds, read.overShiftSeconds)
  })

  test("a receiving route it would put over its own payload is passed by, and a route with no move left stays as it is", () => {
    const full = route("b-full", [stop({ at: near(40), kg: 100 })], { capacityKg: 120 })
    const proposal = balanceDay([overloaded(), full])
    assert.deepEqual(proposal.moves, [])
    assert.equal(proposal.routes[0].after.overCapacityKg, 50)
  })

  test("goes to the route already nearest the stop", () => {
    const far = route("b-far", [stop({ at: near(5_000) })])
    const close = route("c-close", [stop({ at: near(50) })])
    assert.deepEqual(balanceDay([overloaded(), far, close]).moves.map((move) => move.toRouteId), ["c-close"])
  })

  test("proposes at most its cap of moves", () => {
    const many = Array.from({ length: BALANCE_MOVES_MAX + 10 }, () => stop({ kg: 10 }))
    const over = route("a-over", many, { capacityKg: 10 })
    const room = route("b-room", [stop({ at: near(20), kg: 0 })], { capacityKg: 100_000 })
    assert.equal(balanceDay([over, room]).moves.length, BALANCE_MOVES_MAX)
  })

  describe("a stop goes only where the office could put it by hand", () => {
    test("a route of the same service provider, or of the company's own when the stop's is", () => {
      assert.deepEqual(balanceDay([overloaded(), light({ serviceProviderId: "nordren" })]).moves, [])
      assert.equal(balanceDay([overloaded({ serviceProviderId: "nordren" }), light({ serviceProviderId: "nordren" })]).moves.length, 1)
    })

    test("a route whose vehicle carries the stop's fraction, or names none", () => {
      assert.deepEqual(balanceDay([overloaded(), light({ vehicle: carrying([PAPER]) })]).moves, [])
      assert.equal(balanceDay([overloaded(), light({ vehicle: carrying([PAPER, GLASS]) })]).moves.length, 1)
      assert.equal(balanceDay([overloaded(), light({ vehicle: carrying([]) })]).moves.length, 1)
      assert.equal(balanceDay([overloaded(), light({ vehicle: null })]).moves.length, 1)
    })

    test("a route whose vehicle lifts the stop's container and takes its weight on one trip, as a move judges it", () => {
      const binned = () => route("a-over", [stop({ containerTypeId: "bin-660" }), stop({ containerTypeId: "bin-660" }), stop({ containerTypeId: "bin-660" })], { capacityKg: 100 })
      assert.deepEqual(balanceDay([binned(), light({ vehicle: carrying([GLASS], { lifts: ["bin-240"] }) })]).moves, [])
      assert.equal(balanceDay([binned(), light({ vehicle: carrying([GLASS], { lifts: ["bin-240", "bin-660"] }) })]).moves.length, 1)
      assert.deepEqual(balanceDay([overloaded(), light({ vehicle: carrying([GLASS], { capacityKg: 40 }) })]).moves, [], "a compartment of 40 kg takes no stop of 50")
    })

    test("never an emptying onto a route that empties the container already", () => {
      const twin = stop({ containerId: "bin-shared" })
      const over = route("a-over", [stop({ containerId: "bin-shared" }), stop(), stop()], { capacityKg: 100 })
      // Only the shared bin's stop would fit; the receiver empties that bin already.
      const receiver = route("b-light", [twin], { capacityKg: 150 })
      assert.equal(canTake(receiver, over.stops[0], receiver.stops, "07:00"), false)
      assert.equal(canTake(receiver, over.stops[1], receiver.stops, "07:00"), true)
    })

    test("a route whose working day reaches the stop's window: not a stop due after its shift ends, nor one due before it starts", () => {
      const shift = { from: "07:00", to: "11:00", breakMinutes: null, breakWindow: null }
      const late = stop({ window: [13 * 3600, 15 * 3600] })
      const early = stop({ window: [5 * 3600, 6 * 3600] })
      const fits = stop({ window: [10 * 3600, 12 * 3600] })
      const receiver = light({ shift })
      assert.deepEqual([canTake(receiver, late, receiver.stops, "07:00"), canTake(receiver, early, receiver.stops, "07:00"), canTake(receiver, fits, receiver.stops, "07:00")], [false, false, true])
    })

    test("an open stop with a place: never one decided or one that cannot be located", () => {
      const receiver = light()
      assert.equal(canTake(receiver, stop({ status: "completed" }), receiver.stops, "07:00"), false)
      assert.equal(canTake(receiver, stop({ at: null }), receiver.stops, "07:00"), false)
    })
  })

  test("is the same for the same day", () => {
    const day = [overloaded(), light(), route("c", [stop({ at: near(45) })])]
    assert.deepEqual(balanceDay(day), balanceDay(day))
  })
})
