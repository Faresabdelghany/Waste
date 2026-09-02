// Headless checks for manual route generation (spec FR-6–FR-10, ticket #7):
// window enumeration, deterministic route identity, the upsert rules
// (create / refresh / skip / cancel), calendar skips, version pinning,
// overridden-assignment preservation, and pickup building.
// Run: npx tsx scripts/route-scheme-generation-harness.ts
import type { BusinessRecord } from "../lib/data/business-modules"
import type { CollectionCalendar } from "../lib/route-schemes/calendar"
import { initialGenerationWindow } from "../lib/route-schemes/creation"
import { formatServiceDate } from "../lib/route-schemes/recurrence"
import {
  applySchemeGeneration,
  generatedRouteId,
  generatedRouteName,
  planSchemeGeneration,
  schemePlannedStartTime,
  schemeVersionOf,
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
  containers: [],
  scheme,
  window: WINDOW,
  existingRoutes: [],
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
check("generated routes stamp the Deviation fact as None", wedRoute?.facts.Deviation, "None")
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
  containers: [],
  scheme,
  window: WINDOW,
  existingRoutes: applied?.routes ?? [],
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
  containers: [],
  scheme,
  window: WINDOW,
  existingRoutes: [overriddenWed, ...(applied?.routes.filter((r) => r.id !== overriddenWed.id) ?? [])],
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
  containers: [],
  scheme,
  window: WINDOW,
  existingRoutes: [activeWed],
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
  containers: [],
  scheme: wedOnlyScheme,
  window: WINDOW,
  existingRoutes: applied?.routes ?? [],
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
  containers: [],
  scheme: wedOnlyScheme,
  window: WINDOW,
  existingRoutes: [completedSun],
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
  containers: [],
  scheme: shrunkScheme,
  window: WINDOW,
  existingRoutes: applied?.routes ?? [],
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

/* --------------------------- recurrence boundaries ------------------------ */

check(
  "a window past the effective-to date plans nothing",
  planSchemeGeneration({
    containers: [],
    scheme,
    window: { from: "2027-01-05", to: "2027-01-11" },
    existingRoutes: [],
  })?.routes.length,
  0,
)

check(
  "a scheme without structured recurrence cannot plan",
  planSchemeGeneration({
    containers: [],
    scheme: { ...scheme, submittedValues: undefined },
    window: WINDOW,
    existingRoutes: [],
  }),
  null,
)

// Expiry bound (issue #34, D32): a window straddling effectiveTo (2026-12-31)
// creates routes only up to it — Wed 30 Dec is served, Sun 3 Jan 2027 is not —
// so no generated route can ever carry a service date after effectiveTo.
const straddling = planSchemeGeneration({
  containers: [],
  scheme,
  window: { from: "2026-12-28", to: "2027-01-06" },
  existingRoutes: [],
})
check(
  "expiry bound: a window straddling effectiveTo creates nothing past it",
  straddling?.routes
    .filter((route) => route.action === "create")
    .map((route) => route.serviceDate),
  ["2026-12-30"],
)
check(
  "expiry bound: no planned row at all carries a service date after effectiveTo",
  straddling?.routes.every((route) => route.serviceDate <= "2026-12-31"),
  true,
)

// A Planned route generation once wrote for a date now past a shortened
// effectiveTo is cancelled with the resurrection marker; an Active one is
// operational history and is only skipped. The in-period route refreshes.
const shortenedScheme: BusinessRecord = {
  ...scheme,
  submittedValues: { ...scheme.submittedValues, effectiveTo: "2026-09-03" },
}
const shortenedPlan = planSchemeGeneration({
  containers: [],
  scheme: shortenedScheme,
  window: WINDOW,
  existingRoutes: applied?.routes ?? [],
})
check(
  "expiry bound: a Planned route past the shortened effectiveTo is cancelled, the in-period one refreshed",
  shortenedPlan?.routes.map((route) => [route.serviceDate, route.action]),
  [
    [WED, "refresh"],
    [SUN, "cancel"],
  ],
)
check(
  "expiry bound: the cancel past effectiveTo carries the resurrection marker",
  shortenedPlan
    ? applySchemeGeneration({
        plan: shortenedPlan,
        existingPickups: [],
        containers: [],
        actorName: "Planner",
      }).routes.map((route) => [
        route.submittedValues?.serviceDate,
        route.status,
        route.submittedValues?.cancelledByGeneration ?? false,
      ])
    : null,
  [
    [WED, "Planned", false],
    [SUN, "Cancelled", true],
  ],
)
check(
  "expiry bound: an Active route past effectiveTo is operational history — skipped, never cancelled",
  planSchemeGeneration({
    containers: [],
    scheme: shortenedScheme,
    window: WINDOW,
    existingRoutes: (applied?.routes ?? []).map((route) =>
      route.submittedValues?.serviceDate === SUN
        ? { ...route, status: "Active" }
        : route,
    ),
  })?.routes.map((route) => [route.serviceDate, route.action]),
  [[WED, "refresh"]],
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
  containers: [],
  scheme,
  window: WINDOW,
  existingRoutes: [],
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
    containers: [],
    scheme,
    window: WINDOW,
    existingRoutes: [],
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

// Uncovered dates: outside validity → generate, warn, never skip (Q6).
check(
  "dates outside calendar validity generate with a warning, not a skip",
  planSchemeGeneration({
    containers: [],
    scheme,
    window: WINDOW,
    existingRoutes: [],
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
  containers: [],
  scheme,
  window: WINDOW,
  existingRoutes: [plannedOnHoliday],
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
    containers: [],
    scheme,
    window: WINDOW,
    existingRoutes: [{ ...plannedOnHoliday, status: "Active" }],
    calendar: { ...baseCalendar, holidayDates: [WED] },
  })?.routes.find((route) => route.serviceDate === WED)?.action,
  "skip",
)

// Idempotency with a calendar: re-planning against the produced routes
// refreshes instead of duplicating, and the omit stays an omit.
const idemFirst = planSchemeGeneration({
  containers: [],
  scheme,
  window: WINDOW,
  existingRoutes: [],
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
    containers: [],
    scheme,
    window: WINDOW,
    existingRoutes: idemWritten?.routes ?? [],
    calendar: { ...baseCalendar, holidayDates: [WED] },
  })?.routes.map((route) => [route.serviceDate, route.action]),
  [
    [WED, "omit"],
    [SUN, "refresh"],
  ],
)

/* --------------------- review fixes: resurrect, walk cap ------------------- */

// A generation-authored cancel is bookkeeping: once the holiday leaves the
// calendar, the route is re-created instead of staying a dead tombstone.
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
check(
  "removing the holiday also resurrects the cancelled route",
  planSchemeGeneration({
    containers: [],
    scheme,
    window: WINDOW,
    existingRoutes: tombstone ? [tombstone] : [],
    calendar: baseCalendar,
  })?.routes.find((route) => route.serviceDate === WED)?.action,
  "create",
)
check(
  "an operational cancel (no marker) is never resurrected",
  planSchemeGeneration({
    containers: [],
    scheme,
    window: WINDOW,
    existingRoutes: [
      {
        ...plannedOnHoliday,
        status: "Cancelled",
      },
    ],
  })?.routes.find((route) => route.serviceDate === WED)?.action,
  "skip",
)

check(
  "a calendar-branch skip row still shows the day's planned stops",
  planSchemeGeneration({
    containers: [],
    scheme,
    window: WINDOW,
    existingRoutes: [{ ...plannedOnHoliday, status: "Active" }],
    calendar: { ...baseCalendar, holidayDates: [WED] },
  })?.routes.find((route) => route.serviceDate === WED)?.containerIds,
  ["cont-w1", "cont-w2"],
)

// The date walk caps at 367 days; cleanup must never judge routes beyond it.
const farFutureMonday = "2027-06-07"
check(
  "an over-long window never cancels still-served routes past the walk cap",
  planSchemeGeneration({
    containers: [],
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
  })?.routes.filter((route) => route.action === "cancel").length,
  0,
)

/* ------------- optional effectiveTo + initial window (issue #28) ----------- */
// D23: an omitted effectiveTo means open-ended — generation plans normally.
// D24: the creation path's initial window is max(today, effectiveFrom) + 7
// days, resolved by initialGenerationWindow and fed to this same engine.

const openEndedScheme: BusinessRecord = {
  ...scheme,
  submittedValues: { ...scheme.submittedValues, effectiveTo: "" },
}
check(
  "open-ended scheme (no effectiveTo) plans the window's service dates",
  planSchemeGeneration({
    scheme: openEndedScheme,
    window: WINDOW,
    existingRoutes: [],
    containers,
  })?.routes.map((planned) => [planned.action, planned.serviceDate]),
  [
    ["create", WED],
    ["create", SUN],
  ],
)
check(
  "open-ended scheme still generates far in the future",
  planSchemeGeneration({
    scheme: openEndedScheme,
    window: { from: "2030-09-02", to: "2030-09-08" },
    existingRoutes: [],
    containers,
  })?.routes.map((planned) => planned.serviceDate),
  ["2030-09-04", "2030-09-08"],
)

check(
  "initial window feeds the engine: past effectiveFrom starts at today",
  planSchemeGeneration({
    scheme: openEndedScheme,
    window: initialGenerationWindow("2026-09-01", "2026-08-01"),
    existingRoutes: [],
    containers,
  })?.routes.map((planned) => planned.serviceDate),
  // 2026-09-01 → 2026-09-08 serves Wed 2 Sep and Sun 6 Sep.
  [WED, SUN],
)

/* ------------------- planned start time (issue #32) ----------------------- */

// A scheme WITH a planned start time stamps it as the routes' estimated start.
check(
  "planned start time flows into the route's Time window and pickup schedule",
  [
    wedRoute?.facts["Time window"]?.startsWith("06:30–"),
    wedPickups?.[0]?.facts.Scheduled,
    wedPickups?.[0]?.value,
  ],
  [true, "06:30", "06:30 · Scheduled"],
)

// A legacy scheme WITHOUT one generates routes with no estimated start at all —
// the old hard-coded 06:00 fallback is removed (issue #32).
const noStartTimeScheme: BusinessRecord = {
  ...scheme,
  facts: Object.fromEntries(
    Object.entries(scheme.facts).filter(([key]) => key !== "Planned start"),
  ),
  submittedValues: { ...scheme.submittedValues, plannedStartTime: "" },
}
const noStartTimePlan = planSchemeGeneration({
  scheme: noStartTimeScheme,
  window: WINDOW,
  existingRoutes: [],
  containers,
})
const noStartTimeApplied = noStartTimePlan
  ? applySchemeGeneration({
      plan: noStartTimePlan,
      existingPickups: [],
      containers,
      actorName: "Planner",
    })
  : null
const noStartWedRoute = noStartTimeApplied?.routes.find(
  (route) => route.submittedValues?.serviceDate === WED,
)
check(
  "no planned start time → route carries no Time window fact (no 06:00 fallback)",
  ["Time window" in (noStartWedRoute?.facts ?? {}), noStartWedRoute?.status],
  [false, "Planned"],
)
check(
  "no planned start time → pickups carry no scheduled times",
  noStartTimeApplied?.pickups.map((pickup) => [
    "Scheduled" in pickup.facts,
    pickup.value,
  ]),
  [
    [false, "Scheduled"],
    [false, "Scheduled"],
    [false, "Scheduled"],
  ],
)
// The shared resolution (schemePlannedStartTime): values win over the fact,
// both trimmed, whitespace and the "—" placeholder count as absent.
check(
  "schemePlannedStartTime: values over fact, trimmed, whitespace absent",
  [
    schemePlannedStartTime(scheme),
    schemePlannedStartTime({
      ...noStartTimeScheme,
      facts: { ...noStartTimeScheme.facts, "Planned start": " 07:00 " },
    }),
    schemePlannedStartTime({
      ...noStartTimeScheme,
      submittedValues: { ...noStartTimeScheme.submittedValues, plannedStartTime: "  " },
    }),
  ],
  ["06:30", "07:00", undefined],
)

// A "—" display placeholder that leaked into a stored fact is not a time.
const dashStartPlan = planSchemeGeneration({
  scheme: {
    ...noStartTimeScheme,
    facts: { ...noStartTimeScheme.facts, "Planned start": "—" },
  },
  window: WINDOW,
  existingRoutes: [],
  containers,
})
const dashStartApplied = dashStartPlan
  ? applySchemeGeneration({
      plan: dashStartPlan,
      existingPickups: [],
      containers,
      actorName: "Planner",
    })
  : null
check(
  "a '—' Planned start fact is treated as absent",
  [
    dashStartApplied !== null,
    "Time window" in (dashStartApplied?.routes[0]?.facts ?? {}),
  ],
  [true, false],
)

/* --------------------------------- result --------------------------------- */

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
