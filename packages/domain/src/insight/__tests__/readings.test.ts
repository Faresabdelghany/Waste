// What a report's counts mean: where every pickup status and reason stands,
// where every weight review status leaves an unload's weight, and a rate of
// nothing that is null rather than zero.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { PICKUP_REASONS, PICKUP_STATUSES, type PickupReason, type PickupStatus } from "../../execution/vocabulary"
import { WEIGHT_REVIEW_STATUSES } from "../../finance/vocabulary"
import { ON_TIME_GRACE_MINUTES, pickupStanding, rate, unloadStanding, WITHDRAWN_REASONS } from "../readings"

describe("pickupStanding", () => {
  test("a completed stop is collected, a skipped or failed one missed, a planned one open", () => {
    assert.equal(pickupStanding("completed", null), "completed")
    assert.equal(pickupStanding("failed", "not-presented"), "missed")
    assert.equal(pickupStanding("skipped", "inaccessible"), "missed")
    assert.equal(pickupStanding("skipped", "route-ended"), "missed", "a stop closed by the driver ending the day was due and not collected")
    assert.equal(pickupStanding("skipped", "route-cancelled"), "missed", "and so was one on a route the dispatcher cancelled")
    assert.equal(pickupStanding("planned", null), "open")
  })

  test("a stop taken off by a regeneration or removed by the dispatcher is withdrawn from the work, not missed", () => {
    assert.deepEqual([...WITHDRAWN_REASONS], ["regeneration", "removed-by-dispatcher"])
    for (const reason of WITHDRAWN_REASONS) assert.equal(pickupStanding("skipped", reason), "withdrawn", reason)
  })

  test("every status and reason the vocabulary holds has a standing, and only the withdrawn two withdraw", () => {
    for (const status of PICKUP_STATUSES) {
      for (const reason of [null, ...PICKUP_REASONS] as (PickupReason | null)[]) {
        const standing = pickupStanding(status as PickupStatus, reason)
        assert.ok(["completed", "missed", "open", "withdrawn"].includes(standing), `${status} · ${reason}`)
        assert.equal(standing === "withdrawn", reason !== null && (WITHDRAWN_REASONS as readonly string[]).includes(reason), `${status} · ${reason}`)
      }
    }
  })
})

describe("unloadStanding", () => {
  test("approved and captured weights count apart, a rejected one is reported beside, a corrected one is superseded by its correction", () => {
    assert.deepEqual(
      WEIGHT_REVIEW_STATUSES.map((status) => [status, unloadStanding(status)]),
      [
        ["captured", "captured"],
        ["approved", "approved"],
        ["rejected", "rejected"],
        ["corrected", "superseded"],
      ],
    )
  })
})

describe("rate", () => {
  test("is the part over the whole, and null where the whole is nothing", () => {
    assert.equal(rate(3, 4), 0.75)
    assert.equal(rate(0, 4), 0)
    assert.equal(rate(0, 0), null, "a rate of nothing is not zero")
  })
})

describe("ON_TIME_GRACE_MINUTES", () => {
  test("is a quarter of an hour", () => {
    assert.equal(ON_TIME_GRACE_MINUTES, 15)
  })
})
