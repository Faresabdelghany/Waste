import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { GenerationRequest, GenerationRun, GenerationRunListQuery } from "../generation"
import { WINDOW_AT_MOST_A_YEAR, WINDOW_ORDERED } from "../route-schemes"
import { refusal } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const SCHEME = "01a0d3a5-e5e0-7000-8000-000000000002"
const PROJECT = "01a0d3a5-e5e0-7000-8000-000000000003"
const STAMP = "2026-09-29T08:00:00.000Z"

/** A run as the office's button leaves it: queued, nothing done yet. */
const queued = {
  id: ID,
  createdAt: STAMP,
  updatedAt: STAMP,
  projectId: PROJECT,
  routeSchemeId: SCHEME,
  trigger: "on-demand",
  windowFrom: "2026-10-05",
  windowTo: "2026-10-11",
  status: "queued",
  startedAt: null,
  finishedAt: null,
  routesCreated: 0,
  routesRefreshed: 0,
  routesCancelled: 0,
  pickupsWritten: 0,
  holidaysSkipped: 0,
  unlocated: 0,
  warnings: [],
  error: null,
}

describe("GenerationRequest", () => {
  test("is the occurrence read's window: both ends inclusive, to on or after from, at most 366 days, in the same sentences", () => {
    assert.deepEqual(GenerationRequest.parse({ from: "2026-10-05", to: "2026-10-05" }), { from: "2026-10-05", to: "2026-10-05" }, "a window of one day")
    assert.deepEqual(GenerationRequest.parse({ from: "2026-01-01", to: "2027-01-01" }), { from: "2026-01-01", to: "2027-01-01" }, "366 days, the job's walk cap")
    assert.deepEqual(refusal(GenerationRequest.safeParse({ from: "2026-01-01", to: "2027-01-02" })), [{ path: "to", message: WINDOW_AT_MOST_A_YEAR }], "367 days")
    assert.deepEqual(refusal(GenerationRequest.safeParse({ from: "2026-10-11", to: "2026-10-05" })), [{ path: "to", message: WINDOW_ORDERED }])
    assert.deepEqual(refusal(GenerationRequest.safeParse({ from: "2026-10-05" })).map((issue) => issue.path), ["to"])
    assert.ok(refusal(GenerationRequest.safeParse({ from: "5 October", to: "2026-10-11" })).some((issue) => issue.path === "from"), "a day that is not YYYY-MM-DD is refused at its field")
  })

  test("is a write body: what the server decides — the trigger, the status, the scheme — is refused by name", () => {
    for (const member of ["trigger", "status", "routeSchemeId"]) {
      const issues = refusal(GenerationRequest.safeParse({ from: "2026-10-05", to: "2026-10-11", [member]: "x" }))
      assert.deepEqual(issues.map((issue) => issue.path), [""], member)
      assert.match(issues[0].message, new RegExp(member), member)
    }
  })
})

describe("GenerationRun", () => {
  test("carries the run as the job leaves it at each step: queued with nothing done, then running, then its counts and warnings, or its error", () => {
    assert.deepEqual(GenerationRun.parse(queued), queued)
    const running = { ...queued, status: "running", startedAt: "2026-09-29T08:00:05.000Z" }
    assert.deepEqual(GenerationRun.parse(running), running)
    const succeeded = {
      ...running,
      status: "succeeded",
      finishedAt: "2026-09-29T08:00:07.000Z",
      routesCreated: 3,
      pickupsWritten: 12,
      holidaysSkipped: 1,
      unlocated: 2,
      warnings: ["No boundary of the planning area is in force on 2026-10-08"],
    }
    assert.deepEqual(GenerationRun.parse(succeeded), succeeded)
    const failed = { ...running, status: "failed", finishedAt: "2026-09-29T08:00:07.000Z", error: '{"name":"Error","message":"no route scheme"}' }
    assert.deepEqual(GenerationRun.parse(failed), failed)
  })

  test("holds the stored vocabulary and nothing else: `requested` is not a status and a count is never negative", () => {
    assert.equal(GenerationRun.safeParse({ ...queued, status: "requested" }).success, false)
    assert.equal(GenerationRun.safeParse({ ...queued, trigger: "manual" }).success, false)
    assert.equal(GenerationRun.safeParse({ ...queued, routesCreated: -1 }).success, false)
    assert.equal(GenerationRun.safeParse({ ...queued, pickupsWritten: 1.5 }).success, false)
    assert.equal(GenerationRun.safeParse({ ...queued, windowTo: undefined }).success, false)
  })
})

describe("GenerationRunListQuery", () => {
  test("is a page with the status filter, the vocabulary's four", () => {
    assert.deepEqual(GenerationRunListQuery.parse({}), { limit: 50 })
    assert.deepEqual(GenerationRunListQuery.parse({ status: "failed", limit: "10" }), { status: "failed", limit: 10 })
    assert.deepEqual(refusal(GenerationRunListQuery.safeParse({ status: "requested" })).map((issue) => issue.path), ["status"])
  })
})
