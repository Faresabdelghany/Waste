// Headless checks for manual route generation (spec FR-6–FR-10, ticket #7):
// window enumeration, deterministic route identity, the upsert rules
// (create / refresh / skip / cancel), deviation remap, version pinning,
// overridden-assignment preservation, and pickup building.
// Run: npx tsx scripts/route-scheme-generation-harness.ts
import type { BusinessRecord } from "../lib/data/business-modules"
import type { CollectionCalendar } from "../lib/route-schemes/calendar"
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
  { created: 2, refreshed: 0, cancelled: 0, skipped: 0, calendarSkipped: 0, pickups: 3 },
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

/* -------------------- calendar consultation (Q2/Q6/Q7) -------------------- */

const allDays = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const

const baseCalendar: CollectionCalendar = {
  id: "calendar-central",
  name: "Copenhagen Central 2026",
  status: "Active",
  workingDays: [...allDays],
  holidayDates: [],
  validFrom: "2026-01-01",
  validTo: "2026-12-31",
}

// Holiday: the Wednesday is a holiday → no route, preview-visible omit row.
const holidayPlan = planSchemeGeneration({
  scheme,
  window: WINDOW,
  existingRoutes: [],
  deviations: [],
  calendar: { ...baseCalendar, holidayDates: [WED] },
})
check(
  "a holiday date becomes an omit row with the reason, other dates create",
  holidayPlan?.routes.map((route) => [route.serviceDate, route.action, route.note ?? ""]),
  [
    [WED, "omit", "Holiday on Copenhagen Central 2026"],
    [SUN, "create", ""],
  ],
)
const holidayApplied = holidayPlan
  ? applySchemeGeneration({
      plan: holidayPlan,
      existingPickups: [],
      containers,
      actorName: "Planner",
    })
  : null
check(
  "a holiday omit writes no route and is counted as calendar-skipped",
  [
    holidayApplied?.routes.map((route) => route.submittedValues?.serviceDate),
    holidayApplied?.summary.created,
    holidayApplied?.summary.calendarSkipped,
  ],
  [[SUN], 1, 1],
)

// Non-working weekday: Sunday outside Mon–Fri working days → skipped.
check(
  "a non-working service day is skipped with the reason",
  planSchemeGeneration({
    scheme,
    window: WINDOW,
    existingRoutes: [],
    deviations: [],
    calendar: {
      ...baseCalendar,
      workingDays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
    },
  })?.routes.map((route) => [route.serviceDate, route.action, route.note ?? ""]),
  [
    [WED, "create", ""],
    [SUN, "omit", "Not a working day on Copenhagen Central 2026"],
  ],
)

// Deviation precedence: an approved deviation relocates a holiday's service.
check(
  "an approved deviation outranks the holiday skip and remaps the date",
  planSchemeGeneration({
    scheme,
    window: WINDOW,
    existingRoutes: [],
    deviations: [wedDeviation],
    calendar: { ...baseCalendar, holidayDates: [WED] },
  })?.routes.find((route) => route.serviceDate === WED)?.actualDate,
  "2026-09-03",
)

// Replacement lands on a holiday: honored, but flagged.
check(
  "a replacement date on a holiday generates with a calendar warning",
  planSchemeGeneration({
    scheme,
    window: WINDOW,
    existingRoutes: [],
    deviations: [wedDeviation],
    calendar: { ...baseCalendar, holidayDates: ["2026-09-03"] },
  })?.routes.find((route) => route.serviceDate === WED)?.calendarWarning,
  "Replacement date is a holiday on Copenhagen Central 2026",
)

// Uncovered dates: outside validity → generate, warn, never skip (Q6).
check(
  "dates outside calendar validity generate with a warning, not a skip",
  planSchemeGeneration({
    scheme,
    window: WINDOW,
    existingRoutes: [],
    deviations: [],
    calendar: { ...baseCalendar, validTo: "2026-09-03" },
  })?.routes.map((route) => [route.serviceDate, route.action, route.calendarWarning ?? ""]),
  [
    [WED, "create", ""],
    [SUN, "create", "Outside Copenhagen Central 2026 validity — calendar rules not applied"],
  ],
)

// A previously generated still-Planned route on a now-holiday date is cancelled.
const plannedOnHoliday: BusinessRecord = {
  id: generatedRouteId(scheme.id, WED),
  name: generatedRouteName(scheme.id, WED),
  context: "",
  status: "Planned",
  owner: "Mads Jensen",
  value: "2 stops",
  updated: "",
  description: "",
  facts: { Vehicle: "WH-24", Driver: "Mads Jensen" },
  related: [],
  source: "",
  freshness: "",
  submittedValues: {
    schemeId: scheme.id,
    serviceDate: WED,
    actualDate: WED,
    appliedVehicle: "WH-24",
    appliedDriver: "Mads Jensen",
  },
}
const holidayCancelPlan = planSchemeGeneration({
  scheme,
  window: WINDOW,
  existingRoutes: [plannedOnHoliday],
  deviations: [],
  calendar: { ...baseCalendar, holidayDates: [WED] },
})
check(
  "a still-Planned route on a now-holiday date is cancelled with the reason",
  holidayCancelPlan?.routes.find((route) => route.serviceDate === WED)?.action,
  "cancel",
)
check(
  "the holiday cancel is written and counted",
  holidayCancelPlan
    ? applySchemeGeneration({
        plan: holidayCancelPlan,
        existingPickups: [],
        containers,
        actorName: "Planner",
      }).summary.cancelled
    : null,
  1,
)
check(
  "an already-executing route on a holiday date is left untouched",
  planSchemeGeneration({
    scheme,
    window: WINDOW,
    existingRoutes: [{ ...plannedOnHoliday, status: "Active" }],
    deviations: [],
    calendar: { ...baseCalendar, holidayDates: [WED] },
  })?.routes.find((route) => route.serviceDate === WED)?.action,
  "skip",
)

// Idempotency with a calendar: re-planning against the produced routes
// refreshes instead of duplicating, and the omit stays an omit.
const idemFirst = planSchemeGeneration({
  scheme,
  window: WINDOW,
  existingRoutes: [],
  deviations: [],
  calendar: { ...baseCalendar, holidayDates: [WED] },
})
const idemWritten = idemFirst
  ? applySchemeGeneration({
      plan: idemFirst,
      existingPickups: [],
      containers,
      actorName: "Planner",
    })
  : null
check(
  "regeneration with a calendar refreshes instead of duplicating",
  planSchemeGeneration({
    scheme,
    window: WINDOW,
    existingRoutes: idemWritten?.routes ?? [],
    deviations: [],
    calendar: { ...baseCalendar, holidayDates: [WED] },
  })?.routes.map((route) => [route.serviceDate, route.action]),
  [
    [WED, "omit"],
    [SUN, "refresh"],
  ],
)

/* -------------------- deviation scope semantics (Q8/Q13) ------------------ */

check(
  "a customer-scoped deviation never remaps route generation",
  planSchemeGeneration({
    scheme,
    window: WINDOW,
    existingRoutes: [],
    deviations: [{ ...wedDeviation, scopeType: "customer" }],
  })?.routes.find((route) => route.serviceDate === WED)?.actualDate,
  WED,
)

check(
  "a scheme-scoped deviation remaps only its exact scheme",
  planSchemeGeneration({
    scheme,
    window: WINDOW,
    existingRoutes: [],
    deviations: [{ ...wedDeviation, scopeType: "scheme", schemeId: scheme.id }],
  })?.routes.find((route) => route.serviceDate === WED)?.actualDate,
  "2026-09-03",
)

check(
  "a scheme-scoped deviation for another scheme has no effect",
  planSchemeGeneration({
    scheme,
    window: WINDOW,
    existingRoutes: [],
    deviations: [
      { ...wedDeviation, scopeType: "scheme", schemeId: "some-other-scheme" },
    ],
  })?.routes.find((route) => route.serviceDate === WED)?.actualDate,
  WED,
)

check(
  "a scheme-scoped deviation with no schemeId never falls back to project-wide",
  planSchemeGeneration({
    scheme,
    window: WINDOW,
    existingRoutes: [],
    deviations: [{ ...wedDeviation, scopeType: "scheme" }],
  })?.routes.find((route) => route.serviceDate === WED)?.actualDate,
  WED,
)

const schemeOnCentralCalendar: BusinessRecord = {
  ...scheme,
  submittedValues: { ...scheme.submittedValues, calendarId: "calendar-central" },
}

check(
  "a deviation on the scheme's calendar remaps",
  planSchemeGeneration({
    scheme: schemeOnCentralCalendar,
    window: WINDOW,
    existingRoutes: [],
    deviations: [{ ...wedDeviation, calendarId: "calendar-central" }],
  })?.routes.find((route) => route.serviceDate === WED)?.actualDate,
  "2026-09-03",
)

check(
  "a deviation on a different calendar never remaps, even with matching projects",
  planSchemeGeneration({
    scheme: schemeOnCentralCalendar,
    window: WINDOW,
    existingRoutes: [],
    deviations: [
      {
        ...wedDeviation,
        calendarId: "calendar-harbor",
        projectIds: ["project-central"],
      },
    ],
  })?.routes.find((route) => route.serviceDate === WED)?.actualDate,
  WED,
)

check(
  "a deviation with a calendar does not affect a scheme without one",
  planSchemeGeneration({
    scheme,
    window: WINDOW,
    existingRoutes: [],
    deviations: [{ ...wedDeviation, calendarId: "calendar-central" }],
  })?.routes.find((route) => route.serviceDate === WED)?.actualDate,
  WED,
)

check(
  "a legacy deviation without calendarId keeps project-overlap behavior",
  planSchemeGeneration({
    scheme: schemeOnCentralCalendar,
    window: WINDOW,
    existingRoutes: [],
    deviations: [{ ...wedDeviation, projectIds: ["project-central"] }],
  })?.routes.find((route) => route.serviceDate === WED)?.actualDate,
  "2026-09-03",
)

check(
  "approvedDeviationsFromRecords reads calendar, scope, and scheme from submittedValues",
  approvedDeviationsFromRecords([
    {
      ...deviationRecord("dev-scoped", "Approved", { Reason: "Roadworks" }),
      submittedValues: {
        originalDate: "2026-09-02",
        replacementDate: "2026-09-03",
        calendarId: "calendar-central",
        scopeType: "scheme",
        schemeId: "schemes-route-scheme-777",
      },
    },
  ]).map((deviation) => [
    deviation.calendarId,
    deviation.scopeType,
    deviation.schemeId,
  ]),
  [["calendar-central", "scheme", "schemes-route-scheme-777"]],
)

/* ---------------- review fixes: resurrect, tie-break, walk cap ------------- */

// A generation-authored cancel is bookkeeping: once a deviation relocates the
// holiday, the route is re-created instead of staying a dead tombstone.
const tombstoneRun = holidayCancelPlan
  ? applySchemeGeneration({
      plan: holidayCancelPlan,
      existingPickups: [],
      containers,
      actorName: "Planner",
    })
  : null
const tombstone = tombstoneRun?.routes.find(
  (route) => route.submittedValues?.serviceDate === WED,
)
check(
  "a generation-authored cancel carries the bookkeeping marker",
  tombstone?.submittedValues?.cancelledByGeneration,
  true,
)
const resurrectPlan = planSchemeGeneration({
  scheme,
  window: WINDOW,
  existingRoutes: tombstone ? [tombstone] : [],
  deviations: [wedDeviation],
  calendar: { ...baseCalendar, holidayDates: [WED] },
})
check(
  "an approved deviation resurrects a calendar-cancelled route",
  [
    resurrectPlan?.routes.find((route) => route.serviceDate === WED)?.action,
    resurrectPlan?.routes.find((route) => route.serviceDate === WED)?.actualDate,
  ],
  ["create", "2026-09-03"],
)
check(
  "removing the holiday also resurrects the cancelled route",
  planSchemeGeneration({
    scheme,
    window: WINDOW,
    existingRoutes: tombstone ? [tombstone] : [],
    deviations: [],
    calendar: baseCalendar,
  })?.routes.find((route) => route.serviceDate === WED)?.action,
  "create",
)
check(
  "an operational cancel (no marker) is never resurrected",
  planSchemeGeneration({
    scheme,
    window: WINDOW,
    existingRoutes: [
      {
        ...plannedOnHoliday,
        status: "Cancelled",
      },
    ],
    deviations: [wedDeviation],
  })?.routes.find((route) => route.serviceDate === WED)?.action,
  "skip",
)

// Skip rows are display-only: they show where the stored route operates, not
// where a deviation would move a route generation never writes.
check(
  "a skip row keeps the stored operating date despite a matching deviation",
  planSchemeGeneration({
    scheme,
    window: WINDOW,
    existingRoutes: [{ ...plannedOnHoliday, status: "Active" }],
    deviations: [wedDeviation],
  })?.routes.find((route) => route.serviceDate === WED)?.actualDate,
  WED,
)
check(
  "a calendar-branch skip row still shows the day's planned stops",
  planSchemeGeneration({
    scheme,
    window: WINDOW,
    existingRoutes: [{ ...plannedOnHoliday, status: "Active" }],
    deviations: [],
    calendar: { ...baseCalendar, holidayDates: [WED] },
  })?.routes.find((route) => route.serviceDate === WED)?.containerIds,
  ["cont-w1", "cont-w2"],
)

// Deterministic tie-break: scheme scope beats project scope regardless of order.
const projectWide: ApprovedDeviation = {
  ...wedDeviation,
  name: "A project-wide",
  replacementDate: "2026-09-04",
  projectIds: ["project-central"],
}
const schemeScoped: ApprovedDeviation = {
  ...wedDeviation,
  name: "Z scheme-scoped",
  replacementDate: "2026-09-05",
  scopeType: "scheme",
  schemeId: scheme.id,
}
check(
  "with several matching deviations the scheme-scoped one wins, in either order",
  [
    planSchemeGeneration({
      scheme,
      window: WINDOW,
      existingRoutes: [],
      deviations: [projectWide, schemeScoped],
    })?.routes.find((route) => route.serviceDate === WED)?.actualDate,
    planSchemeGeneration({
      scheme,
      window: WINDOW,
      existingRoutes: [],
      deviations: [schemeScoped, projectWide],
    })?.routes.find((route) => route.serviceDate === WED)?.actualDate,
  ],
  ["2026-09-05", "2026-09-05"],
)

// The date walk caps at 367 days; cleanup must never judge routes beyond it.
const farFutureMonday = "2027-06-07"
check(
  "an over-long window never cancels still-served routes past the walk cap",
  planSchemeGeneration({
    scheme: {
      ...scheme,
      submittedValues: {
        ...scheme.submittedValues,
        serviceDays: "monday",
        effectiveTo: "2027-12-31",
      },
    },
    window: { from: "2026-01-01", to: "2027-12-31" },
    existingRoutes: [
      {
        ...plannedOnHoliday,
        id: generatedRouteId(scheme.id, farFutureMonday),
        submittedValues: {
          ...plannedOnHoliday.submittedValues,
          serviceDate: farFutureMonday,
          actualDate: farFutureMonday,
        },
      },
    ],
    deviations: [],
  })?.routes.filter((route) => route.action === "cancel").length,
  0,
)

/* --------------------------------- result --------------------------------- */

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
