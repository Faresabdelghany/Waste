// Moving stops, splitting and merging routes (O23 of #290, #358): which ids
// a move may name, the order the stops go over in, the emptying a route has
// already, and — the reason a move is a stop taken off and the office's stop
// put on — that the next generation run leaves both sides as the move left
// them.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { pickupChanges, type ExistingPickup, type PlannedStop } from "../../planning/generation"
import { emptiedAlready, emptiedThereAlready, leavesNoStop, mergedInto, movedTo, movingInOrder, notOpenStopsOf, openStopsInOrder, strangersAmong, type MovingStop } from "../stop-moves"

const stop = (id: string, position: number, values: Partial<MovingStop> = {}): MovingStop => ({ id, position, status: "planned", containerId: `c-${id}`, service: "empty", ...values })

describe("the stops a move names", () => {
  const stops = [stop("a", 1), stop("b", 2), stop("c", 3, { status: "completed" }), stop("d", 4, { status: "skipped" })]

  test("are open stops of the route; any other id is a stranger, counted in the body's order", () => {
    assert.deepEqual(strangersAmong(["b", "x", "c", "a"], stops), ["x", "c"])
    assert.deepEqual(strangersAmong(["a", "b"], stops), [])
    assert.equal(notOpenStopsOf(2, "RC-1042"), "2 ids not an open stop of route RC-1042")
    assert.equal(notOpenStopsOf(1, "RC-1042"), "1 id not an open stop of route RC-1042")
  })

  test("go over in the order they stand on the route, whatever the body's, and a decided one never goes", () => {
    assert.deepEqual(
      movingInOrder(["b", "a", "c"], stops).map((moving) => moving.id),
      ["a", "b"],
    )
    assert.deepEqual(
      movingInOrder(["y", "x"], [stop("y", 2), stop("x", 2)]).map((moving) => moving.id),
      ["x", "y"],
      "one position twice: by id",
    )
  })

  test("a merge takes every open stop; a split may not take them all", () => {
    assert.deepEqual(
      openStopsInOrder(stops).map((moving) => moving.id),
      ["a", "b"],
    )
    assert.equal(leavesNoStop(["a", "b"], stops), true)
    assert.equal(leavesNoStop(["a"], stops), false)
    assert.equal(leavesNoStop([], [stop("a", 1, { status: "completed" })]), false, "a route with no open stop has none to leave")
  })
})

describe("an emptying onto a route", () => {
  test("is refused where that route empties the container already, by either origin's planned emptying", () => {
    const moving = stop("m", 1, { containerId: "bin" })
    assert.equal(emptiedAlready(moving, [stop("g", 1, { containerId: "bin" })]), true)
    assert.equal(emptiedAlready(moving, [stop("o", 1, { containerId: "bin", service: "empty" })]), true)
    assert.equal(emptiedThereAlready("BIN-7", "RC-1043"), "Route RC-1043 empties container BIN-7 already; take one of the two stops off instead")
  })

  test("is taken beside a stop of the container that is done, taken off or a work order, and a work order or an address-only stop is never refused here", () => {
    const moving = stop("m", 1, { containerId: "bin" })
    assert.equal(emptiedAlready(moving, [stop("g", 1, { containerId: "bin", status: "skipped" }), stop("w", 2, { containerId: "bin", service: "wash" })]), false)
    assert.equal(emptiedAlready(stop("m", 1, { containerId: "bin", service: "repair" }), [stop("g", 1, { containerId: "bin" })]), false)
    assert.equal(emptiedAlready(stop("m", 1, { containerId: null }), [stop("g", 1, { containerId: null })]), false)
  })
})

describe("a moved stop and the next generation run", () => {
  const at = { propertyId: "p", sharedCollectionPointId: null, wasteFractionId: "f" }
  const existing = (id: string, containerId: string, position: number, values: Partial<ExistingPickup> = {}): ExistingPickup => ({ id, containerId, position, origin: "generation", service: "empty", status: "planned", reason: null, ...at, ...values })
  const planned = (containerId: string, position: number): PlannedStop => ({ containerId, position, ...at })

  test("the route it left keeps it taken off: the plan still holds the container there, and the run brings nothing back", () => {
    const source = [existing("s1", "bin1", 1), existing("s2", "bin2", 2, { status: "skipped", reason: "removed-by-dispatcher" })]
    const changes = pickupChanges(source, [planned("bin1", 1), planned("bin2", 2)])
    assert.deepEqual([changes.insert, changes.update, changes.skip, changes.unchanged], [[], [], [], 2])
  })

  test("the route it joined keeps it as the office's: never skipped where the plan does not hold it, and not planned a second time where it does", () => {
    const joined = [existing("t1", "bin9", 1), existing("t2", "bin2", 2, { origin: "office" })]
    assert.deepEqual(pickupChanges(joined, [planned("bin9", 1)]), { insert: [], update: [], skip: [], unchanged: 2 })
    assert.deepEqual(pickupChanges(joined, [planned("bin9", 1), planned("bin2", 2)]), { insert: [], update: [], skip: [], unchanged: 2 })
  })

  test("the notes say where it went, and why a merged route was cancelled", () => {
    assert.equal(movedTo("RC-1043"), "Moved to route RC-1043")
    assert.equal(mergedInto("RC-1042"), "Merged into route RC-1042")
  })
})
