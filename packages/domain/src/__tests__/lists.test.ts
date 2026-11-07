import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { without } from "../lists"

describe("without", () => {
  const PARENT = ["planned", "completed", "skipped", "failed"] as const

  test("keeps every value but the ones named out, in the parent's order", () => {
    assert.deepEqual(without(PARENT, "planned"), ["completed", "skipped", "failed"])
    assert.deepEqual(without(PARENT, "skipped", "planned"), ["completed", "failed"])
    assert.deepEqual(without(PARENT), [...PARENT], "none named out: the whole list, so a value the parent gains reaches it")
  })

  test("refuses a subset that keeps nothing", () => {
    assert.throws(() => without(["only"] as const, "only"))
  })
})
