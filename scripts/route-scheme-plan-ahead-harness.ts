// Headless checks for Plan Ahead auto-generation (spec FR-11, ticket #8):
// the rolling 7-day window, the enable/disable toggle payload, eligibility
// (status Validated-or-later, structured recurrence, effective-window
// overlap), and the auto-run itself — same engine and idempotency rules as
// manual generation, so repeated runs never duplicate.
// Run: npx tsx scripts/route-scheme-plan-ahead-harness.ts
import type { BusinessRecord } from "../lib/data/business-modules"
import {
  isPlanAheadEnabled,
  planAheadWindow,
  runPlanAhead,
  schemeAutoGenerates,
  setPlanAhead,
} from "../lib/route-schemes/plan-ahead"

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

// "Today" is Tue 2026-09-01 → Plan Ahead window Wed 2026-09-02 … Tue 2026-09-08,
// which contains Wed 2026-09-02 and Sun 2026-09-06 for a Wed+Sun scheme.
const TODAY = "2026-09-01"
const WED = "2026-09-02"
const SUN = "2026-09-06"

function makeScheme(overrides: {
  id: string
  status: string
  planAhead?: string | boolean
  effectiveFrom?: string
  effectiveTo?: string
}): BusinessRecord {
  return {
    id: overrides.id,
    name: `Scheme ${overrides.id}`,
    context: "Copenhagen Central · Indre By",
    status: overrides.status,
    owner: "Planner",
    value: "3 planned stops",
    updated: "Now",
    description: "",
    facts: {
      Version: "v2",
      Project: "Copenhagen Central",
      Vehicle: "WH-24",
      Driver: "Mads Jensen",
      "Planned start": "06:30",
    },
    related: [],
    source: "Office workspace",
    freshness: "Now",
    companyId: "company-wastehero",
    projectIds: ["project-central"],
    recordKind: "Route Scheme",
    submittedValues: {
      schemeName: `Scheme ${overrides.id}`,
      frequency: "weekly",
      serviceDays: "wednesday, sunday",
      effectiveFrom: overrides.effectiveFrom ?? "2026-08-01",
      effectiveTo: overrides.effectiveTo ?? "2026-12-31",
      plannedStartTime: "06:30",
      sameAllDays: false,
      containersByDay: JSON.stringify({
        wednesday: ["cont-w1", "cont-w2"],
        sunday: ["cont-s1"],
      }),
      ...(overrides.planAhead === undefined
        ? {}
        : { planAhead: overrides.planAhead }),
    },
  }
}

const containers: BusinessRecord[] = ["cont-w1", "cont-w2", "cont-s1"].map(
  (id, index) => ({
    id,
    name: `BIN-3000${index + 1}`,
    context: "Container",
    status: "Active",
    owner: "",
    value: "",
    updated: "",
    description: "",
    facts: {
      Address: `Adelgade ${index + 1}, 1304 København K`,
      "Container type": "660L container",
      "Waste fractions": index < 2 ? "Residual" : "Glass",
    },
    related: [],
    source: "",
    freshness: "",
  }),
)

/* ------------------------------ window ----------------------------------- */

check("window starts tomorrow", planAheadWindow(TODAY), {
  from: "2026-09-02",
  to: "2026-09-08",
})
check("window crosses a month boundary", planAheadWindow("2026-08-28"), {
  from: "2026-08-29",
  to: "2026-09-04",
})

/* ------------------------------ toggle ----------------------------------- */

const plain = makeScheme({ id: "s-plain", status: "Validated" })
check("no flag → disabled", isPlanAheadEnabled(plain), false)
check(
  "string flag → enabled",
  isPlanAheadEnabled(makeScheme({ id: "s", status: "Validated", planAhead: "true" })),
  true,
)
const enabled = setPlanAhead(plain, true)
check("setPlanAhead(true) enables", isPlanAheadEnabled(enabled), true)
check("setPlanAhead(true) writes the fact", enabled.facts["Plan ahead"], "On")
check(
  "setPlanAhead(false) disables",
  isPlanAheadEnabled(setPlanAhead(enabled, false)),
  false,
)
check(
  "setPlanAhead(false) writes the fact",
  setPlanAhead(enabled, false).facts["Plan ahead"],
  "Off",
)
check("setPlanAhead leaves the input untouched", isPlanAheadEnabled(plain), false)
check(
  "setPlanAhead keeps other submitted values",
  enabled.submittedValues?.frequency,
  "weekly",
)

/* ---------------------------- eligibility -------------------------------- */

const eligible = makeScheme({ id: "s-on", status: "Validated", planAhead: true })
check("enabled Validated scheme runs", schemeAutoGenerates(eligible, TODAY), true)
check(
  "Scheduled runs",
  schemeAutoGenerates(
    makeScheme({ id: "s", status: "Scheduled", planAhead: true }),
    TODAY,
  ),
  true,
)
check(
  "Effective runs",
  schemeAutoGenerates(
    makeScheme({ id: "s", status: "Effective", planAhead: true }),
    TODAY,
  ),
  true,
)
check("disabled scheme never runs", schemeAutoGenerates(plain, TODAY), false)
check(
  "Draft never runs even when enabled",
  schemeAutoGenerates(makeScheme({ id: "s", status: "Draft", planAhead: true }), TODAY),
  false,
)
check(
  "Expired never runs",
  schemeAutoGenerates(
    makeScheme({ id: "s", status: "Expired", planAhead: true }),
    TODAY,
  ),
  false,
)
check(
  "Validation issue never runs",
  schemeAutoGenerates(
    makeScheme({ id: "s", status: "Validation issue", planAhead: true }),
    TODAY,
  ),
  false,
)
check(
  "scheme starting after the window never runs",
  schemeAutoGenerates(
    makeScheme({
      id: "s",
      status: "Validated",
      planAhead: true,
      effectiveFrom: "2026-10-01",
    }),
    TODAY,
  ),
  false,
)
check(
  "scheme ended before the window never runs",
  schemeAutoGenerates(
    makeScheme({
      id: "s",
      status: "Validated",
      planAhead: true,
      effectiveFrom: "2026-06-01",
      effectiveTo: "2026-08-31",
    }),
    TODAY,
  ),
  false,
)
check(
  "scheme starting mid-window runs",
  schemeAutoGenerates(
    makeScheme({
      id: "s",
      status: "Validated",
      planAhead: true,
      effectiveFrom: "2026-09-05",
    }),
    TODAY,
  ),
  true,
)
check(
  "legacy scheme without structured recurrence never runs",
  schemeAutoGenerates(
    {
      ...makeScheme({ id: "s", status: "Effective", planAhead: true }),
      submittedValues: { planAhead: true },
    },
    TODAY,
  ),
  false,
)

/* ------------------------------ auto-run --------------------------------- */

const firstRun = runPlanAhead({
  schemes: [eligible, plain, makeScheme({ id: "s-draft", status: "Draft", planAhead: true })],
  today: TODAY,
  existingRoutes: [],
  existingPickups: [],
  deviationRecords: [],
  containers,
  actorName: "Plan Ahead",
})
check("first run creates one route per service day", firstRun.summary.created, 2)
check("first run touches only the eligible scheme", firstRun.summary.schemes, 1)
check(
  "first run writes the service dates",
  firstRun.routes.map((route) => route.submittedValues?.serviceDate).sort(),
  [WED, SUN].sort(),
)
check("first run builds one pickup per container", firstRun.summary.pickups, 3)
check(
  "generated routes are Planned",
  firstRun.routes.every((route) => route.status === "Planned"),
  true,
)

const secondRun = runPlanAhead({
  schemes: [eligible],
  today: TODAY,
  existingRoutes: firstRun.routes,
  existingPickups: firstRun.pickups,
  deviationRecords: [],
  containers,
  actorName: "Plan Ahead",
})
check("second run creates nothing", secondRun.summary.created, 0)
check("second run refreshes both routes", secondRun.summary.refreshed, 2)
check(
  "second run keeps route identities (no duplicates)",
  secondRun.routes.map((route) => route.id).sort(),
  firstRun.routes.map((route) => route.id).sort(),
)

const readyRoute = firstRun.routes.find(
  (route) => route.submittedValues?.serviceDate === WED,
)
const executedRun = runPlanAhead({
  schemes: [eligible],
  today: TODAY,
  existingRoutes: firstRun.routes.map((route) =>
    route.id === readyRoute?.id ? { ...route, status: "Ready" } : route,
  ),
  existingPickups: firstRun.pickups,
  deviationRecords: [],
  containers,
  actorName: "Plan Ahead",
})
check("Ready routes are left untouched", executedRun.summary.skipped, 1)
check(
  "the untouched route is not rewritten",
  executedRun.routes.some((route) => route.id === readyRoute?.id),
  false,
)

const disabledRun = runPlanAhead({
  schemes: [setPlanAhead(eligible, false)],
  today: TODAY,
  existingRoutes: firstRun.routes,
  existingPickups: firstRun.pickups,
  deviationRecords: [],
  containers,
  actorName: "Plan Ahead",
})
check("toggling off stops auto-generation", disabledRun.routes.length, 0)
check("toggling off writes no pickups", disabledRun.pickups.length, 0)


/* --------------------- calendar consultation (Q2/Q6) ---------------------- */

const centralCalendarRecord: BusinessRecord = {
  id: "calendar-central",
  name: "Copenhagen Central 2026",
  context: "Copenhagen Central · Europe/Copenhagen",
  status: "Active",
  owner: "Operations Admin",
  value: "",
  updated: "",
  description: "",
  facts: {},
  related: [],
  source: "",
  freshness: "",
  submittedValues: {
    calendarName: "Copenhagen Central 2026",
    workingDays:
      "monday, tuesday, wednesday, thursday, friday, saturday, sunday",
    holidayDates: WED,
    validFrom: "2026-01-01",
    validTo: "2026-12-31",
  },
}

const onCalendar: BusinessRecord = {
  ...eligible,
  submittedValues: {
    ...eligible.submittedValues,
    calendarId: "calendar-central",
  },
}

const calendarRun = runPlanAhead({
  schemes: [onCalendar],
  today: TODAY,
  existingRoutes: [],
  existingPickups: [],
  deviationRecords: [],
  calendarRecords: [centralCalendarRecord],
  containers,
  actorName: "Plan Ahead",
})
check(
  "an auto-run skips the scheme calendar's holiday",
  [
    calendarRun.summary.created,
    calendarRun.summary.calendarSkipped,
    calendarRun.routes.map((route) => route.submittedValues?.serviceDate),
  ],
  [1, 1, [SUN]],
)

check(
  "a scheme without a calendar is not constrained by calendar records",
  runPlanAhead({
    schemes: [eligible],
    today: TODAY,
    existingRoutes: [],
    existingPickups: [],
    deviationRecords: [],
    calendarRecords: [centralCalendarRecord],
    containers,
    actorName: "Plan Ahead",
  }).summary.created,
  2,
)

check(
  "a calendarId with no matching record applies no constraint",
  runPlanAhead({
    schemes: [onCalendar],
    today: TODAY,
    existingRoutes: [],
    existingPickups: [],
    deviationRecords: [],
    calendarRecords: [],
    containers,
    actorName: "Plan Ahead",
  }).summary.created,
  2,
)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
