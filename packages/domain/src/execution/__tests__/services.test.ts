// Which of the office's emptyings is an extra one (O3 of #290): an office
// emptying of a container one of generation's emptyings on the route visits
// too — never one beside a stop the dispatcher took off or the plan dropped,
// never two of the office's alone, never a work order.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { empties, extraEmptyings, SERVICE_NOUNS, type ServiceStop } from "../services"

const stop = (id: string, containerId: string | null, values: Partial<ServiceStop> = {}): ServiceStop => ({ id, containerId, origin: "generation", service: "empty", status: "planned", reason: null, ...values })

describe("an extra emptying", () => {
  test("is an office emptying of a container generation's plan empties on the route too, whatever that stop now stands at once visited", () => {
    const stops = [stop("g1", "c1"), stop("g2", "c2", { status: "completed" }), stop("o1", "c1", { origin: "office" }), stop("o2", "c2", { origin: "office" })]
    assert.deepEqual([...extraEmptyings(stops)].sort(), ["o1", "o2"])
  })

  test("is not one beside a stop the dispatcher took off or the plan dropped: the office's is the collection then", () => {
    const stops = [
      stop("g1", "c1", { status: "skipped", reason: "removed-by-dispatcher" }),
      stop("g2", "c2", { status: "skipped", reason: "regeneration" }),
      stop("g3", "c3", { status: "skipped", reason: "not-presented" }),
      stop("o1", "c1", { origin: "office" }),
      stop("o2", "c2", { origin: "office" }),
      stop("o3", "c3", { origin: "office" }),
    ]
    assert.deepEqual([...extraEmptyings(stops)], ["o3"], "a driver's skip was a visit")
  })

  test("is never two of the office's alone, an address-only stop, or a work order", () => {
    const stops = [stop("o1", "c1", { origin: "office" }), stop("o2", "c1", { origin: "office" }), stop("o3", null, { origin: "office" }), stop("g4", "c4"), stop("o4", "c4", { origin: "office", service: "wash" })]
    assert.deepEqual([...extraEmptyings(stops)], [])
  })

  test("is never an emptying a move brought onto the route (O23 of #290), which is the collection it was moved as: an office emptying beside it is the extra", () => {
    const moved = stop("m1", "c1", { origin: "office", movedFromPickupId: "g9" })
    assert.deepEqual([...extraEmptyings([moved])], [])
    assert.deepEqual([...extraEmptyings([moved, stop("o1", "c1", { origin: "office" })])], ["o1"])
    assert.deepEqual([...extraEmptyings([moved, stop("o2", "c2", { origin: "office" })])], [], "another container's office emptying is its own collection")
  })

  test("reads a stop from before the service as an emptying", () => {
    const older = { ...stop("g1", "c1"), service: undefined }
    assert.equal(empties(older), true)
    assert.deepEqual([...extraEmptyings([older, stop("o1", "c1", { origin: "office" })])], ["o1"])
  })
})

describe("a service in a sentence", () => {
  test("is its noun: an emptying, a delivery, a removal, a swap, a repair, a wash", () => {
    assert.deepEqual(SERVICE_NOUNS, { empty: "emptying", deliver: "delivery", remove: "removal", swap: "swap", repair: "repair", wash: "wash", bulky: "bulky collection" })
  })
})
