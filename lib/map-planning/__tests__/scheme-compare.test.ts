import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../../data/business-modules"
import { COMPARE_COLORS, clusterMembership, compareSchemes, schemeStopSets } from "../scheme-compare"

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

/** A container at typed coordinates so the geometry is exact. */
const container = (id: string, lng: number, lat: number, status = "Available") =>
  record(id, {
    status,
    facts: { "Container ID": id.toUpperCase(), "Waste fractions": "Residual", Agreement: "AGR-1 · Active" },
    submittedValues: { latitude: String(lat), longitude: String(lng) },
  })

// A square: a1 and a2 along the south side, b1 and ab on the north side.
const containers = [
  container("a1", 12.5, 55.6),
  container("a2", 12.6, 55.6),
  container("b1", 12.6, 55.7),
  container("ab", 12.5, 55.7),
  container("orphan", 12.55, 55.65),
  container("broken", 12.56, 55.66, "Defect"),
  container("outside", 12.7, 55.65),
]

const scheme = (id: string, name: string, status: string, values: Record<string, string | boolean>) =>
  record(id, {
    name,
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
  scheme("s-b", "RS-B", "Scheduled", { containerIds: "b1,ab", lastGeneratedAt: "2026-06-01T05:00:00.000Z" }),
  scheme("s-a", "RS-A", "Validated", { containerIds: "a1,a2,ab" }),
  scheme("s-draft", "RS-Draft", "Draft", { containerIds: "orphan" }),
  // No readable recurrence: cannot be compared.
  record("s-broken", { name: "RS-Broken", status: "Validated", submittedValues: { containerIds: "a1" } }),
]

const sorted = (set: ReadonlySet<string>) => [...set].sort()
const needing = new Set(["a1", "a2", "b1", "ab", "orphan", "outside"])

describe("schemeStopSets", () => {
  test("every comparable scheme with its derived status and resolved stops, by name", () => {
    const sets = schemeStopSets(schemes, containers, "2026-09-16")
    assert.deepEqual(
      sets.map((set) => [set.id, set.name, set.status, sorted(set.containerIds)]),
      [
        ["s-a", "RS-A", "Validated", ["a1", "a2", "ab"]],
        ["s-b", "RS-B", "Effective", ["ab", "b1"]],
        ["s-draft", "RS-Draft", "Draft", ["orphan"]],
      ],
    )
  })
})

describe("compareSchemes", () => {
  const [a, b] = schemeStopSets(schemes, containers, "2026-09-16")
  const comparison = compareSchemes(a, b, containers, needing)

  test("splits the stops into A only, B only, and both", () => {
    assert.deepEqual(sorted(comparison.aOnly), ["a1", "a2"])
    assert.deepEqual(sorted(comparison.bOnly), ["b1"])
    assert.deepEqual(sorted(comparison.both), ["ab"])
  })

  test("orphaned means needing service, inside the hull of both schemes' stops, and in neither", () => {
    assert.deepEqual(sorted(comparison.orphaned), ["orphan"], "the Defect container and the one outside the hull do not count")
    assert.equal(comparison.hull.length, 4)
  })

  test("membership answers per container and per cluster, mixed clusters counting as both", () => {
    assert.equal(comparison.membership.get("a1"), "a")
    assert.equal(comparison.membership.get("b1"), "b")
    assert.equal(comparison.membership.get("ab"), "both")
    assert.equal(comparison.membership.get("orphan"), undefined)
    assert.equal(clusterMembership(["a1", "a2"], comparison.membership), "a")
    assert.equal(clusterMembership(["a1", "b1"], comparison.membership), "both")
    assert.equal(clusterMembership(["orphan"], comparison.membership), null)
    assert.ok(COMPARE_COLORS.a !== COMPARE_COLORS.b && COMPARE_COLORS.both !== COMPARE_COLORS.a)
  })
})
