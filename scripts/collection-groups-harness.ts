// Headless checks for Collection groups inside a Route Scheme
// (docs/new-changes/SPEC.md area L, DECISIONS.md D33–D36): the group model,
// the implicit-group derivation every legacy storage shape resolves to, the
// values round trip, per-day stop resolution with the manual-beats-rule /
// first-rule-group-wins tie-breaks, coverage, and the route identity that
// keeps legacy (scheme, serviceDate) routes stable.
// Run: npx tsx scripts/collection-groups-harness.ts
import {
  collectionGroupContainerIds,
  collectionGroupCoverage,
  collectionGroupsOf,
  collectionGroupsToValues,
  hasExplicitCollectionGroups,
  issuesByGroup,
  parseCollectionGroups,
  resolveCollectionGroupPlans,
  schemeValidationGroups,
  sharedServiceProvider,
  unattributedIssues,
  uncoveredServiceDays,
  type CollectionGroup,
} from "../lib/route-schemes/groups"
import type { BusinessRecord } from "../lib/data/business-modules"
import {
  applySchemeGeneration,
  generatedRouteId,
  planSchemeGeneration,
} from "../lib/route-schemes/generation"
import type { ServiceDay } from "../lib/route-schemes/recurrence"
import {
  validateScheme,
  type SchemeGroupValidationInput,
  type SchemeValidationInput,
} from "../lib/route-schemes/validation"

let passed = 0
let failed = 0
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) passed += 1
  else failed += 1
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`,
  )
}

/* ---- implicit derivation: legacy rule scheme, one shared rule ---- */

const legacyRuleShared = {
  schemeName: "Central",
  serviceDays: "monday, wednesday",
  stopSelection: "rule",
  sameAllDays: true,
  matchFractions: "Residual, Glass",
  matchVehicleType: "Rear loader",
  matchRulesByDay: "{}",
  plannedVehicleId: "vehicle-wh24",
  plannedDriverId: "driver-mads",
  serviceProviderId: "service-provider-nordren",
}

const shared = collectionGroupsOf(legacyRuleShared)
check("legacy shared rule → one implicit group", shared.length, 1)
check(
  "legacy shared rule group shape",
  shared[0],
  {
    id: "default",
    name: "Central",
    days: ["monday", "wednesday"],
    fractions: ["Residual", "Glass"],
    vehicleId: "vehicle-wh24",
    driverId: "driver-mads",
    serviceProviderId: "service-provider-nordren",
    stopSource: "rule",
    ruleVehicleType: "Rear loader",
    containerIds: [],
    implicit: true,
  },
)
check("legacy values are not explicit", hasExplicitCollectionGroups(legacyRuleShared), false)

/* ---- implicit derivation: legacy rule scheme, per-day rules ---- */

const legacyRulePerDay = {
  serviceDays: "sunday, wednesday",
  stopSelection: "rule",
  sameAllDays: false,
  matchFractions: "",
  matchVehicleType: "",
  matchRulesByDay: JSON.stringify({
    wednesday: { fractions: ["Organic"] },
    sunday: { fractions: ["Glass"], vehicleType: "Glass crane" },
  }),
  plannedVehicleId: "vehicle-wh31",
}

const perDay = collectionGroupsOf(legacyRulePerDay)
check(
  "legacy per-day rules → one implicit group per day, canonical day order, day-labelled",
  perDay.map((group) => [group.id, group.name, group.days, group.fractions, group.ruleVehicleType]),
  [
    ["day-wednesday", "Wed", ["wednesday"], ["Organic"], undefined],
    ["day-sunday", "Sun", ["sunday"], ["Glass"], "Glass crane"],
  ],
)
check(
  "legacy per-day groups share the scheme's planned vehicle",
  perDay.map((group) => group.vehicleId),
  ["vehicle-wh31", "vehicle-wh31"],
)

/* ---- implicit derivation: legacy manual schemes ---- */

const legacyManualShared = {
  serviceDays: "tuesday, thursday",
  sameAllDays: true,
  containerIds: "asset-1,asset-2",
}
const manualShared = collectionGroupsOf(legacyManualShared)
check(
  "legacy manual shared (no stopSelection flag) → one manual implicit group",
  manualShared.map((group) => [group.stopSource, group.days, group.containerIds, group.fractions]),
  [["manual", ["tuesday", "thursday"], ["asset-1", "asset-2"], []]],
)

const legacyManualPerDay = {
  serviceDays: "tuesday, thursday",
  stopSelection: "manual",
  sameAllDays: false,
  containerIds: "",
  containersByDay: JSON.stringify({ tuesday: ["asset-1"], thursday: ["asset-3", "asset-4"] }),
}
check(
  "legacy manual per-day → one manual implicit group per day",
  collectionGroupsOf(legacyManualPerDay).map((group) => [group.id, group.containerIds]),
  [
    ["day-tuesday", ["asset-1"]],
    ["day-thursday", ["asset-3", "asset-4"]],
  ],
)

check(
  "service days can be supplied explicitly (draft state, not yet serialized)",
  collectionGroupsOf({ stopSelection: "rule", matchFractions: "Glass" }, { serviceDays: ["friday"] })[0]
    .days,
  ["friday"],
)

check(
  "no service days → the implicit group still exists with no days (FR-5a names the gap)",
  collectionGroupsOf({ stopSelection: "rule", matchFractions: "Glass" }).map((group) => group.days),
  [[]],
)

/* ---- explicit groups ---- */

const organic: CollectionGroup = {
  id: "group-1",
  name: "Organic run",
  days: ["wednesday"],
  fractions: ["Organic"],
  vehicleId: "vehicle-nr08",
  driverId: "driver-lars",
  serviceProviderId: "service-provider-nordren",
  vehicleName: "NR-08",
  driverName: "Lars Møller",
  serviceProviderName: "NordRen ApS",
  stopSource: "rule",
  ruleVehicleType: "Organic sealed",
  containerIds: [],
}
const glass: CollectionGroup = {
  id: "group-2",
  name: "Glass run",
  days: ["wednesday", "sunday"],
  fractions: ["Glass"],
  vehicleId: "vehicle-wh31",
  driverId: "driver-freja",
  stopSource: "manual",
  containerIds: ["asset-9", "asset-8"],
}

const explicitValues = collectionGroupsToValues([organic, glass], ["wednesday", "sunday"])
check("two groups serialize explicitly", hasExplicitCollectionGroups(explicitValues), true)
check(
  "explicit serialization clears the legacy single-assignment keys",
  [
    explicitValues.plannedVehicleId,
    explicitValues.plannedDriverId,
    explicitValues.serviceProviderId,
    explicitValues.matchFractions,
    explicitValues.matchVehicleType,
    explicitValues.matchRulesByDay,
    explicitValues.containerIds,
    explicitValues.containersByDay,
  ],
  ["", "", "", "", "", "", "", ""],
)
check(
  "explicit groups round-trip through values (implicit: false)",
  collectionGroupsOf(explicitValues),
  [
    { ...organic, implicit: false },
    { ...glass, implicit: false },
  ],
)
check(
  "explicit groups win over stale legacy keys",
  collectionGroupsOf({ ...legacyRuleShared, ...explicitValues }).map((group) => group.id),
  ["group-1", "group-2"],
)

/* ---- single group covering every service day stays in the legacy shape ---- */

const single: CollectionGroup = {
  id: "group-1",
  name: "Whatever",
  days: ["monday", "wednesday"],
  fractions: ["Residual"],
  vehicleId: "vehicle-wh24",
  driverId: "driver-mads",
  stopSource: "rule",
  ruleVehicleType: "Rear loader",
  containerIds: [],
}
const singleValues = collectionGroupsToValues([single], ["wednesday", "monday"])
check("one group covering all service days → legacy shape, no explicit key", singleValues.collectionGroups, "")
check(
  "legacy shape keys for a single rule group",
  [
    singleValues.stopSelection,
    singleValues.sameAllDays,
    singleValues.matchFractions,
    singleValues.matchVehicleType,
    singleValues.matchRulesByDay,
    singleValues.plannedVehicleId,
    singleValues.plannedDriverId,
    singleValues.serviceProviderId,
  ],
  ["rule", true, "Residual", "Rear loader", "{}", "vehicle-wh24", "driver-mads", ""],
)
const singleManualValues = collectionGroupsToValues(
  [{ ...single, stopSource: "manual", containerIds: ["asset-1", "asset-2"], ruleVehicleType: undefined }],
  ["monday", "wednesday"],
)
check(
  "legacy shape keys for a single manual group",
  [
    singleManualValues.stopSelection,
    singleManualValues.sameAllDays,
    singleManualValues.containerIds,
    singleManualValues.containersByDay,
    singleManualValues.matchFractions,
  ],
  ["manual", true, "asset-1,asset-2", "{}", ""],
)
check(
  "a single group NOT covering every service day stays explicit (coverage gap must survive the save)",
  hasExplicitCollectionGroups(collectionGroupsToValues([single], ["monday", "wednesday", "friday"])),
  true,
)

/* ---- lenient parsing ---- */

check("parse: empty / invalid JSON → no groups", [parseCollectionGroups(""), parseCollectionGroups("{nope")], [[], []])
check(
  "parse: drops entries without an id, unknown days, non-string fractions",
  parseCollectionGroups(
    JSON.stringify([
      { name: "no id", days: ["monday"] },
      {
        id: "g",
        name: "ok",
        days: ["monday", "someday"],
        fractions: ["Glass", 4],
        stopSource: "rule",
        containerIds: "not-a-list",
      },
    ]),
  ),
  [
    {
      id: "g",
      name: "ok",
      days: ["monday"],
      fractions: ["Glass"],
      stopSource: "rule",
      containerIds: [],
    },
  ],
)
check(
  "parse: unknown stopSource falls back to manual (never silently a rule)",
  parseCollectionGroups(JSON.stringify([{ id: "g", days: [], stopSource: "magic" }]))[0].stopSource,
  "manual",
)

/* ---- coverage ---- */

check(
  "coverage lists the groups per service day in canonical day order",
  collectionGroupCoverage(["sunday", "wednesday", "friday"], [organic, glass]),
  [
    { day: "wednesday", groupIds: ["group-1", "group-2"] },
    { day: "friday", groupIds: [] },
    { day: "sunday", groupIds: ["group-2"] },
  ],
)
check("uncovered days name the coverage gap", uncoveredServiceDays(["wednesday", "friday", "sunday"], [organic, glass]), ["friday"])
check("no gap when every day has a group", uncoveredServiceDays(["wednesday", "sunday"], [organic, glass]), [])

/* ---- per-day stop resolution with tie-breaks ---- */

const AREA = "area-x"
const container = (id: string, fraction: string, type = "Two-wheel bin · 240 L", status = "Available") => ({
  id,
  name: id.toUpperCase(),
  status,
  facts: { "Waste fractions": fraction, "Container type": type },
  submittedValues: { planningAreaId: AREA },
  projectIds: ["project-1"],
})
const containers = [
  container("c-org-1", "Organic"),
  container("c-org-2", "Organic"),
  container("c-res-1", "Residual"),
  container("c-glass-1", "Glass", "Igloo · 2,500 L"),
]
const ruleGroup = (id: string, days: ServiceDay[], fractions: string[], ruleVehicleType?: string): CollectionGroup => ({
  id,
  name: id,
  days,
  fractions,
  vehicleId: "v",
  stopSource: "rule",
  ...(ruleVehicleType ? { ruleVehicleType } : {}),
  containerIds: [],
})
const manualGroup = (id: string, days: ServiceDay[], containerIds: string[]): CollectionGroup => ({
  id,
  name: id,
  days,
  fractions: [],
  vehicleId: "v",
  stopSource: "manual",
  containerIds,
})

const resolve = (groups: CollectionGroup[], serviceDays: ServiceDay[] = ["wednesday"]) =>
  resolveCollectionGroupPlans({ groups, serviceDays, areaId: AREA, projectIds: ["project-1"], containers })

// Two rule groups whose fractions intersect on the same day: first group wins.
const twoRules = resolve([
  ruleGroup("A", ["wednesday"], ["Residual", "Organic"]),
  ruleGroup("B", ["wednesday"], ["Organic"]),
])
check(
  "rule vs rule: first group wins the shared containers",
  twoRules.plans.map((plan) => [plan.groupId, plan.containerIds]),
  [
    ["A", ["c-org-1", "c-org-2", "c-res-1"]],
    ["B", []],
  ],
)
check(
  "rule vs rule: the loser's exclusions name the winner",
  twoRules.plans[1].excluded,
  [
    { id: "c-org-1", name: "C-ORG-1", reason: "Collected by A on this day" },
    { id: "c-org-2", name: "C-ORG-2", reason: "Collected by A on this day" },
  ],
)
check(
  "rule vs rule: reported as an overlap for validation to warn about",
  twoRules.ruleOverlaps,
  [{ day: "wednesday", winnerGroupId: "A", loserGroupId: "B", containerIds: ["c-org-1", "c-org-2"] }],
)
check("rule vs rule: no manual duplicates", twoRules.manualDuplicates, [])

// A manual pick beats a rule even when the rule group comes first.
const manualBeatsRule = resolve([
  ruleGroup("A", ["wednesday"], ["Organic"]),
  manualGroup("M", ["wednesday"], ["c-org-2"]),
])
check(
  "manual beats rule regardless of order",
  manualBeatsRule.plans.map((plan) => [plan.groupId, plan.containerIds]),
  [
    ["A", ["c-org-1"]],
    ["M", ["c-org-2"]],
  ],
)
check(
  "rule group shows the manually claimed container as excluded with the reason",
  manualBeatsRule.plans[0].excluded,
  [{ id: "c-org-2", name: "C-ORG-2", reason: "Collected by M on this day" }],
)
check("manual-over-rule is not a rule overlap", manualBeatsRule.ruleOverlaps, [])

// Two manual groups picking the same container on one day: explicit collision.
const twoManual = resolve([
  manualGroup("M1", ["wednesday"], ["c-org-1", "c-res-1"]),
  manualGroup("M2", ["wednesday"], ["c-res-1"]),
])
check(
  "manual duplicate: first keeps it, second excludes it",
  twoManual.plans.map((plan) => [plan.groupId, plan.containerIds, plan.excluded.map((e) => e.reason)]),
  [
    ["M1", ["c-org-1", "c-res-1"], []],
    ["M2", [], ["Picked in M1 on this day"]],
  ],
)
check(
  "manual duplicate reported for validation to block",
  twoManual.manualDuplicates,
  [{ containerId: "c-res-1", day: "wednesday", groupIds: ["M1", "M2"] }],
)

// Different days never conflict.
const differentDays = resolve(
  [ruleGroup("A", ["wednesday"], ["Organic"]), ruleGroup("B", ["sunday"], ["Organic"])],
  ["wednesday", "sunday"],
)
check(
  "same containers on different days: both groups serve them, no overlap",
  [differentDays.plans.map((plan) => [plan.day, plan.groupId, plan.containerIds.length]), differentDays.ruleOverlaps],
  [
    [
      ["wednesday", "A", 2],
      ["sunday", "B", 2],
    ],
    [],
  ],
)

// Plans are emitted day-major, then in group order; a group is absent on days it does not run.
const ordering = resolve(
  [ruleGroup("B", ["sunday"], ["Glass"]), ruleGroup("A", ["wednesday", "sunday"], ["Organic"])],
  ["sunday", "wednesday"],
)
check(
  "plans are day-major then group order, only on applicable days",
  ordering.plans.map((plan) => `${plan.day}:${plan.groupId}`),
  ["wednesday:A", "sunday:B", "sunday:A"],
)

// Rule near-misses still carry their reasons; a vehicle-type rule excludes incompatible containers.
const nearMiss = resolve([ruleGroup("G", ["wednesday"], ["Glass", "Organic"], "Glass crane")])
check(
  "rule exclusions keep the matching seam's reasons",
  nearMiss.plans[0].excluded.map((e) => [e.id, e.reason]),
  [
    ["c-org-1", "Two-wheel bin · 240 L is not serviceable by a glass crane"],
    ["c-org-2", "Two-wheel bin · 240 L is not serviceable by a glass crane"],
  ],
)
check("linked container ids across every plan", collectionGroupContainerIds(twoRules), ["c-org-1", "c-org-2", "c-res-1"])
check("no area → rule groups match nothing (the missing-area issue names the gap)",
  resolveCollectionGroupPlans({ groups: [ruleGroup("A", ["wednesday"], ["Organic"])], serviceDays: ["wednesday"], areaId: undefined, containers }).plans[0].containerIds,
  [],
)

/* ---- validation: group-aware blocking checks and warnings ---- */

const vGroup = (
  overrides: Partial<SchemeGroupValidationInput> & Pick<SchemeGroupValidationInput, "id" | "name" | "days">,
): SchemeGroupValidationInput => ({
  vehicleId: "vehicle-1",
  driverId: "driver-1",
  stopSource: "rule",
  fractions: ["Residual"],
  dayStops: overrides.days.map((day) => ({ day, count: 3, claimedByOthers: 0 })),
  ...overrides,
})

const twoGroupInput: SchemeValidationInput = {
  serviceDays: ["wednesday", "sunday"],
  effectiveFrom: "2026-09-01",
  effectiveTo: "",
  areaId: "area-x",
  groups: [
    vGroup({ id: "g1", name: "Organic run", days: ["wednesday"], fractions: ["Organic"] }),
    vGroup({ id: "g2", name: "Glass run", days: ["wednesday", "sunday"], fractions: ["Glass"], vehicleId: "vehicle-2", driverId: "driver-2" }),
  ],
}
const singleGroupInput: SchemeValidationInput = {
  ...twoGroupInput,
  groups: [vGroup({ id: "default", name: "Central", days: ["wednesday", "sunday"] })],
}

check("two valid groups → Validated", validateScheme(twoGroupInput), { status: "Validated", issues: [], warnings: [] })
check("one valid group → Validated", validateScheme(singleGroupInput), { status: "Validated", issues: [], warnings: [] })

check(
  "no groups at all → blocking",
  validateScheme({ ...twoGroupInput, groups: [] }).issues,
  ["Add a collection group"],
)
check(
  "a service day no group covers → blocking, named",
  validateScheme({ ...twoGroupInput, serviceDays: ["wednesday", "friday", "sunday"] }).issues,
  ["No collection group covers Fri"],
)
check(
  "a group running on a non-service day → blocking, named",
  validateScheme({
    ...twoGroupInput,
    groups: [twoGroupInput.groups[0], vGroup({ id: "g2", name: "Glass run", days: ["wednesday", "sunday", "saturday"], vehicleId: "vehicle-2", driverId: "driver-2" })],
  }).issues,
  ["Glass run runs on Sat, which is not a service day"],
)

check(
  "vehicle missing on every group (single) → legacy wording",
  validateScheme({ ...singleGroupInput, groups: [{ ...singleGroupInput.groups[0], vehicleId: undefined }] }).issues,
  ["Pick a vehicle"],
)
check(
  "driver missing on one of several groups → names the group (Draft, not a Next gate)",
  validateScheme({ ...twoGroupInput, groups: [twoGroupInput.groups[0], { ...twoGroupInput.groups[1], driverId: undefined }] }),
  { status: "Draft", issues: ["Pick a driver for Glass run"], warnings: [] },
)

check(
  "same vehicle on two groups sharing a day → blocking; different days are fine",
  validateScheme({
    ...twoGroupInput,
    groups: [twoGroupInput.groups[0], { ...twoGroupInput.groups[1], vehicleId: "vehicle-1" }],
  }).issues,
  ["Vehicle is planned on both Organic run and Glass run on Wed"],
)
check(
  "same driver on two groups on different days only → no issue",
  validateScheme({
    ...twoGroupInput,
    groups: [
      twoGroupInput.groups[0],
      vGroup({ id: "g2", name: "Glass run", days: ["sunday"], fractions: ["Glass"], vehicleId: "vehicle-2", driverId: "driver-1" }),
    ],
  }).issues,
  [],
)

check(
  "manual group with no stops on a day → names the group when several",
  validateScheme({
    ...twoGroupInput,
    groups: [
      twoGroupInput.groups[0],
      vGroup({ id: "g2", name: "Glass run", days: ["wednesday", "sunday"], stopSource: "manual", fractions: [], vehicleId: "vehicle-2", driverId: "driver-2", dayStops: [{ day: "wednesday", count: 2, claimedByOthers: 0 }, { day: "sunday", count: 0, claimedByOthers: 0 }] }),
    ],
  }).issues,
  ["Pick containers for Glass run"],
)
check(
  "rule group matching nothing → names the group when several",
  validateScheme({
    ...twoGroupInput,
    groups: [{ ...twoGroupInput.groups[0], dayStops: [{ day: "wednesday", count: 0, claimedByOthers: 0 }] }, twoGroupInput.groups[1]],
  }).issues,
  ["No containers match the stop rule for Organic run"],
)
check(
  "rule group left with nothing because another group collects its matches → a WARNING, never a block (D35)",
  validateScheme({
    ...twoGroupInput,
    groups: [{ ...twoGroupInput.groups[0], dayStops: [{ day: "wednesday", count: 0, claimedByOthers: 4 }] }, twoGroupInput.groups[1]],
  }),
  {
    status: "Validated",
    issues: [],
    warnings: ["Nothing left for Organic run to collect — every container it matches is collected by another group on the same day"],
  },
)
check(
  "missing planning area with a rule group → legacy wording",
  validateScheme({ ...singleGroupInput, areaId: undefined }).issues,
  ["Pick a planning area — the stop rule matches containers inside it"],
)
check(
  "manual container picked in two groups on one day → blocking, named",
  validateScheme({
    ...twoGroupInput,
    manualDuplicates: [
      { containerId: "asset-9", containerName: "CT-9", day: "wednesday", groupIds: ["g1", "g2"] },
      { containerId: "asset-9", containerName: "CT-9", day: "sunday", groupIds: ["g1", "g2"] },
    ],
  }).issues,
  ["CT-9 is picked in both Organic run and Glass run on Wed, Sun"],
)
check(
  "rule overlap inside the scheme → warning, first group wins",
  validateScheme({
    ...twoGroupInput,
    ruleOverlaps: [
      { day: "wednesday", winnerGroupId: "g1", loserGroupId: "g2", containerIds: ["a", "b"] },
      { day: "sunday", winnerGroupId: "g1", loserGroupId: "g2", containerIds: ["a"] },
    ],
  }),
  {
    status: "Validated",
    issues: [],
    warnings: ["Glass run and Organic run both match 2 containers on Wed, Sun — Organic run collects them (first group wins)"],
  },
)
check(
  "vehicle type mismatch per group when assignments differ",
  validateScheme({
    ...twoGroupInput,
    groups: [
      { ...twoGroupInput.groups[0], vehicleType: "Rear loader", ruleVehicleType: "Organic sealed" },
      twoGroupInput.groups[1],
    ],
  }).warnings,
  ["Vehicle of Organic run is a rear loader but its stop rule requires a organic sealed"],
)
check(
  "vehicle type mismatch with one assignment → legacy wording",
  validateScheme({
    ...singleGroupInput,
    groups: [{ ...singleGroupInput.groups[0], vehicleType: "Rear loader", ruleVehicleType: "Glass crane" }],
  }).warnings,
  ["Default vehicle is a rear loader but the stop rule requires a glass crane"],
)
check(
  "cross-scheme: another scheme's group planning the same vehicle on a shared day → blocking, both labelled",
  validateScheme(twoGroupInput, [
    { schemeName: "RS-Other", groupName: "Paper run", serviceDays: ["sunday", "monday"], plannedVehicleId: "vehicle-2" },
  ]).issues,
  ['Vehicle of Glass run is already planned on "RS-Other · Paper run" (shares Sun)'],
)
check(
  "cross-scheme: single-assignment scheme keeps the legacy wording",
  validateScheme(singleGroupInput, [
    { schemeName: "RS-Other", serviceDays: ["sunday"], plannedDriverId: "driver-1" },
  ]).issues,
  ['Default driver is already the default on "RS-Other" (shares Sun)'],
)
check(
  "allocation conflict names the group when assignments differ",
  validateScheme(twoGroupInput, [], [
    { allocationName: "Alloc", status: "Confirmed", vehicleId: "vehicle-2", plannedStart: "2026-09-06T06:00", plannedEnd: "2026-09-06T14:00" },
  ]).issues,
  ['Vehicle of Glass run conflicts with confirmed Vehicle Planning allocation "Alloc" (2026-09-06)'],
)
check(
  "allocation on a day the group does not run → no conflict",
  validateScheme(twoGroupInput, [], [
    { allocationName: "Alloc", status: "Confirmed", vehicleId: "vehicle-1", plannedStart: "2026-09-06T06:00", plannedEnd: "2026-09-06T14:00" },
  ]).issues,
  [],
)
check(
  "cross-scheme rule overlap names the group when rules differ",
  validateScheme(twoGroupInput, [], [], [
    { schemeName: "RS-Other", areaId: "area-x", serviceDays: ["sunday"], fractions: ["glass"] },
  ]).warnings,
  ['Stop rule of Glass run overlaps "RS-Other" — Glass containers in the same planning area are already matched on Sun'],
)

/* ---- generation: one route per group per applicable day, stable legacy identity ---- */

const schemeRecord = (
  id: string,
  values: Record<string, string | boolean>,
  facts: Record<string, string> = {},
): BusinessRecord => ({
  id,
  name: `Scheme ${id}`,
  context: "",
  status: "Validated",
  owner: "",
  value: "",
  updated: "Now",
  description: "",
  facts: { Version: "v3", ...facts },
  related: [],
  source: "",
  freshness: "Now",
  allowedTransitions: [],
  submittedValues: {
    schemeName: `Scheme ${id}`,
    planningAreaId: AREA,
    frequency: "weekly",
    serviceDays: "wednesday, sunday",
    effectiveFrom: "2026-09-01",
    effectiveTo: "",
    plannedStartTime: "06:30",
    ...values,
  },
  projectIds: ["project-1"],
})
const containerRecords: BusinessRecord[] = containers.map((c) => ({
  ...c,
  context: "",
  owner: "",
  value: "",
  updated: "Now",
  description: "",
  related: [],
  source: "",
  freshness: "Now",
  projectIds: [...c.projectIds],
}))
// 2026-09-02 is a Wednesday, 2026-09-06 a Sunday.
const WINDOW = { from: "2026-09-01", to: "2026-09-07" }

const legacyScheme = schemeRecord(
  "legacy",
  { stopSelection: "rule", sameAllDays: true, matchFractions: "Organic", matchVehicleType: "", matchRulesByDay: "{}" },
  { Vehicle: "WH-24", Driver: "Mads Jensen" },
)
const legacyPlan = planSchemeGeneration({ scheme: legacyScheme, window: WINDOW, existingRoutes: [], containers: containerRecords })
check(
  "legacy scheme: one route per date with the legacy (scheme, serviceDate) identity — nothing moves",
  legacyPlan?.routes.map((route) => [route.action, route.routeId, route.groupId ?? null]),
  [
    ["create", "route-gen-legacy-2026-09-02", null],
    ["create", "route-gen-legacy-2026-09-06", null],
  ],
)
const legacyApplied = applySchemeGeneration({ plan: legacyPlan!, existingPickups: [], containers: containerRecords, actorName: "Harness" })
check(
  "legacy scheme: routes carry the scheme's vehicle/driver facts and no group",
  legacyApplied.routes.map((route) => [route.facts.Vehicle, route.facts.Driver, route.facts["Collection group"] ?? null, route.submittedValues?.collectionGroupId ?? null]),
  [
    ["WH-24", "Mads Jensen", null, null],
    ["WH-24", "Mads Jensen", null, null],
  ],
)

const groupedValues = collectionGroupsToValues(
  [
    { id: "g-organic", name: "Organic run", days: ["wednesday"], fractions: ["Organic"], vehicleId: "vehicle-nr08", driverId: "driver-lars", serviceProviderId: "service-provider-nordren", vehicleName: "NR-08", driverName: "Lars Møller", serviceProviderName: "NordRen ApS", stopSource: "rule", containerIds: [] },
    { id: "g-rest", name: "Residual run", days: ["wednesday", "sunday"], fractions: ["Residual"], vehicleId: "vehicle-wh24", driverId: "driver-mads", vehicleName: "WH-24", driverName: "Mads Jensen", stopSource: "rule", containerIds: [] },
  ],
  ["wednesday", "sunday"],
)
const groupedScheme = schemeRecord("grouped", groupedValues, { Vehicle: "Per collection group", Driver: "Per collection group" })
const groupedPlan = planSchemeGeneration({ scheme: groupedScheme, window: WINDOW, existingRoutes: [], containers: containerRecords })
check(
  "grouped scheme: one route per group per applicable day, identity carries the group id, sorted by date then group order",
  groupedPlan?.routes.map((route) => [route.action, route.routeId, route.groupName, route.containerIds]),
  [
    ["create", "route-gen-grouped-g-organic-2026-09-02", "Organic run", ["c-org-1", "c-org-2"]],
    ["create", "route-gen-grouped-g-rest-2026-09-02", "Residual run", ["c-res-1"]],
    ["create", "route-gen-grouped-g-rest-2026-09-06", "Residual run", ["c-res-1"]],
  ],
)
check(
  "grouped scheme: distinct RC names per group on the same date",
  new Set(groupedPlan?.routes.map((route) => route.routeName)).size,
  3,
)
const groupedApplied = applySchemeGeneration({ plan: groupedPlan!, existingPickups: [], containers: containerRecords, actorName: "Harness" })
check(
  "grouped scheme: each route carries its group's vehicle, driver, provider, and group facts",
  groupedApplied.routes.map((route) => [
    route.facts.Vehicle,
    route.facts.Driver,
    route.facts["Service provider"] ?? null,
    route.facts["Collection group"],
    route.submittedValues?.collectionGroupId,
    route.submittedValues?.appliedVehicle,
    route.serviceProviderId ?? null,
  ]),
  [
    ["NR-08", "Lars Møller", "NordRen ApS", "Organic run", "g-organic", "NR-08", "service-provider-nordren"],
    ["WH-24", "Mads Jensen", null, "Residual run", "g-rest", "WH-24", null],
    ["WH-24", "Mads Jensen", null, "Residual run", "g-rest", "WH-24", null],
  ],
)
check(
  "grouped scheme: pickups belong to their group's route and inherit its driver",
  groupedApplied.pickups.map((pickup) => [pickup.submittedValues?.routeId, pickup.owner]),
  [
    ["route-gen-grouped-g-organic-2026-09-02", "Lars Møller"],
    ["route-gen-grouped-g-organic-2026-09-02", "Lars Møller"],
    ["route-gen-grouped-g-rest-2026-09-02", "Mads Jensen"],
    ["route-gen-grouped-g-rest-2026-09-06", "Mads Jensen"],
  ],
)
const rerun = planSchemeGeneration({ scheme: groupedScheme, window: WINDOW, existingRoutes: groupedApplied.routes, containers: containerRecords })
check(
  "grouped scheme: re-running refreshes every group route in place — no duplicates",
  rerun?.routes.map((route) => [route.action, route.routeId]),
  [
    ["refresh", "route-gen-grouped-g-organic-2026-09-02"],
    ["refresh", "route-gen-grouped-g-rest-2026-09-02"],
    ["refresh", "route-gen-grouped-g-rest-2026-09-06"],
  ],
)

// Removing a group cancels its still-Planned future routes (generation-authored, resurrectable).
const shrunkScheme = schemeRecord(
  "grouped",
  collectionGroupsToValues(
    [
      { id: "g-rest", name: "Residual run", days: ["wednesday", "sunday"], fractions: ["Residual"], vehicleId: "vehicle-wh24", driverId: "driver-mads", stopSource: "rule", containerIds: [] },
      { id: "g-glass", name: "Glass run", days: ["sunday"], fractions: ["Glass"], vehicleId: "vehicle-wh31", driverId: "driver-freja", stopSource: "manual", containerIds: ["c-glass-1"] },
    ],
    ["wednesday", "sunday"],
  ),
)
const shrunkPlan = planSchemeGeneration({ scheme: shrunkScheme, window: WINDOW, existingRoutes: groupedApplied.routes, containers: containerRecords })
check(
  "removing a group cancels its Planned routes with a group note (after that date's planned rows); a new group creates; kept groups refresh",
  shrunkPlan?.routes.map((route) => [route.action, route.routeId, route.note ?? null]),
  [
    ["refresh", "route-gen-grouped-g-rest-2026-09-02", null],
    ["cancel", "route-gen-grouped-g-organic-2026-09-02", "Scheme no longer plans this collection group on this date"],
    ["refresh", "route-gen-grouped-g-rest-2026-09-06", null],
    ["create", "route-gen-grouped-g-glass-2026-09-06", null],
  ],
)
check(
  "cancelled group route carries the resurrection marker",
  applySchemeGeneration({ plan: shrunkPlan!, existingPickups: groupedApplied.pickups, containers: containerRecords, actorName: "Harness" })
    .routes.find((route) => route.id === "route-gen-grouped-g-organic-2026-09-02")?.submittedValues?.cancelledByGeneration,
  true,
)
check(
  "generatedRouteId: no group key keeps the legacy shape",
  [generatedRouteId("s", "2026-09-02"), generatedRouteId("s", "2026-09-02", "g1")],
  ["route-gen-s-2026-09-02", "route-gen-s-g1-2026-09-02"],
)

/* ---- explicit empty list, issue attribution, shared provider ---- */

const emptyValues = collectionGroupsToValues([], ["wednesday"])
check("zero groups store explicitly and resolve to zero groups (not the legacy shape)", [hasExplicitCollectionGroups(emptyValues), collectionGroupsOf(emptyValues, { serviceDays: ["wednesday"] })], [true, []])
check(
  "issues are attributed on word boundaries, crediting the most specific name",
  Object.fromEntries(
    issuesByGroup(
      [
        { id: "a", name: "Glass", days: [], fractions: [], stopSource: "rule", containerIds: [] },
        { id: "b", name: "Glass run", days: [], fractions: [], stopSource: "rule", containerIds: [] },
        { id: "c", name: "", days: [], fractions: [], stopSource: "rule", containerIds: [] },
      ],
      ["Pick a vehicle for Glass run", "Pick a driver for Glass", "Glassware is picked twice", "Pick at least one service day"],
    ),
  ),
  { a: ["Pick a driver for Glass"], b: ["Pick a vehicle for Glass run"], c: [] },
)
check(
  "issues naming no group are scheme-level",
  unattributedIssues(
    [{ id: "a", name: "Glass", days: [], fractions: [], stopSource: "rule", containerIds: [] }],
    ["Pick a driver for Glass", "No collection group covers Sun"],
  ),
  ["No collection group covers Sun"],
)
check(
  "shared service provider only when every group names the same one",
  [
    sharedServiceProvider([organic, { ...glass, serviceProviderId: "service-provider-nordren", serviceProviderName: "NordRen ApS" }]),
    sharedServiceProvider([organic, glass]),
    sharedServiceProvider([]),
  ],
  [{ id: "service-provider-nordren", name: "NordRen ApS" }, {}, {}],
)

/* ---- validation composed from the resolver (the real seam chain) ---- */

const composed = (groups: CollectionGroup[]) => {
  const resolution = resolveCollectionGroupPlans({ groups, serviceDays: ["wednesday"], areaId: AREA, projectIds: ["project-1"], containers })
  return validateScheme({
    serviceDays: ["wednesday"],
    effectiveFrom: "2026-09-01",
    effectiveTo: "",
    areaId: AREA,
    ...schemeValidationGroups(groups, resolution, () => null, (id) => containers.find((c) => c.id === id)?.name),
  })
}
const withAssignment = (group: CollectionGroup, n: number): CollectionGroup => ({ ...group, vehicleId: `v${n}`, driverId: `d${n}` })
check(
  "composed: a hand-picked duplicate blocks with the container's name (and leaves the loser empty)",
  composed([withAssignment(manualGroup("M1", ["wednesday"], ["c-res-1"]), 1), withAssignment(manualGroup("M2", ["wednesday"], ["c-res-1"]), 2)]),
  { status: "Draft", issues: ["Pick containers for M2", "C-RES-1 is picked in both M1 and M2 on Wed"], warnings: [] },
)
check(
  "composed: a rule overlap warns and the scheme still validates",
  composed([withAssignment(ruleGroup("A", ["wednesday"], ["Organic"]), 1), withAssignment(ruleGroup("B", ["wednesday"], ["Organic", "Residual"]), 2)]),
  {
    status: "Validated",
    issues: [],
    warnings: ["B and A both match 2 containers on Wed — A collects them (first group wins)"],
  },
)

/* ---- legacy → explicit split (D36): legacy routes cancel with the marker, group routes create ---- */

const splitValues = collectionGroupsToValues(
  [
    { id: "g-a", name: "Organic bins", days: ["wednesday", "sunday"], fractions: ["Organic"], vehicleId: "vehicle-nr08", driverId: "driver-lars", vehicleName: "NR-08", driverName: "Lars Møller", stopSource: "rule", containerIds: [] },
    { id: "g-b", name: "Residual bins", days: ["wednesday", "sunday"], fractions: ["Residual"], vehicleId: "vehicle-wh24", driverId: "driver-mads", vehicleName: "WH-24", driverName: "Mads Jensen", stopSource: "rule", containerIds: [] },
  ],
  ["wednesday", "sunday"],
)
const splitScheme = schemeRecord("legacy", splitValues)
const splitPlan = planSchemeGeneration({ scheme: splitScheme, window: WINDOW, existingRoutes: legacyApplied.routes, containers: containerRecords })
check(
  "splitting a legacy scheme into groups: legacy routes cancel with the split note, group routes are created",
  splitPlan?.routes.map((route) => [route.action, route.routeId, route.note ?? null]),
  [
    ["create", "route-gen-legacy-g-a-2026-09-02", null],
    ["create", "route-gen-legacy-g-b-2026-09-02", null],
    ["cancel", "route-gen-legacy-2026-09-02", "Scheme now plans this date per collection group"],
    ["create", "route-gen-legacy-g-a-2026-09-06", null],
    ["create", "route-gen-legacy-g-b-2026-09-06", null],
    ["cancel", "route-gen-legacy-2026-09-06", "Scheme now plans this date per collection group"],
  ],
)
check(
  "the cancelled legacy routes carry the resurrection marker",
  applySchemeGeneration({ plan: splitPlan!, existingPickups: legacyApplied.pickups, containers: containerRecords, actorName: "Harness" })
    .routes.filter((route) => route.status === "Cancelled").map((route) => route.submittedValues?.cancelledByGeneration),
  [true, true],
)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
