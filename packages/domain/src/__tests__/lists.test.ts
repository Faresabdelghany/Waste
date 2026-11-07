import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { isOneOf, mapped, without } from "../lists"

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

describe("mapped", () => {
  test("turns each value of the parent, in the parent's order", () => {
    assert.deepEqual(
      mapped(["open", "completed"] as const, (value) => (value === "open" ? "opened" : value)),
      ["opened", "completed"],
    )
  })
})

describe("isOneOf", () => {
  test("is whether a value is among a list's, so a caller narrows to it", () => {
    const live = (status: "planned" | "completed" | "skipped") => isOneOf(status, ["planned", "completed"] as const)
    assert.equal(live("planned"), true)
    assert.equal(live("skipped"), false)
  })
})
