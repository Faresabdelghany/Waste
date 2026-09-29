// The relay's successor delay under the Pilot's polling knob (#149; #128
// Q3: the relay within 30 s in the Pilot): the five-second cadence where no
// knob is set, the knob where it is longer, and at once after a batch's
// worth whatever the knob. Pure; the tick itself is relay-outbox.test.ts's.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { BATCH_SIZE, RELAY_INTERVAL_SECONDS, successorDelaySeconds } from "../jobs/relay-outbox"

describe("successorDelaySeconds", () => {
  test("is the relay's own five seconds after a short sweep without the knob", () => {
    assert.equal(successorDelaySeconds({ swept: 0 }, undefined), RELAY_INTERVAL_SECONDS)
    assert.equal(successorDelaySeconds({ swept: BATCH_SIZE - 1 }, undefined), 5)
  })

  test("is raised to the polling knob where it is longer, and never lowered by it", () => {
    assert.equal(successorDelaySeconds({ swept: 0 }, 30), 30)
    assert.equal(successorDelaySeconds({ swept: 0 }, 1), 5)
  })

  test("is at once after a batch's worth, whatever the knob", () => {
    assert.equal(successorDelaySeconds({ swept: BATCH_SIZE }, undefined), 0)
    assert.equal(successorDelaySeconds({ swept: BATCH_SIZE + 40 }, 30), 0)
  })

  test("a tick that failed has no outcome and waits the interval", () => {
    assert.equal(successorDelaySeconds(undefined, undefined), 5)
    assert.equal(successorDelaySeconds(undefined, 30), 30)
  })
})
