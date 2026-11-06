import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { awaitedRowsSentence, recordCountLabel } from "../table-copy"

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

describe("awaitedRowsSentence", () => {
  test("a module on the API says it is loading until its rows are here, and why its read failed", () => {
    assert.equal(awaitedRowsSentence({ status: "idle", problem: null }), "Loading records…")
    assert.equal(awaitedRowsSentence({ status: "loading", problem: null }), "Loading records…")
    assert.equal(
      awaitedRowsSentence({ status: "failed", problem: { type: "about:blank", title: "Service Unavailable", status: 503 } }),
      "The records could not be read (Service Unavailable). Reload the page to try again.",
    )
  })

  test("rows that are here, a module the role does not view and one on the browser's own path say nothing", () => {
    assert.equal(awaitedRowsSentence({ status: "ready", problem: null }), null)
    assert.equal(awaitedRowsSentence({ status: "not-granted", problem: null }), null)
    assert.equal(awaitedRowsSentence(null), null)
  })
})
