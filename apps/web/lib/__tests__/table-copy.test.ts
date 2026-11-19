import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { KEPT_ON_API } from "../api/records/server-records"
import { awaitedRowsSentence, listCountLabel, pageRangeLabel, recordCountLabel } from "../table-copy"

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

  test("a switched module where no API is configured says the API keeps it", () => {
    assert.equal(awaitedRowsSentence(KEPT_ON_API), "This list is kept on the API: sign in on the Pilot to read it.")
  })

  test("rows that are here, a module the role does not view and one on the browser's own path say nothing", () => {
    assert.equal(awaitedRowsSentence({ status: "ready", problem: null }), null)
    assert.equal(awaitedRowsSentence({ status: "not-granted", problem: null }), null)
    assert.equal(awaitedRowsSentence(null), null)
  })
})

// #655: a list whose read has not answered has no count, and is not "No matching records".
describe("listCountLabel", () => {
  test("a list that has answered counts its rows", () => {
    assert.equal(listCountLabel(0, 0, true), "0 records")
    assert.equal(listCountLabel(3, 12, true), "3 of 12 records")
  })

  test("a list whose read has not answered says no count", () => {
    assert.equal(listCountLabel(0, 0, false), null)
  })
})

describe("pageRangeLabel", () => {
  test("rows shown read as their range, none as the empty label", () => {
    assert.equal(pageRangeLabel({ page: 2, pageSize: 25, totalCount: 30, emptyLabel: "No matching records", answered: true }), "Showing 26–30 of 30")
    assert.equal(pageRangeLabel({ page: 1, pageSize: 25, totalCount: 0, emptyLabel: "No matching records", answered: true }), "No matching records")
  })

  test("a list whose read has not answered says nothing beneath it", () => {
    assert.equal(pageRangeLabel({ page: 1, pageSize: 25, totalCount: 0, emptyLabel: "No matching records", answered: false }), null)
  })
})
