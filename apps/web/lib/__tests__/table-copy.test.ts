import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { recordCountLabel } from "../table-copy"

describe("recordCountLabel", () => {
  test("one record is singular", () => {
    assert.equal(recordCountLabel(1, 1), "1 record")
    assert.equal(recordCountLabel(1), "1 record")
  })

  test("none or several records are plural", () => {
    assert.equal(recordCountLabel(0, 0), "0 records")
    assert.equal(recordCountLabel(12, 12), "12 records")
    assert.equal(recordCountLabel(7), "7 records")
  })

  test("a narrowed count names the total, the noun agreeing with it", () => {
    assert.equal(recordCountLabel(1, 3), "1 of 3 records")
    assert.equal(recordCountLabel(0, 3), "0 of 3 records")
    assert.equal(recordCountLabel(0, 1), "0 of 1 record")
  })
})
