// Headless checks for declarative stop matching (issue #19, convergence doc
// option C step 3): the rule model and its serialization, the resolver's
// area / project / fraction / vehicle-type / eligibility semantics, the
// shared effectiveStopPlans seam, rule-aware generation and Plan Ahead
// (pickups for matched containers, idempotent re-runs, new containers picked
// up without editing the scheme, zero-match warnings), and the rule-mode
// validation checks.
// Run: npx tsx scripts/route-scheme-matching-harness.ts
import type { BusinessRecord } from "../lib/data/business-modules"
import {
  applySchemeGeneration,
  planSchemeGeneration,
} from "../lib/route-schemes/generation"
import {
  effectiveStopPlans,
  schemeStopRuleSources,
} from "../lib/route-schemes/groups"
import {
  CONTAINER_VEHICLE_COMPATIBILITY,
  containerMatchProfile,
  effectiveDayRules,
  matchPlansFromValues,
  matchPlansToValues,
  resolveStopMatches,
  stopRuleSummary,
  stopSelectionMode,
  vehicleTypeOfRecord,
} from "../lib/route-schemes/matching"
import { runPlanAhead } from "../lib/route-schemes/plan-ahead"
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

/* ------------------------------- fixtures -------------------------------- */

const AREA = "area-central"
const OTHER_AREA = "area-north"
const PROJECT = "project-cph"

function makeContainer(overrides: {
  id: string
  name: string
  status?: string
  areaId?: string
  fraction?: string
  containerType?: string
  projectIds?: string[]
  submittedValues?: Record<string, string | boolean>
}): BusinessRecord {
  return {
    id: overrides.id,
    name: overrides.name,
    context: "Container",
    status: overrides.status ?? "Available",
    owner: "",
    value: "",
    updated: "",
    description: "",
    facts: {
      Address: `${overrides.name} street 1`,
      ...(overrides.containerType !== undefined
        ? { "Container type": overrides.containerType }
        : {}),
      ...(overrides.fraction !== undefined
        ? { "Waste fractions": overrides.fraction }
        : {}),
    },
    related: [],
    source: "",
    freshness: "",
    projectIds: overrides.projectIds ?? [PROJECT],
    submittedValues: {
      ...(overrides.areaId ? { planningAreaId: overrides.areaId } : {}),
      ...overrides.submittedValues,
    },
  }
}

// The base population: two matching residual bins, plus one probe per
// exclusion dimension.
const binA = makeContainer({
  id: "cont-a",
  name: "BIN-A",
  areaId: AREA,
  fraction: "Residual",
  containerType: "Two-wheel bin · 240 L",
})
const binB = makeContainer({
  id: "cont-b",
  name: "BIN-B",
  areaId: AREA,
  fraction: "Residual · Mixed",
  containerType: "Four-wheel bin · 660 L",
})
const otherAreaBin = makeContainer({
  id: "cont-north",
  name: "BIN-NORTH",
  areaId: OTHER_AREA,
  fraction: "Residual",
  containerType: "Two-wheel bin · 240 L",
})
const noAreaBin = makeContainer({
  id: "cont-noarea",
  name: "BIN-NOAREA",
  fraction: "Residual",
  containerType: "Two-wheel bin · 240 L",
})
const glassIgloo = makeContainer({
  id: "cont-glass",
  name: "BIN-GLASS",
  areaId: AREA,
  fraction: "Glass",
  containerType: "Igloo · 2,500 L",
})
const defectBin = makeContainer({
  id: "cont-defect",
  name: "BIN-DEFECT",
  status: "Defect",
  areaId: AREA,
  fraction: "Residual",
  containerType: "Two-wheel bin · 240 L",
})
const storedBin = makeContainer({
  id: "cont-stored",
  name: "BIN-STORED",
  status: "In storage",
  areaId: AREA,
  fraction: "Residual",
  containerType: "Two-wheel bin · 240 L",
})
const untypedBin = makeContainer({
  id: "cont-untyped",
  name: "BIN-UNTYPED",
  areaId: AREA,
  fraction: "Residual",
})
const otherProjectBin = makeContainer({
  id: "cont-harbor",
  name: "BIN-HARBOR",
  areaId: AREA,
  fraction: "Residual",
  containerType: "Two-wheel bin · 240 L",
  projectIds: ["project-harbor"],
})
// A form-created container: typed enum ids in submittedValues, no
// "Waste fractions"/"Container type" facts.
const formBin = makeContainer({
  id: "cont-form",
  name: "BIN-FORM",
  areaId: AREA,
  submittedValues: { wasteFraction: "residual", containerType: "two-wheel-240" },
})

const CONTAINERS = [
  binA,
  binB,
  otherAreaBin,
  noAreaBin,
  glassIgloo,
  defectBin,
  storedBin,
  untypedBin,
  otherProjectBin,
  formBin,
]

const RESIDUAL_RULE = { fractions: ["Residual"], vehicleType: "Rear loader" }

/* ---------------------------- resolver semantics -------------------------- */

const resolved = resolveStopMatches({
  rule: RESIDUAL_RULE,
  areaId: AREA,
  projectIds: [PROJECT],
  containers: CONTAINERS,
})

check(
  "the rule resolves exactly the eligible matching containers, sorted by name",
  resolved.matched.map((profile) => profile.id),
  ["cont-a", "cont-b", "cont-form"],
)
check(
  "a container in another planning area never matches",
  resolved.matched.some((profile) => profile.id === "cont-north"),
  false,
)
check(
  "a container without a planning area never matches",
  resolved.matched.some((profile) => profile.id === "cont-noarea"),
  false,
)
check(
  "a container in another project never matches",
  resolved.matched.some((profile) => profile.id === "cont-harbor"),
  false,
)
check(
  "a non-matching fraction is out of the match without being a near-miss",
  [resolved.matched, resolved.excluded].some((list) =>
    list.some((entry) => entry.id === "cont-glass"),
  ),
  false,
)
check(
  "near-miss exclusions carry visible reasons (status and classification)",
  resolved.excluded.map((exclusion) => [exclusion.id, exclusion.reason]),
  [
    ["cont-defect", "Defect — not in service"],
    ["cont-stored", "In storage — not in service"],
    ["cont-untyped", "No container type recorded — vehicle compatibility unknown"],
  ],
)
check(
  "scopeTotal counts every in-area, in-project container considered",
  resolved.scopeTotal,
  7,
)
check(
  "a multi-fraction container matches each of its fractions",
  resolveStopMatches({
    rule: { fractions: ["Mixed"] },
    areaId: AREA,
    projectIds: [PROJECT],
    containers: CONTAINERS,
  }).matched.map((profile) => profile.id),
  ["cont-b"],
)
check(
  "fraction matching is case-insensitive",
  resolveStopMatches({
    rule: { fractions: ["residual"] },
    areaId: AREA,
    projectIds: [PROJECT],
    containers: [binA],
  }).matched.length,
  1,
)
check(
  "without a vehicle type the rule matches any serviceable status container",
  resolveStopMatches({
    rule: { fractions: ["Residual"] },
    areaId: AREA,
    projectIds: [PROJECT],
    containers: CONTAINERS,
  }).matched.map((profile) => profile.id),
  ["cont-a", "cont-b", "cont-form", "cont-untyped"],
)
check(
  "an incompatible container type is excluded with the vehicle-type reason",
  resolveStopMatches({
    rule: { fractions: ["Glass"], vehicleType: "Rear loader" },
    areaId: AREA,
    projectIds: [PROJECT],
    containers: CONTAINERS,
  }).excluded.map((exclusion) => [exclusion.id, exclusion.reason]),
  [["cont-glass", "Igloo · 2,500 L is not serviceable by a rear loader"]],
)
check(
  "a glass crane rule matches the igloo",
  resolveStopMatches({
    rule: { fractions: ["Glass"], vehicleType: "Glass crane" },
    areaId: AREA,
    projectIds: [PROJECT],
    containers: CONTAINERS,
  }).matched.map((profile) => profile.id),
  ["cont-glass"],
)
check(
  "an empty-fraction rule matches nothing",
  resolveStopMatches({
    rule: { fractions: [] },
    areaId: AREA,
    projectIds: [PROJECT],
    containers: CONTAINERS,
  }).matched.length,
  0,
)
check(
  "a missing scheme area matches nothing",
  resolveStopMatches({
    rule: RESIDUAL_RULE,
    areaId: undefined,
    projectIds: [PROJECT],
    containers: CONTAINERS,
  }),
  { matched: [], excluded: [], scopeTotal: 0 },
)
check(
  "a scheme without recorded projects matches project-scoped containers (scope-unknown is wide)",
  resolveStopMatches({
    rule: { fractions: ["Residual"] },
    areaId: AREA,
    containers: [binA],
  }).matched.length,
  1,
)

/* ------------------------- container profile reading ---------------------- */

check(
  "a form-created container's typed enum values map onto the display vocabulary",
  (() => {
    const profile = containerMatchProfile(formBin)
    return [profile.fractions, profile.containerType]
  })(),
  [["Residual"], "Two-wheel bin · 240 L"],
)
check(
  "a fixture container's display facts read as its profile",
  (() => {
    const profile = containerMatchProfile(binB)
    return [profile.fractions, profile.containerType, profile.areaId]
  })(),
  [["Residual", "Mixed"], "Four-wheel bin · 660 L", AREA],
)
check(
  "every compatibility entry names only canonical vehicle types",
  Object.values(CONTAINER_VEHICLE_COMPATIBILITY)
    .flat()
    .every((type) =>
      ["Rear loader", "Organic sealed", "Paper compactor", "Glass crane", "Vacuum tanker"].includes(
        type,
      ),
    ),
  true,
)
check(
  "vehicleTypeOfRecord reads the canonical prefix of the fleet context string",
  [
    vehicleTypeOfRecord({ context: "Rear loader 18 t · Nordhavn" }),
    vehicleTypeOfRecord({ context: "Glass crane 16 t · Amager" }),
    vehicleTypeOfRecord({ context: "18 t trailer · Nordhavn" }),
    vehicleTypeOfRecord(undefined),
  ],
  ["Rear loader", "Glass crane", null, null],
)

/* ------------------------------ serialization ----------------------------- */

const MATCH_PLANS = {
  sameAllDays: false,
  sharedRule: { fractions: ["Residual"], vehicleType: "Rear loader" },
  rulesByDay: {
    wednesday: { fractions: ["Organic"], vehicleType: "Organic sealed" },
    sunday: { fractions: ["Glass"] },
  },
}

check(
  "match plans round-trip through submittedValues",
  matchPlansFromValues({
    sameAllDays: false,
    ...matchPlansToValues(MATCH_PLANS),
  }),
  MATCH_PLANS,
)
check(
  "matchFractions serializes multiselect-style and tolerates tight commas",
  matchPlansFromValues({ matchFractions: "Residual,Glass" }).sharedRule.fractions,
  ["Residual", "Glass"],
)
check(
  "corrupted matchRulesByDay JSON falls back to no per-day rules",
  matchPlansFromValues({ matchRulesByDay: "{broken" }).rulesByDay,
  {},
)
check(
  "non-service-day keys and malformed rules are dropped",
  matchPlansFromValues({
    matchRulesByDay: JSON.stringify({
      funday: { fractions: ["Residual"] },
      monday: "nope",
      tuesday: { fractions: ["Paper"] },
    }),
  }).rulesByDay,
  { tuesday: { fractions: ["Paper"] } },
)
check(
  "stopSelection defaults to manual for legacy records",
  [
    stopSelectionMode(undefined),
    stopSelectionMode({}),
    stopSelectionMode({ stopSelection: "manual" }),
    stopSelectionMode({ stopSelection: "rule" }),
  ],
  ["manual", "manual", "manual", "rule"],
)
check(
  "per-day mode without a day rule resolves that day to the empty rule",
  effectiveDayRules(["monday", "tuesday"], {
    sameAllDays: false,
    sharedRule: { fractions: ["Residual"] },
    rulesByDay: { tuesday: { fractions: ["Paper"] } },
  }),
  [
    { day: "monday", rule: { fractions: [] } },
    { day: "tuesday", rule: { fractions: ["Paper"] } },
  ],
)
check(
  "stopRuleSummary names fractions and the vehicle type",
  [
    stopRuleSummary({ fractions: ["Residual", "Glass"], vehicleType: "Rear loader" }),
    stopRuleSummary({ fractions: [] }),
  ],
  ["Residual, Glass · Rear loader", "No fractions"],
)

/* --------------------------- rule-mode scheme ------------------------------ */

// Window Tue 2026-09-01 → Mon 2026-09-07: contains Wed 2026-09-02, Sun 2026-09-06.
const WINDOW = { from: "2026-09-01", to: "2026-09-07" }
const WED = "2026-09-02"

function makeRuleScheme(
  overrides: Partial<BusinessRecord["submittedValues"]> = {},
): BusinessRecord {
  return {
    id: "schemes-route-scheme-900",
    name: "Central Residual Rule",
    context: "Copenhagen Central",
    status: "Validated",
    owner: "Planner",
    value: "",
    updated: "Now",
    description: "",
    facts: {
      Version: "v1",
      Project: "Copenhagen Central",
      "Planning area": "Central",
      Vehicle: "WH-24",
      Driver: "Mads Jensen",
      "Planned start": "06:30",
    },
    related: [],
    source: "",
    freshness: "Now",
    projectIds: [PROJECT],
    recordKind: "Route Scheme",
    submittedValues: {
      schemeName: "Central Residual Rule",
      planningAreaId: AREA,
      frequency: "weekly",
      serviceDays: "wednesday, sunday",
      effectiveFrom: "2026-08-01",
      effectiveTo: "2026-12-31",
      plannedStartTime: "06:30",
      stopSelection: "rule",
      sameAllDays: true,
      matchFractions: "Residual",
      matchVehicleType: "Rear loader",
      matchRulesByDay: "{}",
      ...overrides,
    },
  }
}

const ruleScheme = makeRuleScheme()

check(
  "effectiveStopPlans resolves a rule scheme's days from the rule",
  effectiveStopPlans(ruleScheme, ["wednesday", "sunday"], CONTAINERS),
  [
    { day: "wednesday", containerIds: ["cont-a", "cont-b", "cont-form"] },
    { day: "sunday", containerIds: ["cont-a", "cont-b", "cont-form"] },
  ],
)
check(
  "effectiveStopPlans keeps manual schemes on their picked lists",
  effectiveStopPlans(
    {
      submittedValues: {
        sameAllDays: false,
        containerIds: "",
        containersByDay: JSON.stringify({ wednesday: ["cont-x"] }),
      },
      projectIds: [PROJECT],
    },
    ["wednesday", "sunday"],
    CONTAINERS,
  ),
  [
    { day: "wednesday", containerIds: ["cont-x"] },
    { day: "sunday", containerIds: [] },
  ],
)

/* ------------------------- rule-aware generation --------------------------- */

const plan = planSchemeGeneration({
  scheme: ruleScheme,
  window: WINDOW,
  existingRoutes: [],
  containers: CONTAINERS,
})!

check(
  "generation plans one route per service day with the matched stops",
  plan.routes.map((route) => [route.action, route.day, route.containerIds]),
  [
    ["create", "wednesday", ["cont-a", "cont-b", "cont-form"]],
    ["create", "sunday", ["cont-a", "cont-b", "cont-form"]],
  ],
)
check(
  "matched days carry no zero-match warning",
  plan.routes.every((route) => route.matchWarning === undefined),
  true,
)

const applied = applySchemeGeneration({
  plan,
  existingPickups: [],
  containers: CONTAINERS,
  actorName: "Harness",
})
check(
  "apply creates one pickup per matched container per route",
  applied.summary,
  { created: 2, refreshed: 0, cancelled: 0, skipped: 0, calendarSkipped: 0, pickups: 6 },
)
check(
  "pickups deep-link matched containers with their facts",
  applied.pickups
    .filter((pickup) => pickup.submittedValues?.serviceDate === WED)
    .map((pickup) => [
      pickup.submittedValues?.containerId,
      pickup.facts["Waste fraction"],
    ]),
  [
    ["cont-a", "Residual"],
    ["cont-b", "Residual · Mixed"],
    ["cont-form", undefined],
  ],
)

// A new eligible container appears — the next generation includes it without
// editing the scheme, and the re-run stays idempotent.
const newBin = makeContainer({
  id: "cont-new",
  name: "BIN-NEW",
  areaId: AREA,
  fraction: "Residual",
  containerType: "Two-wheel bin · 240 L",
})
const rerunPlan = planSchemeGeneration({
  scheme: ruleScheme,
  window: WINDOW,
  existingRoutes: applied.routes,
  containers: [...CONTAINERS, newBin],
})!
check(
  "a newly matching container joins the refreshed routes without a scheme edit",
  rerunPlan.routes.map((route) => [route.action, route.containerIds.includes("cont-new")]),
  [
    ["refresh", true],
    ["refresh", true],
  ],
)
const rerunApplied = applySchemeGeneration({
  plan: rerunPlan,
  existingPickups: applied.pickups,
  containers: [...CONTAINERS, newBin],
  actorName: "Harness",
})
check(
  "the re-run refreshes the same route identities — no duplicates",
  [
    rerunApplied.routes.map((route) => route.id),
    applied.routes.map((route) => route.id),
  ],
  [
    applied.routes.map((route) => route.id),
    applied.routes.map((route) => route.id),
  ],
)
check(
  "the re-run rewrites pickups by deterministic id — no duplicate pickups",
  new Set(rerunApplied.pickups.map((pickup) => pickup.id)).size,
  rerunApplied.pickups.length,
)

// A container leaving the match (fraction changed) gets its stale pickup
// skipped by the existing regeneration cleanup.
const shrunkPlan = planSchemeGeneration({
  scheme: ruleScheme,
  window: WINDOW,
  existingRoutes: applied.routes,
  containers: CONTAINERS.filter((container) => container.id !== "cont-b"),
})!
const shrunkApplied = applySchemeGeneration({
  plan: shrunkPlan,
  existingPickups: applied.pickups,
  containers: CONTAINERS.filter((container) => container.id !== "cont-b"),
  actorName: "Harness",
})
check(
  "a container no longer matching has its still-planned pickup skipped",
  shrunkApplied.pickups
    .filter((pickup) => pickup.submittedValues?.containerId === "cont-b")
    .map((pickup) => pickup.status),
  ["Skipped", "Skipped"],
)

/* ------------------------------ zero-match -------------------------------- */

const zeroScheme = makeRuleScheme({ matchFractions: "Metal" })
const zeroPlan = planSchemeGeneration({
  scheme: zeroScheme,
  window: WINDOW,
  existingRoutes: [],
  containers: CONTAINERS,
})!
check(
  "a zero-match rule day plans a stop-less route with a loud warning",
  zeroPlan.routes.map((route) => [
    route.containerIds.length,
    route.matchWarning,
  ]),
  [
    [0, "No containers currently match this day's stop rule"],
    [0, "No containers currently match this day's stop rule"],
  ],
)
check(
  "manual schemes never carry the rule warning, even with empty days",
  planSchemeGeneration({
    scheme: {
      ...ruleScheme,
      submittedValues: {
        ...ruleScheme.submittedValues,
        stopSelection: "manual",
        containerIds: "",
        containersByDay: "{}",
      },
    },
    window: WINDOW,
    existingRoutes: [],
    containers: CONTAINERS,
  })!.routes.every((route) => route.matchWarning === undefined),
  true,
)

/* ------------------------------- Plan Ahead -------------------------------- */

// today Tue 2026-09-01 → window Wed 2026-09-02 … Tue 2026-09-08.
const planAheadResult = runPlanAhead({
  schemes: [
    {
      ...ruleScheme,
      submittedValues: { ...ruleScheme.submittedValues, planAhead: true },
    },
  ],
  today: "2026-09-01",
  existingRoutes: [],
  existingPickups: [],
  containers: CONTAINERS,
  actorName: "Harness",
})
check(
  "Plan Ahead resolves stops through the same rule resolver",
  planAheadResult.summary,
  {
    schemes: 1,
    created: 2,
    refreshed: 0,
    cancelled: 0,
    skipped: 0,
    calendarSkipped: 0,
    pickups: 6,
  },
)
check(
  "Plan Ahead pickups cover exactly the matched containers",
  Array.from(
    new Set(
      planAheadResult.pickups.map((pickup) => pickup.submittedValues?.containerId),
    ),
  ).sort(),
  ["cont-a", "cont-b", "cont-form"],
)

/* ------------------------- rule-mode validation ---------------------------- */

// Validation reads a scheme as collection groups (D33): a legacy rule scheme
// with one shared rule is one implicit group covering every service day; a
// per-day rule scheme is one group per day named by its short day label.
type DayRule = { day: ServiceDay; fractions: string[]; vehicleType?: string; matchedCount: number }
const DAY_LABEL: Record<string, string> = { wednesday: "Wed", sunday: "Sun", monday: "Mon", tuesday: "Tue" }
const ruleInput = (matching: {
  areaId: string | undefined
  sameAllDays: boolean
  dayRules: DayRule[]
  plannedVehicleType?: string
}): SchemeValidationInput => {
  const base = {
    vehicleId: "vehicle-1",
    driverId: "driver-1",
    stopSource: "rule" as const,
    vehicleType: matching.plannedVehicleType ?? null,
  }
  const groups: SchemeGroupValidationInput[] = matching.sameAllDays
    ? [
        {
          ...base,
          id: "default",
          name: "Scheme",
          days: matching.dayRules.map((rule) => rule.day),
          fractions: matching.dayRules[0]?.fractions ?? [],
          ruleVehicleType: matching.dayRules[0]?.vehicleType,
          dayStops: matching.dayRules.map((rule) => ({ day: rule.day, count: rule.matchedCount, claimedByOthers: 0 })),
        },
      ]
    : matching.dayRules.map((rule) => ({
        ...base,
        id: `day-${rule.day}`,
        name: DAY_LABEL[rule.day],
        days: [rule.day],
        fractions: rule.fractions,
        ruleVehicleType: rule.vehicleType,
        dayStops: [{ day: rule.day, count: rule.matchedCount, claimedByOthers: 0 }],
      }))
  return {
    serviceDays: ["wednesday", "sunday"],
    effectiveFrom: "2026-08-01",
    effectiveTo: "2026-12-31",
    areaId: matching.areaId,
    groups,
  }
}

check(
  "a matching rule validates without the manual container check",
  validateScheme(
    ruleInput({
      areaId: AREA,
      sameAllDays: true,
      dayRules: [
        { day: "wednesday", fractions: ["Residual"], matchedCount: 3 },
        { day: "sunday", fractions: ["Residual"], matchedCount: 3 },
      ],
    }),
  ),
  { status: "Validated", issues: [], warnings: [] },
)
check(
  "a rule without a planning area blocks",
  validateScheme(
    ruleInput({
      areaId: undefined,
      sameAllDays: true,
      dayRules: [
        { day: "wednesday", fractions: ["Residual"], matchedCount: 0 },
        { day: "sunday", fractions: ["Residual"], matchedCount: 0 },
      ],
    }),
  ).issues,
  ["Pick a planning area — the stop rule matches containers inside it"],
)
check(
  "a day without fractions blocks, naming the days in per-day mode",
  validateScheme(
    ruleInput({
      areaId: AREA,
      sameAllDays: false,
      dayRules: [
        { day: "wednesday", fractions: [], matchedCount: 0 },
        { day: "sunday", fractions: ["Glass"], matchedCount: 2 },
      ],
    }),
  ).issues,
  ["Pick waste fractions for Wed"],
)
check(
  "a zero-match rule blocks (shared and per-day phrasing)",
  [
    validateScheme(
      ruleInput({
        areaId: AREA,
        sameAllDays: true,
        dayRules: [
          { day: "wednesday", fractions: ["Metal"], matchedCount: 0 },
          { day: "sunday", fractions: ["Metal"], matchedCount: 0 },
        ],
      }),
    ).issues,
    validateScheme(
      ruleInput({
        areaId: AREA,
        sameAllDays: false,
        dayRules: [
          { day: "wednesday", fractions: ["Metal"], matchedCount: 0 },
          { day: "sunday", fractions: ["Glass"], matchedCount: 2 },
        ],
      }),
    ).issues,
  ],
  [
    ["No containers currently match the stop rule"],
    ["No containers match the stop rule for Wed"],
  ],
)
check(
  "a rule vehicle type the default vehicle cannot serve warns, never blocks",
  validateScheme(
    ruleInput({
      areaId: AREA,
      sameAllDays: true,
      dayRules: [
        { day: "wednesday", fractions: ["Organic"], vehicleType: "Organic sealed", matchedCount: 2 },
        { day: "sunday", fractions: ["Organic"], vehicleType: "Organic sealed", matchedCount: 2 },
      ],
      plannedVehicleType: "Rear loader",
    }),
  ),
  {
    status: "Validated",
    issues: [],
    warnings: [
      "Default vehicle is a rear loader but the stop rule requires a organic sealed",
    ],
  },
)
check(
  "an overlapping rule-mode scheme warns with the shared fractions and days",
  validateScheme(
    ruleInput({
      areaId: AREA,
      sameAllDays: true,
      dayRules: [
        { day: "wednesday", fractions: ["Residual", "Glass"], matchedCount: 3 },
        { day: "sunday", fractions: ["Residual", "Glass"], matchedCount: 3 },
      ],
    }),
    [],
    [],
    [
      {
        schemeName: "Rival scheme",
        areaId: AREA,
        serviceDays: ["sunday", "monday"],
        fractions: ["glass"],
        effectiveFrom: "2026-01-01",
        effectiveTo: "2026-12-31",
      },
    ],
  ).warnings,
  [
    'Stop rule overlaps "Rival scheme" — Glass containers in the same planning area are already matched on Sun',
  ],
)
check(
  "overlap warnings skip disjoint periods, other areas, and unshared days",
  validateScheme(
    ruleInput({
      areaId: AREA,
      sameAllDays: true,
      dayRules: [
        { day: "wednesday", fractions: ["Residual"], matchedCount: 3 },
        { day: "sunday", fractions: ["Residual"], matchedCount: 3 },
      ],
    }),
    [],
    [],
    [
      {
        schemeName: "Past scheme",
        areaId: AREA,
        serviceDays: ["wednesday"],
        fractions: ["Residual"],
        effectiveFrom: "2025-01-01",
        effectiveTo: "2025-12-31",
      },
      {
        schemeName: "Elsewhere",
        areaId: OTHER_AREA,
        serviceDays: ["wednesday"],
        fractions: ["Residual"],
      },
      {
        schemeName: "Other days",
        areaId: AREA,
        serviceDays: ["monday"],
        fractions: ["Residual"],
      },
    ],
  ).warnings,
  [],
)
check(
  "manual validation is untouched by the rule checks",
  validateScheme({
    serviceDays: ["wednesday", "sunday"],
    effectiveFrom: "2026-08-01",
    effectiveTo: "2026-12-31",
    areaId: AREA,
    groups: [
      {
        id: "default",
        name: "Scheme",
        days: ["wednesday", "sunday"],
        vehicleId: "vehicle-1",
        driverId: "driver-1",
        stopSource: "manual",
        fractions: [],
        dayStops: [
          { day: "wednesday", count: 0, claimedByOthers: 0 },
          { day: "sunday", count: 0, claimedByOthers: 0 },
        ],
      },
    ],
  }).issues,
  ["Pick at least one container"],
)

/* ------------------------ rule sources extraction -------------------------- */

check(
  "schemeStopRuleSources extracts rule schemes and skips manual/incomplete ones",
  schemeStopRuleSources([
    ruleScheme,
    { name: "Manual", submittedValues: { stopSelection: "manual", containerIds: "x" } },
    {
      name: "No area",
      submittedValues: {
        stopSelection: "rule",
        serviceDays: "monday",
        matchFractions: "Residual",
      },
    },
    {
      name: "Per-day union",
      submittedValues: {
        stopSelection: "rule",
        planningAreaId: AREA,
        serviceDays: "monday, tuesday",
        sameAllDays: false,
        matchRulesByDay: JSON.stringify({
          monday: { fractions: ["Organic"] },
          tuesday: { fractions: ["Glass"] },
        }),
      },
    },
  ]),
  [
    {
      schemeName: "Central Residual Rule",
      areaId: AREA,
      serviceDays: ["wednesday", "sunday"],
      fractions: ["Residual"],
      effectiveFrom: "2026-08-01",
      effectiveTo: "2026-12-31",
    },
    {
      schemeName: "Per-day union",
      areaId: AREA,
      serviceDays: ["monday", "tuesday"],
      fractions: ["Organic", "Glass"],
      effectiveFrom: undefined,
      effectiveTo: undefined,
    },
  ],
)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
