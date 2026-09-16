import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../../data/business-modules"
import { coverageGaps, coverageInSelection, needsService } from "../coverage-gaps"

function record(id: string, extra: Partial<BusinessRecord> = {}): BusinessRecord {
  return {
    id,
    name: id,
    context: "",
    status: "Available",
    owner: "",
    value: "",
    updated: "",
    description: "",
    facts: {},
    related: [],
    source: "",
    freshness: "",
    ...extra,
  }
}

const container = (id: string, status: string, agreement: string | undefined, areaId: string) =>
  record(id, {
    status,
    facts: {
      "Container ID": id.toUpperCase(),
      "Waste fractions": "Residual",
      "Container type": "Two-wheel bin · 240 L",
      ...(agreement ? { Agreement: agreement } : {}),
    },
    submittedValues: { planningAreaId: areaId },
  })

const containers = [
  container("a", "Available", "AGR-1 · Active", "area-x"),
  container("b", "Available", undefined, "area-x"),
  container("c", "Available", "AGR-3 · Active", "area-y"),
  container("d", "Defect", "AGR-4 · Active", "area-x"),
  container("e", "Available", "AGR-5 · Ended", "area-x"),
]

const scheme = (id: string, status: string, values: Record<string, string | boolean>) =>
  record(id, {
    status,
    submittedValues: {
      frequency: "weekly",
      serviceDays: "monday",
      effectiveFrom: "2026-01-05",
      effectiveTo: "",
      sameAllDays: true,
      ...values,
    },
  })

const schemes = [
  // Rule-based, generating: every Residual container in area-x.
  scheme("s-rule", "Scheduled", { planningAreaId: "area-x", stopSelection: "rule", matchFractions: "Residual", lastGeneratedAt: "2026-06-01T05:00:00.000Z" }),
  // A draft says nothing about coverage yet.
  scheme("s-draft", "Draft", { planningAreaId: "area-y", stopSelection: "rule", matchFractions: "Residual" }),
  // Manual, validated: picks a container that cannot be served.
  scheme("s-manual", "Validated", { containerIds: "d" }),
  // Expired: no longer covers anything.
  scheme("s-expired", "Scheduled", { planningAreaId: "area-y", stopSelection: "rule", matchFractions: "Residual", effectiveTo: "2026-01-31", lastGeneratedAt: "2026-01-05T05:00:00.000Z" }),
]

const sorted = (set: ReadonlySet<string>) => [...set].sort()

describe("needsService", () => {
  test("an Available container needs service unless its agreement says ended, paused, or future", () => {
    assert.equal(needsService(containers[0]), true)
    assert.equal(needsService(containers[1]), true, "no agreement fact is not a reason to skip it")
    assert.equal(needsService(containers[3]), false, "Defect is not Available")
    assert.equal(needsService(containers[4]), false, "Ended")
    assert.equal(needsService(container("f", "Available", "AGR-6 · Paused", "area-x")), false)
    assert.equal(needsService(container("g", "Available", "AGR-7 · Future", "area-x")), false)
  })
})

describe("coverageGaps", () => {
  const gaps = coverageGaps(containers, schemes, "2026-09-16")

  test("covered means listed by a validated, scheduled, or effective scheme; drafts and expired schemes do not count", () => {
    assert.deepEqual(sorted(gaps.needing), ["a", "b", "c"])
    assert.deepEqual(sorted(gaps.covered), ["a", "b"])
    assert.deepEqual(sorted(gaps.uncovered), ["c"])
    assert.equal(gaps.schemesConsidered, 2)
  })

  test("a scheme stop on a container that does not need service is unservable", () => {
    assert.deepEqual(sorted(gaps.unservable), ["d", "e"])
  })

  test("a selection is summed up from the sets", () => {
    assert.deepEqual(coverageInSelection(gaps, new Set(["a", "c", "e", "zz"])), {
      needing: 2,
      covered: 1,
      uncovered: 1,
      unservable: 1,
    })
  })
})
