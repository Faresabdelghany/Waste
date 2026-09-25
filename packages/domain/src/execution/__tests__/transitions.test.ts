import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  activeAnd,
  alreadyActive,
  alreadyDecided,
  closingReasonOf,
  doesNotChange,
  hasNotRun,
  nextPickup,
  notActive,
  notDispatched,
  nothingToCorrect,
  openPickupsClose,
  PICKUP_COMMANDS,
  PICKUP_OUTCOME_OF,
  pickupCorrection,
  pickupTransition,
  ROUTE_COMMANDS,
  routeTransition,
  type Transition,
} from "../transitions"
import { PICKUP_STATUSES, ROUTE_STATUSES, type PickupStatus, type RouteStatus } from "../vocabulary"

const LABEL = "RC-1042"

/** The route machine spelled out, status by status and command by command, so the function is pinned in words and not only in itself. */
const routeTable: Record<RouteStatus, Record<(typeof ROUTE_COMMANDS)[number], Transition<RouteStatus>>> = {
  planned: {
    dispatch: { kind: "move", to: "ready" },
    start: { kind: "refuse", sentence: "Route RC-1042 is not dispatched; a driver starts a ready route" },
    end: { kind: "refuse", sentence: "Route RC-1042 is not active" },
    cancel: { kind: "move", to: "cancelled" },
  },
  ready: {
    dispatch: { kind: "stay" },
    start: { kind: "move", to: "active" },
    end: { kind: "refuse", sentence: "Route RC-1042 is not active" },
    cancel: { kind: "move", to: "cancelled" },
  },
  active: {
    dispatch: { kind: "refuse", sentence: "Route RC-1042 is already active" },
    start: { kind: "refuse", sentence: "Route RC-1042 is already active" },
    end: { kind: "move", to: "completed" },
    cancel: { kind: "move", to: "cancelled" },
  },
  completed: {
    dispatch: { kind: "refuse", sentence: "Route RC-1042 is completed and does not change" },
    start: { kind: "refuse", sentence: "Route RC-1042 is completed and does not change" },
    end: { kind: "refuse", sentence: "Route RC-1042 is completed and does not change" },
    cancel: { kind: "refuse", sentence: "Route RC-1042 is completed and does not change" },
  },
  cancelled: {
    dispatch: { kind: "refuse", sentence: "Route RC-1042 is cancelled and does not change" },
    start: { kind: "refuse", sentence: "Route RC-1042 is cancelled and does not change" },
    end: { kind: "refuse", sentence: "Route RC-1042 is cancelled and does not change" },
    cancel: { kind: "stay" },
  },
}

describe("routeTransition", () => {
  test("every status under every command, as the table spells it: twenty pairs", () => {
    let pairs = 0
    for (const status of ROUTE_STATUSES) {
      for (const command of ROUTE_COMMANDS) {
        assert.deepEqual(routeTransition(status, command, LABEL), routeTable[status][command], `${status} under ${command}`)
        pairs += 1
      }
    }
    assert.equal(pairs, 20)
  })

  test("completed and cancelled are terminal: no command moves them, and only cancelling a cancelled route is nothing to do", () => {
    for (const command of ROUTE_COMMANDS) {
      assert.equal(routeTransition("completed", command, LABEL).kind, "refuse")
      assert.equal(routeTransition("cancelled", command, LABEL).kind, command === "cancel" ? "stay" : "refuse")
    }
  })

  test("the sentences name the route by its label", () => {
    assert.equal(doesNotChange("RC-7", "completed"), "Route RC-7 is completed and does not change")
    assert.equal(notDispatched("RC-7"), "Route RC-7 is not dispatched; a driver starts a ready route")
    assert.equal(alreadyActive("RC-7"), "Route RC-7 is already active")
    assert.equal(notActive("RC-7"), "Route RC-7 is not active")
    assert.equal(hasNotRun("RC-7"), "Route RC-7 has not run")
    assert.equal(activeAnd("RC-7", "its order is frozen"), "Route RC-7 is active; its order is frozen")
  })
})

describe("pickupTransition", () => {
  test("a planned pickup takes the command's outcome; a decided one keeps the one it has, and says so: twelve pairs", () => {
    let pairs = 0
    for (const status of PICKUP_STATUSES) {
      for (const command of PICKUP_COMMANDS) {
        const expected: Transition<PickupStatus> = status === "planned" ? { kind: "move", to: PICKUP_OUTCOME_OF[command] } : { kind: "refuse", sentence: `Pickup 12 is already ${status}` }
        assert.deepEqual(pickupTransition(status, command, 12), expected, `${status} under ${command}`)
        pairs += 1
      }
    }
    assert.equal(pairs, 12)
    assert.deepEqual(PICKUP_OUTCOME_OF, { complete: "completed", skip: "skipped", fail: "failed" })
  })

  test("a correction moves a decided pickup to any outcome, the same one included, and has nothing to correct on a planned one", () => {
    assert.deepEqual(pickupCorrection("completed", "failed", 12), { kind: "move", to: "failed" })
    assert.deepEqual(pickupCorrection("skipped", "completed", 12), { kind: "move", to: "completed" })
    assert.deepEqual(pickupCorrection("failed", "failed", 12), { kind: "move", to: "failed" }, "the reason alone may change")
    assert.deepEqual(pickupCorrection("planned", "completed", 12), { kind: "refuse", sentence: "Pickup 12 has no outcome to correct" })
    assert.equal(alreadyDecided(3, "skipped"), "Pickup 3 is already skipped")
    assert.equal(nothingToCorrect(3), "Pickup 3 has no outcome to correct")
  })
})

describe("openPickupsClose and nextPickup", () => {
  const pickups = [
    { id: "a", position: 3, status: "planned" as PickupStatus },
    { id: "b", position: 1, status: "completed" as PickupStatus },
    { id: "c", position: 2, status: "planned" as PickupStatus },
    { id: "d", position: 4, status: "failed" as PickupStatus },
  ]

  test("a route's end or cancellation closes the planned pickups, in the order given, as skipped with the reason saying which", () => {
    assert.deepEqual(openPickupsClose(pickups, "route-ended"), { pickups: [pickups[0], pickups[2]], outcome: { status: "skipped", reason: "route-ended" } })
    assert.deepEqual(openPickupsClose(pickups, "route-cancelled").outcome, { status: "skipped", reason: "route-cancelled" })
    assert.deepEqual(openPickupsClose([pickups[1], pickups[3]], "route-ended").pickups, [], "a decided pickup is left as it is")
    assert.equal(closingReasonOf("end"), "route-ended")
    assert.equal(closingReasonOf("cancel"), "route-cancelled")
  })

  test("the next pickup is the first planned one by position, whatever order the list is in, and none once every stop is decided", () => {
    assert.equal(nextPickup(pickups)?.id, "c")
    assert.equal(nextPickup([pickups[3], pickups[0], pickups[1]])?.id, "a")
    assert.equal(nextPickup([pickups[1], pickups[3]]), undefined)
    assert.equal(nextPickup([]), undefined)
  })
})
