// Headless checks for manual route generation (spec FR-6–FR-10, ticket #7):
// window enumeration, deterministic route identity, the upsert rules
// (create / refresh / skip / cancel), deviation remap, version pinning,
// overridden-assignment preservation, and pickup building.
// Run: npx tsx scripts/route-scheme-generation-harness.ts
import type { BusinessRecord } from "../lib/data/business-modules"
import { formatServiceDate } from "../lib/route-schemes/recurrence"
import {
  applySchemeGeneration,
  approvedDeviationsFromRecords,
  generatedRouteId,
  generatedRouteName,
  planSchemeGeneration,
  schemeVersionOf,
  type ApprovedDeviation,
} from "../lib/route-schemes/generation"

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

// Window Tue 2026-09-01 → Mon 2026-09-07: contains Wed 2026-09-02, Sun 2026-09-06.
const WINDOW = { from: "2026-09-01", to: "2026-09-07" }
const WED = "2026-09-02"
const SUN = "2026-09-06"

const scheme: BusinessRecord = {
  id: "schemes-route-scheme-777",
  name: "Central Wed+Sun",
  context: "Copenhagen Central · Indre By",
  status: "Validated",
  owner: "Planner",
  value: "3 planned stops",
  updated: "Now",
  description: "",
  facts: {
    Version: "v3",
    Project: "Copenhagen Central",
    "Planning area": "Indre By",
    Vehicle: "WH-24",
    Driver: "Mads Jensen",
    "Departure depot": "Nordhavn",
    "Unloading station": "ARC Amager",
    "Planned start": "06:30",
  },
  related: [],
  source: "Office workspace",
  freshness: "Now",
  companyId: "company-wastehero",
  projectIds: ["project-central"],
  recordKind: "Route Scheme",
  submittedValues: {
    schemeName: "Central Wed+Sun",
    frequency: "weekly",
    weekRotation: "",
    serviceDays: "wednesday, sunday",
    effectiveFrom: "2026-08-01",
    effectiveTo: "2026-12-31",
    plannedStartTime: "06:30",
    sameAllDays: false,
    containerIds: "",
    containersByDay: JSON.stringify({
      wednesday: ["cont-w1", "cont-w2"],
      sunday: ["cont-s1"],
    }),
  },
}

const containers: BusinessRecord[] = [
  {
    id: "cont-w1",
    name: "BIN-20001",
    context: "Container",
    status: "Active",
    owner: "",
    value: "",
    updated: "",
    description: "",
    facts: {
      Address: "Adelgade 12, 1304 København K",
      "Container type": "660L container",
      "Waste fractions": "Residual",
    },
    related: [],
    source: "",
    freshness: "",
  },
  {
    id: "cont-w2",
    name: "BIN-20002",
    context: "Container",
    status: "Active",
    owner: "",
    value: "",
    updated: "",
    description: "",
    facts: {
      Address: "Borgergade 41, 1300 København K",
      "Container type": "240L bin",
      "Waste fractions": "Paper & cardboard",
    },
    related: [],
    source: "",
    freshness: "",
  },
  {
    id: "cont-s1",
    name: "BIN-20003",
    context: "Container",
    status: "Active",
    owner: "",
    value: "",
    updated: "",
    description: "",
    facts: {
      Address: "Ryesgade 8, 2200 København N",
      "Container type": "400L bin",
      "Waste fractions": "Glass",
    },
    related: [],
    source: "",
    freshness: "",
  },
]

/* --------------------------- deterministic identity ----------------------- */

check(
  "route id is deterministic on (scheme, serviceDate)",
  generatedRouteId(scheme.id, WED) === generatedRouteId(scheme.id, WED),
  true,
)
check(
  "route id differs per service date",
  generatedRouteId(scheme.id, WED) === generatedRouteId(scheme.id, SUN),
  false,
)
check(
  "route name is RC-numbered and stable",
  generatedRouteName(scheme.id, WED) === generatedRouteName(scheme.id, WED) &&
    /^RC-\d{4}$/.test(generatedRouteName(scheme.id, WED)),
  true,
)

check("scheme version reads the facts Version token", schemeVersionOf(scheme), "v3")
check(
  "scheme version drops a draft suffix and defaults to v1",
  [
    schemeVersionOf({ ...scheme, facts: { ...scheme.facts, Version: "v6 draft" } }),
    schemeVersionOf({ ...scheme, facts: {} }),
  ],
  ["v6", "v1"],
)

/* ------------------------- canonical create plan -------------------------- */

const createPlan = planSchemeGeneration({
  scheme,
  window: WINDOW,
  existingRoutes: [],
  deviations: [],
})

check("canonical Wed+Sun window plans two routes", createPlan?.routes.length, 2)
check(
  "both are creates on the right dates with per-day stops",
  createPlan?.routes.map((route) => [
    route.action,
    route.serviceDate,
    route.actualDate,
    route.day,
    route.containerIds,
  ]),
  [
    ["create", WED, WED, "wednesday", ["cont-w1", "cont-w2"]],
    ["create", SUN, SUN, "sunday", ["cont-s1"]],
  ],
)
check("plan pins the scheme version", createPlan?.schemeVersion, "v3")

/* ----------------------------- apply: routes ------------------------------ */

const applied = createPlan
  ? applySchemeGeneration({
      plan: createPlan,
      existingPickups: [],
      containers,
      actorName: "Planner",
    })
  : null

check("apply creates two route records", applied?.routes.length, 2)
const wedRoute = applied?.routes.find(
  (route) => route.submittedValues?.serviceDate === WED,
)
check("generated route is Planned", wedRoute?.status, "Planned")
check("generated route id is the deterministic identity", wedRoute?.id, generatedRouteId(scheme.id, WED))
check("generated route name is the RC number", wedRoute?.name, generatedRouteName(scheme.id, WED))
check(
  "route inherits scheme defaults into facts",
  [
    wedRoute?.facts.Project,
    wedRoute?.facts.Area,
    wedRoute?.facts.Vehicle,
    wedRoute?.facts.Driver,
    wedRoute?.facts.Depot,
    wedRoute?.facts.Unloading,
  ],
  ["Copenhagen Central", "Indre By", "WH-24", "Mads Jensen", "Nordhavn", "ARC Amager"],
)
check(
  "route pins scheme version and typed scheme relation",
  [
    wedRoute?.submittedValues?.schemeVersion,
    wedRoute?.submittedValues?.schemeId,
    wedRoute?.facts["Route scheme"],
  ],
  ["v3", scheme.id, "Central Wed+Sun"],
)
check(
  "route carries the operating date and scheme scope",
  [wedRoute?.submittedValues?.actualDate, wedRoute?.projectIds, wedRoute?.companyId],
  [WED, ["project-central"], "company-wastehero"],
)
check("no deviation → Deviation fact is None", wedRoute?.facts.Deviation, "None")
check(
  "summary counts the creates",
  applied?.summary,
  { created: 2, refreshed: 0, cancelled: 0, skipped: 0, pickups: 3 },
)

/* ----------------------------- apply: pickups ----------------------------- */

check("one pickup per container in that day's plan", applied?.pickups.length, 3)
const wedPickups = applied?.pickups.filter(
  (pickup) => pickup.submittedValues?.routeId === wedRoute?.id,
)
check(
  "pickups are sequenced in picked order",
  wedPickups?.map((pickup) => [pickup.facts.Stop, pickup.submittedValues?.containerId]),
  [
    ["1", "cont-w1"],
    ["2", "cont-w2"],
  ],
)
check(
  "pickup ids are deterministic per (route, container)",
  wedPickups?.[0]?.id,
  `${generatedRouteId(scheme.id, WED)}-p-cont-w1`,
)
check(
  "pickup deep-links to its route",
  wedPickups?.[0]?.deepLink,
  `/route-studio?module=routes&record=${generatedRouteId(scheme.id, WED)}`,
)
check(
  "pickup carries container facts",
  [
    wedPickups?.[0]?.facts.Address,
    wedPickups?.[0]?.facts["Container Type"],
    wedPickups?.[0]?.facts["Waste fraction"],
    wedPickups?.[0]?.facts.Route,
  ],
  [
    "Adelgade 12, 1304 København K",
    "660L container",
    "Residual",
    generatedRouteName(scheme.id, WED),
  ],
)
check("pickups start Planned", wedPickups?.every((pickup) => pickup.status === "Planned"), true)

/* --------------------------- idempotent re-run ---------------------------- */

const rerunPlan = planSchemeGeneration({
  scheme,
  window: WINDOW,
  existingRoutes: applied?.routes ?? [],
  deviations: [],
})
check(
  "re-running the same window refreshes instead of duplicating",
  rerunPlan?.routes.map((route) => [route.action, route.routeId]),
  [
    ["refresh", generatedRouteId(scheme.id, WED)],
    ["refresh", generatedRouteId(scheme.id, SUN)],
  ],
)
const rerunApplied = rerunPlan
  ? applySchemeGeneration({
      plan: rerunPlan,
      existingPickups: applied?.pickups ?? [],
      containers,
      actorName: "Planner",
    })
  : null
check(
  "re-run upserts the same route ids (zero duplicates)",
  rerunApplied?.routes.map((route) => route.id).sort(),
  applied?.routes.map((route) => route.id).sort(),
)
check(
  "re-run upserts the same pickup ids (zero duplicates)",
  rerunApplied?.pickups.map((pickup) => pickup.id).sort(),
  applied?.pickups.map((pickup) => pickup.id).sort(),
)

/* ------------------- refresh keeps an overridden assignment --------------- */

const overriddenWed: BusinessRecord = {
  ...(applied?.routes.find((route) => route.submittedValues?.serviceDate === WED) as BusinessRecord),
  facts: {
    ...(wedRoute?.facts as Record<string, string>),
    Driver: "Freja Nielsen", // dispatcher reassigned after generation
  },
  owner: "Freja Nielsen",
}
const overriddenPlan = planSchemeGeneration({
  scheme,
  window: WINDOW,
  existingRoutes: [overriddenWed, ...(applied?.routes.filter((r) => r.id !== overriddenWed.id) ?? [])],
  deviations: [],
})
const overriddenApplied = overriddenPlan
  ? applySchemeGeneration({
      plan: overriddenPlan,
      existingPickups: [],
      containers,
      actorName: "Planner",
    })
  : null
const refreshedWed = overriddenApplied?.routes.find(
  (route) => route.submittedValues?.serviceDate === WED,
)
check(
  "refresh keeps the overridden driver, not the scheme default",
  refreshedWed?.facts.Driver,
  "Freja Nielsen",
)
check(
  "refresh still records the scheme default as the applied assignment",
  refreshedWed?.submittedValues?.appliedDriver,
  "Mads Jensen",
)

/* --------------------- executed routes are left untouched ----------------- */

const activeWed: BusinessRecord = { ...(overriddenWed as BusinessRecord), status: "Active" }
const skipPlan = planSchemeGeneration({
  scheme,
  window: WINDOW,
  existingRoutes: [activeWed],
  deviations: [],
})
check(
  "Active route is skipped, missing Sunday is created",
  skipPlan?.routes.map((route) => route.action),
  ["skip", "create"],
)
const skipApplied = skipPlan
  ? applySchemeGeneration({
      plan: skipPlan,
      existingPickups: [],
      containers,
      actorName: "Planner",
    })
  : null
check(
  "skip writes no route record for the Active day",
  skipApplied?.routes.map((route) => route.submittedValues?.serviceDate),
  [SUN],
)

/* ------------------- removed service day cancels Planned ------------------ */

const wedOnlyScheme: BusinessRecord = {
  ...scheme,
  submittedValues: {
    ...scheme.submittedValues,
    serviceDays: "wednesday",
  },
}
const cancelPlan = planSchemeGeneration({
  scheme: wedOnlyScheme,
  window: WINDOW,
  existingRoutes: applied?.routes ?? [],
  deviations: [],
})
check(
  "dropped Sunday still-Planned route is cancelled",
  cancelPlan?.routes.map((route) => [route.action, route.serviceDate]),
  [
    ["refresh", WED],
    ["cancel", SUN],
  ],
)
const cancelApplied = cancelPlan
  ? applySchemeGeneration({
      plan: cancelPlan,
      existingPickups: applied?.pickups ?? [],
      containers,
      actorName: "Planner",
    })
  : null
const cancelledSun = cancelApplied?.routes.find((route) => route.status === "Cancelled")
check(
  "cancelled route names the reason",
  cancelledSun?.facts.Deviation,
  "Scheme no longer serves this date",
)
check(
  "the cancelled route's planned pickups are skipped",
  cancelApplied?.pickups
    .filter((pickup) => pickup.submittedValues?.routeId === cancelledSun?.id)
    .map((pickup) => pickup.status),
  ["Skipped"],
)

const completedSun: BusinessRecord = {
  ...(applied?.routes.find((route) => route.submittedValues?.serviceDate === SUN) as BusinessRecord),
  status: "Completed",
}
const completedCancelPlan = planSchemeGeneration({
  scheme: wedOnlyScheme,
  window: WINDOW,
  existingRoutes: [completedSun],
  deviations: [],
})
check(
  "a Completed route on a dropped day is left as is",
  completedCancelPlan?.routes.map((route) => route.action),
  ["create"],
)

/* --------------------- stale pickups on a shrunk day plan ----------------- */

const shrunkScheme: BusinessRecord = {
  ...scheme,
  submittedValues: {
    ...scheme.submittedValues,
    containersByDay: JSON.stringify({ wednesday: ["cont-w1"], sunday: ["cont-s1"] }),
  },
}
const shrunkPlan = planSchemeGeneration({
  scheme: shrunkScheme,
  window: WINDOW,
  existingRoutes: applied?.routes ?? [],
  deviations: [],
})
const shrunkApplied = shrunkPlan
  ? applySchemeGeneration({
      plan: shrunkPlan,
      existingPickups: applied?.pickups ?? [],
      containers,
      actorName: "Planner",
    })
  : null
check(
  "a container removed from the day plan skips its stale pickup",
  shrunkApplied?.pickups
    .filter((pickup) => pickup.submittedValues?.containerId === "cont-w2")
    .map((pickup) => pickup.status),
  ["Skipped"],
)

/* ----------------------------- deviation remap ---------------------------- */

const wedDeviation: ApprovedDeviation = {
  name: "Roadworks week 36",
  originalDate: WED,
  replacementDate: "2026-09-03",
  reason: "Blocked street access",
}
const deviationPlan = planSchemeGeneration({
  scheme,
  window: WINDOW,
  existingRoutes: [],
  deviations: [wedDeviation],
})
const deviatedWed = deviationPlan?.routes.find((route) => route.serviceDate === WED)
check(
  "an approved deviation remaps the operating date, identity keeps the service date",
  [deviatedWed?.actualDate, deviatedWed?.serviceDate, deviatedWed?.routeId],
  ["2026-09-03", WED, generatedRouteId(scheme.id, WED)],
)
const deviationApplied = deviationPlan
  ? applySchemeGeneration({
      plan: deviationPlan,
      existingPickups: [],
      containers,
      actorName: "Planner",
    })
  : null
const deviatedRoute = deviationApplied?.routes.find(
  (route) => route.submittedValues?.serviceDate === WED,
)
check(
  "the generated route carries a visible deviation note",
  deviatedRoute?.facts.Deviation,
  `Moved from ${formatServiceDate(WED)} · Blocked street access`,
)
check(
  "the deviated route operates on the replacement date",
  deviatedRoute?.submittedValues?.actualDate,
  "2026-09-03",
)

/* --------------------- deviation scope matching (FR-10) ------------------- */

const otherProjectDeviation: ApprovedDeviation = {
  ...wedDeviation,
  projectIds: ["project-harbor"],
}
check(
  "a deviation scoped to another project does not remap",
  planSchemeGeneration({
    scheme,
    window: WINDOW,
    existingRoutes: [],
    deviations: [otherProjectDeviation],
  })?.routes.find((route) => route.serviceDate === WED)?.actualDate,
  WED,
)
check(
  "a deviation sharing the scheme's project remaps",
  planSchemeGeneration({
    scheme,
    window: WINDOW,
    existingRoutes: [],
    deviations: [{ ...wedDeviation, projectIds: ["project-central"] }],
  })?.routes.find((route) => route.serviceDate === WED)?.actualDate,
  "2026-09-03",
)
check(
  "a deviation without recorded scope applies project-wide",
  planSchemeGeneration({
    scheme,
    window: WINDOW,
    existingRoutes: [],
    deviations: [wedDeviation],
  })?.routes.find((route) => route.serviceDate === WED)?.actualDate,
  "2026-09-03",
)

/* ---------------------- approvedDeviationsFromRecords --------------------- */

const deviationRecord = (
  id: string,
  status: string,
  facts: Record<string, string>,
): BusinessRecord => ({
  id,
  name: id,
  context: "",
  status,
  owner: "",
  value: "",
  updated: "",
  description: "",
  facts,
  related: [],
  source: "",
  freshness: "",
})

check(
  "reads approved and notified deviations, parses fact dates",
  approvedDeviationsFromRecords([
    deviationRecord("dev-approved", "Approved", {
      "Original date": "24 Dec 2026",
      "Replacement date": "27 Dec 2026",
      Reason: "Public holiday",
    }),
    deviationRecord("dev-notified", "Notified", {
      "Original date": "26 Dec 2026",
      "Replacement date": "28 Dec 2026",
      Reason: "Public holiday",
    }),
    deviationRecord("dev-draft", "Draft", {
      "Original date": "3 Sep 2026",
      "Replacement date": "4 Sep 2026",
      Reason: "Roadworks",
    }),
    deviationRecord("dev-cancelled", "Cancelled", {
      "Original date": "1 Sep 2026",
      "Replacement date": "2 Sep 2026",
      Reason: "Withdrawn",
    }),
  ]).map((deviation) => [deviation.originalDate, deviation.replacementDate]),
  [
    ["2026-12-24", "2026-12-27"],
    ["2026-12-26", "2026-12-28"],
  ],
)

check(
  "prefers ISO dates in submittedValues over fact text",
  approvedDeviationsFromRecords([
    {
      ...deviationRecord("dev-form", "Approved", { Reason: "Holiday" }),
      submittedValues: { originalDate: "2026-09-02", replacementDate: "2026-09-03" },
    },
  ]).map((deviation) => [deviation.originalDate, deviation.replacementDate, deviation.reason]),
  [["2026-09-02", "2026-09-03", "Holiday"]],
)

/* --------------------------- recurrence boundaries ------------------------ */

check(
  "a window past the effective-to date plans nothing",
  planSchemeGeneration({
    scheme,
    window: { from: "2027-01-05", to: "2027-01-11" },
    existingRoutes: [],
    deviations: [],
  })?.routes.length,
  0,
)

check(
  "a scheme without structured recurrence cannot plan",
  planSchemeGeneration({
    scheme: { ...scheme, submittedValues: undefined },
    window: WINDOW,
    existingRoutes: [],
    deviations: [],
  }),
  null,
)

/* --------------------------------- result --------------------------------- */

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
