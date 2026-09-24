import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  checkCollectionGroups,
  withoutDuplicatedEngineIssues,
} from "../group-checks"
import type { CollectionGroup } from "../groups"
import { validateScheme } from "../validation"

const group = (partial: Partial<CollectionGroup> & Pick<CollectionGroup, "id" | "name" | "days">): CollectionGroup => ({
  fractions: ["Residual"],
  stopSource: "rule",
  containerIds: [],
  ...partial,
})

const seed: CollectionGroup[] = [
  group({ id: "g1", name: "Residual · small bins", days: ["monday", "wednesday"], vehicleId: "WH-24", driverId: "d1" }),
  group({ id: "g2", name: "Residual · large bins", days: ["tuesday", "thursday"], vehicleId: "WH-07", driverId: "d3" }),
  group({ id: "g3", name: "Organic", days: ["monday", "tuesday", "wednesday", "thursday"], vehicleId: "WH-07", driverId: "d2" }),
]

const weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday"] as const

describe("checkCollectionGroups", () => {
  test("names the uncovered day and the vehicle clash with the exact wording", () => {
    const issues = checkCollectionGroups({ groups: seed, serviceDays: weekdays })
    assert.deepEqual(
      issues.map((issue) => issue.text),
      [
        "Friday has no collection group",
        "Vehicle WH-07 is on Residual · large bins and Organic on Tuesday, Thursday",
      ],
    )
    assert.equal(issues[1].kind, "vehicle")
    assert.deepEqual(issues[1].groupIds, ["g2", "g3"])
    assert.equal(issues[1].resourceId, "WH-07")
    assert.deepEqual(issues[1].days, ["tuesday", "thursday"])
  })

  test("driver clashes resolve the driver's name", () => {
    const groups = [
      group({ id: "a", name: "A", days: ["monday"], vehicleId: "v1", driverId: "d1" }),
      group({ id: "b", name: "B", days: ["monday"], vehicleId: "v2", driverId: "d1" }),
    ]
    const issues = checkCollectionGroups({
      groups,
      serviceDays: ["monday"],
      driverNameOf: (id) => (id === "d1" ? "Mads Jensen" : undefined),
      vehicleLabelOf: () => undefined,
    })
    assert.deepEqual(issues.map((issue) => issue.text), ["Driver Mads Jensen is on A and B on Monday"])
  })

  test("a vehicle label resolver replaces the raw id", () => {
    const groups = [
      group({ id: "a", name: "A", days: ["monday"], vehicleId: "vehicle-wh07", driverId: "d1" }),
      group({ id: "b", name: "B", days: ["monday"], vehicleId: "vehicle-wh07", driverId: "d2" }),
    ]
    const issues = checkCollectionGroups({
      groups,
      serviceDays: ["monday"],
      vehicleLabelOf: () => "WH-07",
    })
    assert.equal(issues[0].text, "Vehicle WH-07 is on A and B on Monday")
  })

  test("days outside the scheme's service days never clash", () => {
    const groups = [
      group({ id: "a", name: "A", days: ["saturday"], vehicleId: "v1" }),
      group({ id: "b", name: "B", days: ["saturday"], vehicleId: "v1" }),
    ]
    assert.deepEqual(checkCollectionGroups({ groups, serviceDays: ["monday"] }).map((issue) => issue.text), [
      "Monday has no collection group",
    ])
  })

  test("a fully covered, clash-free scheme has no issues", () => {
    const groups = [group({ id: "a", name: "A", days: [...weekdays], vehicleId: "v1", driverId: "d1" })]
    assert.deepEqual(checkCollectionGroups({ groups, serviceDays: weekdays }), [])
  })

  test("a group whose container types fall outside the scheme's service type is named with the exact wording", () => {
    const groups = [
      group({
        id: "g",
        name: "Residual · medium bins",
        days: ["monday"],
        vehicleId: "v1",
        driverId: "d1",
        containerTypes: ["Four-wheel bin · 660 L"],
      }),
    ]
    const issues = checkCollectionGroups({
      groups,
      serviceDays: ["monday"],
      serviceType: "Kerbside collection",
    })
    assert.deepEqual(issues.map((issue) => [issue.kind, issue.text, issue.groupIds]), [
      [
        "service-type",
        "Residual · medium bins has container types outside Kerbside collection: 660 L",
        ["g"],
      ],
    ])
    // In scope, or no service type on the scheme: nothing to raise.
    assert.deepEqual(
      checkCollectionGroups({ groups, serviceDays: ["monday"], serviceType: "Container collection" }),
      [],
    )
    assert.deepEqual(checkCollectionGroups({ groups, serviceDays: ["monday"] }), [])
  })
})

describe("withoutDuplicatedEngineIssues", () => {
  test("drops the engine's wording of the three conditions and keeps the rest", () => {
    const result = validateScheme({
      serviceDays: ["monday", "tuesday", "friday"],
      effectiveFrom: "2026-09-14",
      effectiveTo: "",
      areaId: "area-indreby",
      groups: [
        {
          id: "a",
          name: "A",
          days: ["monday", "tuesday"],
          vehicleId: "v1",
          driverId: "d1",
          vehicleType: null,
          stopSource: "rule",
          fractions: ["Residual"],
          dayStops: [
            { day: "monday", count: 3, claimedByOthers: 0 },
            { day: "tuesday", count: 3, claimedByOthers: 0 },
          ],
        },
        {
          id: "b",
          name: "B",
          days: ["tuesday"],
          vehicleId: "v1",
          driverId: "d1",
          vehicleType: null,
          stopSource: "rule",
          fractions: ["Organic"],
          dayStops: [{ day: "tuesday", count: 0, claimedByOthers: 0 }],
        },
      ],
    })
    // Pins the engine wording the filter shadows.
    assert.ok(result.issues.some((issue) => issue.startsWith("No collection group covers ")))
    assert.ok(result.issues.some((issue) => issue.startsWith("Vehicle is planned on both ")))
    assert.ok(result.issues.some((issue) => issue.startsWith("Driver is planned on both ")))
    const kept = withoutDuplicatedEngineIssues(result.issues)
    assert.deepEqual(kept, ["No containers match the stop rule for B"])
  })

  test("the empty-groups wording is shadowed too", () => {
    assert.deepEqual(withoutDuplicatedEngineIssues(["Add a collection group", "Pick a vehicle"]), [
      "Pick a vehicle",
    ])
  })
})

describe("crane-emptied and tank containers have a service type (issue #42)", () => {
  const igloos = [
    group({
      id: "g",
      name: "Glass igloos",
      days: ["monday"],
      vehicleId: "v1",
      driverId: "d1",
      containerTypes: ["Igloo · 2,500 L", "Underground · 5,000 L"],
    }),
  ]
  const tanks = [
    group({
      id: "t",
      name: "Harbor tanks",
      days: ["monday"],
      vehicleId: "v2",
      driverId: "d2",
      containerTypes: ["Wastewater tank · 3,000 L"],
    }),
  ]

  test("an igloo group is in scope under Crane collection and named under the bin types", () => {
    assert.deepEqual(
      checkCollectionGroups({ groups: igloos, serviceDays: ["monday"], serviceType: "Crane collection" }),
      [],
    )
    assert.deepEqual(
      checkCollectionGroups({
        groups: igloos,
        serviceDays: ["monday"],
        serviceType: "Container collection",
      }).map((issue) => issue.text),
      ["Glass igloos has container types outside Container collection: Igloo, Underground"],
    )
    // Underground collection keeps its own, narrower scope.
    assert.deepEqual(
      checkCollectionGroups({
        groups: igloos,
        serviceDays: ["monday"],
        serviceType: "Underground collection",
      }).map((issue) => issue.text),
      ["Glass igloos has container types outside Underground collection: Igloo"],
    )
  })

  test("a wastewater tank group is in scope under Tank emptying only", () => {
    assert.deepEqual(
      checkCollectionGroups({ groups: tanks, serviceDays: ["monday"], serviceType: "Tank emptying" }),
      [],
    )
    assert.deepEqual(
      checkCollectionGroups({
        groups: tanks,
        serviceDays: ["monday"],
        serviceType: "Crane collection",
      }).map((issue) => issue.text),
      ["Harbor tanks has container types outside Crane collection: Wastewater tank"],
    )
  })
})
