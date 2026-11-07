import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { Refused } from "../refusal"
import { OFFERED_PRODUCT_STATUSES, SERVING_POINT_STATUSES, type ProductStatus, type SharedCollectionPointStatus } from "../registry/vocabulary"
import { PLANNABLE_VEHICLE_STATUSES, type VehicleStatus } from "../resources/vocabulary"
import { refuseUnless, takesReference } from "../status-gates"

describe("a status gates a new reference", () => {
  const served = (status: SharedCollectionPointStatus) => takesReference(status, SERVING_POINT_STATUSES)
  const plannable = (status: VehicleStatus) => takesReference(status, PLANNABLE_VEHICLE_STATUSES)
  const offered = (status: ProductStatus | undefined, sentence: string | ((status: "draft" | "inactive") => string)) => () => refuseUnless(status, OFFERED_PRODUCT_STATUSES, sentence)

  test("a row in a status the vocabulary names takes one; any other does not", () => {
    assert.equal(served("open"), true)
    assert.equal(served("restricted"), true)
    assert.equal(served("closed"), false)
    assert.equal(plannable("maintenance"), true, "a vehicle in the workshop is planned with")
    assert.equal(plannable("retired"), false)
  })

  test("refuseUnless passes a status that takes the reference, and nothing named", () => {
    assert.doesNotThrow(offered("active", "never said"))
    assert.doesNotThrow(offered(undefined, "never said"))
  })

  test("refuseUnless refuses any other status as a conflict, in the family's sentence, which may name the status", () => {
    assert.throws(
      offered("draft", "The product is not offered"),
      (error: unknown) => error instanceof Refused && error.refusal.reason === "conflict" && error.refusal.sentence === "The product is not offered",
    )
    assert.throws(
      offered("inactive", (status) => `The product is ${status}`),
      (error: unknown) => error instanceof Refused && error.refusal.sentence === "The product is inactive",
    )
  })
})
