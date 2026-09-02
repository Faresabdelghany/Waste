// Headless checks for the scheme lifecycle module (issue #25; SPEC.md area B,
// DECISIONS D5/D20/D25/D30): the canonical derived status (all five values,
// Effective/Expired against varying `today`, distrust of stale persisted
// Effective/Expired), the first-generation event, generation eligibility
// re-expressed through the derived status, and live Attention derivation.
// Run: npx tsx scripts/route-scheme-lifecycle-harness.ts
import type { BusinessRecord } from "../lib/data/business-modules"
import {
  initialGenerationWindow,
  planSchemeCreation,
  previewSchemeCreation,
} from "../lib/route-schemes/creation"
import {
  effectiveSchemeStatus,
  recordSchemeGeneration,
  schemeAttention,
  schemeCanGenerateRoutes,
  schemeFuturePlanningStopped,
  schemeGenerationRecorded,
  schemeLiveValidation,
  schemesInPlanning,
  withEffectiveSchemeStatus,
} from "../lib/route-schemes/lifecycle"
import {
  editReconciliationWindow,
  planSchemeEditReconciliation,
} from "../lib/route-schemes/edit"
import {
  planSchemeDeletion,
  SCHEME_DELETED_CANCEL_NOTE,
} from "../lib/route-schemes/deletion"
import {
  isPlanAheadEnabled,
  runPlanAhead,
  schemeAutoGenerates,
} from "../lib/route-schemes/plan-ahead"
import { isSoftDeleted, softDeletedRecord } from "../lib/data/record-visibility"

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

const TODAY = "2026-09-01"

function makeScheme(overrides: {
  id?: string
  status: string
  effectiveFrom?: string
  effectiveTo?: string
  lastGeneratedAt?: string
  submittedValues?: BusinessRecord["submittedValues"]
}): BusinessRecord {
  return {
    id: overrides.id ?? "scheme-x",
    name: `Scheme ${overrides.id ?? "x"}`,
    context: "Copenhagen Central · Indre By",
    status: overrides.status,
    owner: "Planner",
    value: "3 planned stops",
    updated: "Now",
    description: "",
    facts: {},
    related: [],
    source: "Office workspace",
    freshness: "Now",
    allowedTransitions: [],
    companyId: "company-wastehero",
    submittedValues: {
      frequency: "weekly",
      serviceDays: "wednesday, sunday",
      effectiveFrom: overrides.effectiveFrom ?? "2026-08-01",
      effectiveTo: overrides.effectiveTo ?? "",
      sameAllDays: true,
      containerIds: "asset-1",
      ...(overrides.lastGeneratedAt
        ? { lastGeneratedAt: overrides.lastGeneratedAt }
        : {}),
      ...overrides.submittedValues,
    },
  }
}

const GENERATED = "2026-08-20T06:00:00.000Z"

/* --------------------- persisted, event-driven statuses ------------------- */

check(
  "Draft stays Draft",
  effectiveSchemeStatus(makeScheme({ status: "Draft" }), TODAY),
  "Draft",
)
check(
  "Draft stays Draft even with a generation marker (blocking issues dominate)",
  effectiveSchemeStatus(
    makeScheme({ status: "Draft", lastGeneratedAt: GENERATED }),
    TODAY,
  ),
  "Draft",
)
check(
  "Validated stays Validated before any generation, even past effectiveFrom",
  effectiveSchemeStatus(
    makeScheme({ status: "Validated", effectiveFrom: "2026-08-01" }),
    TODAY,
  ),
  "Validated",
)
check(
  "unknown legacy status string falls back to Draft",
  effectiveSchemeStatus(makeScheme({ status: "Validation issue" }), TODAY),
  "Draft",
)

/* ------------------- derived Effective/Expired vs today ------------------- */

const scheduled = makeScheme({
  status: "Scheduled",
  effectiveFrom: "2026-09-10",
  effectiveTo: "2026-12-31",
  lastGeneratedAt: GENERATED,
})
check(
  "Scheduled before effectiveFrom stays Scheduled",
  effectiveSchemeStatus(scheduled, "2026-09-01"),
  "Scheduled",
)
check(
  "Scheduled becomes Effective on effectiveFrom",
  effectiveSchemeStatus(scheduled, "2026-09-10"),
  "Effective",
)
check(
  "Effective on effectiveTo itself (inclusive end)",
  effectiveSchemeStatus(scheduled, "2026-12-31"),
  "Effective",
)
check(
  "Expired after effectiveTo",
  effectiveSchemeStatus(scheduled, "2027-01-01"),
  "Expired",
)
check(
  "open-ended effectiveTo never expires",
  effectiveSchemeStatus(
    makeScheme({
      status: "Scheduled",
      effectiveFrom: "2026-08-01",
      lastGeneratedAt: GENERATED,
    }),
    "2030-01-01",
  ),
  "Effective",
)
check(
  "Validated past effectiveTo derives Expired (no generation required to expire)",
  effectiveSchemeStatus(
    makeScheme({
      status: "Validated",
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-06-30",
    }),
    TODAY,
  ),
  "Expired",
)

/* -------------------- distrust of stale persisted values ------------------ */

check(
  "stale persisted Effective with future effectiveFrom re-derives Scheduled",
  effectiveSchemeStatus(
    makeScheme({ status: "Effective", effectiveFrom: "2026-10-01" }),
    TODAY,
  ),
  "Scheduled",
)
check(
  "stale persisted Effective past effectiveTo re-derives Expired",
  effectiveSchemeStatus(
    makeScheme({
      status: "Effective",
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-06-30",
    }),
    TODAY,
  ),
  "Expired",
)
check(
  "stale persisted Expired with an open effective window and no marker re-derives Validated",
  effectiveSchemeStatus(
    makeScheme({ status: "Expired", effectiveFrom: "2026-08-01" }),
    TODAY,
  ),
  "Validated",
)
check(
  "stale persisted Expired with a marker and an open window re-derives Effective",
  effectiveSchemeStatus(
    makeScheme({
      status: "Expired",
      effectiveFrom: "2026-08-01",
      lastGeneratedAt: GENERATED,
    }),
    TODAY,
  ),
  "Effective",
)

/* ----------------- round-trip stability of the derivation ----------------- */

// Persisting a derived value (an edit-save carries the displayed status
// forward) must never change what later derivations return.
for (const status of ["Draft", "Validated", "Scheduled", "Effective"]) {
  for (const window of [
    { effectiveFrom: "2026-08-01", effectiveTo: "" },
    { effectiveFrom: "2026-10-01", effectiveTo: "2026-12-31" },
    { effectiveFrom: "2026-01-01", effectiveTo: "2026-06-30" },
  ]) {
    const record = makeScheme({ status, ...window })
    const once = withEffectiveSchemeStatus(record, TODAY)
    check(
      `derivation is stable for persisted ${status} (${window.effectiveFrom} → ${window.effectiveTo || "open"})`,
      effectiveSchemeStatus(once, TODAY),
      once.status,
    )
  }
}
check(
  "withEffectiveSchemeStatus returns the same record when nothing changes",
  withEffectiveSchemeStatus(scheduled, "2026-09-01") === scheduled,
  true,
)

/* ---------------------- first-generation event (D25) ---------------------- */

const validated = makeScheme({ status: "Validated", effectiveFrom: "2026-08-01" })
check("no generation recorded before the event", schemeGenerationRecorded(validated), false)
const generated = recordSchemeGeneration(validated, GENERATED)
check("the event promotes Validated to Scheduled", generated.status, "Scheduled")
check(
  "the event stamps the persisted marker",
  generated.submittedValues?.lastGeneratedAt,
  GENERATED,
)
check("generation recorded after the event", schemeGenerationRecorded(generated), true)
check(
  "the promoted scheme derives Effective once effectiveFrom is reached",
  effectiveSchemeStatus(generated, TODAY),
  "Effective",
)
check(
  "legacy persisted Scheduled counts as recorded generation without a marker",
  schemeGenerationRecorded(makeScheme({ status: "Scheduled" })),
  true,
)
check(
  "persisted Expired alone is not generation evidence",
  schemeGenerationRecorded(makeScheme({ status: "Expired" })),
  false,
)

/* ------------- generation eligibility through the derived status ----------- */

check(
  "Draft schemes cannot generate",
  schemeCanGenerateRoutes(makeScheme({ status: "Draft" }), TODAY),
  false,
)
check(
  "Validated schemes can generate",
  schemeCanGenerateRoutes(validated, TODAY),
  true,
)
check(
  "Expired schemes can still generate (manual regeneration/backfill)",
  schemeCanGenerateRoutes(
    makeScheme({
      status: "Scheduled",
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-06-30",
      lastGeneratedAt: GENERATED,
    }),
    TODAY,
  ),
  true,
)
check(
  "schemes without structured recurrence cannot generate",
  schemeCanGenerateRoutes(
    { ...validated, submittedValues: undefined },
    TODAY,
  ),
  false,
)
check(
  "unknown legacy status derives Draft and cannot generate",
  schemeCanGenerateRoutes(makeScheme({ status: "Validation issue" }), TODAY),
  false,
)

/* --------------- Plan Ahead eligibility reads the derived status ----------- */

const planAheadOn = (record: BusinessRecord): BusinessRecord => ({
  ...record,
  submittedValues: { ...record.submittedValues, planAhead: true },
})
check(
  "Plan Ahead processes a Validated scheme",
  schemeAutoGenerates(planAheadOn(validated), TODAY),
  true,
)
check(
  "Plan Ahead skips a stale persisted Effective that derives Expired",
  schemeAutoGenerates(
    planAheadOn(
      makeScheme({
        status: "Effective",
        effectiveFrom: "2026-01-01",
        effectiveTo: "2026-06-30",
      }),
    ),
    TODAY,
  ),
  false,
)
check(
  "Plan Ahead skips an unknown legacy status (derives Draft)",
  schemeAutoGenerates(
    planAheadOn(makeScheme({ status: "Validation issue" })),
    TODAY,
  ),
  false,
)

/* ------------------------- live Attention (D5/D20) ------------------------ */

function makeContainer(overrides: {
  id: string
  serviceFrequencyId?: string
}): BusinessRecord {
  return {
    id: overrides.id,
    name: overrides.id.toUpperCase(),
    context: "Ørnevej 21 · Copenhagen Central",
    status: "Available",
    owner: "Asset Team",
    value: "40%",
    updated: "Now",
    description: "",
    facts: { "Waste fractions": "Residual", "Container type": "660L" },
    related: [],
    source: "Container registry",
    freshness: "Now",
    allowedTransitions: [],
    companyId: "company-wastehero",
    submittedValues: overrides.serviceFrequencyId
      ? { serviceFrequencyId: overrides.serviceFrequencyId }
      : {},
  }
}

// An every-2-weeks scheme over a container promised Every week: the linked
// promise is under-served — one live reconciliation warning, no blockers.
const attentionScheme = makeScheme({
  status: "Validated",
  effectiveFrom: "2026-08-01",
  effectiveTo: "2026-12-31",
  submittedValues: {
    frequency: "every-2-weeks",
    weekRotation: "even",
    containerIds: "bin-1",
  },
})
const weeklyContainer = makeContainer({
  id: "bin-1",
  serviceFrequencyId: "freq-weekly",
})
const matchedContainer = makeContainer({
  id: "bin-1",
  serviceFrequencyId: "freq-every-2-weeks",
})

const attention = schemeAttention(attentionScheme, {
  schemes: [attentionScheme],
  containers: [weeklyContainer],
})
check("under-served promise produces a live Attention warning", attention.length, 1)
check(
  "the warning names the under-served promise",
  attention[0]?.includes("under-serves") &&
    attention[0]?.includes("Every week") &&
    attention[0]?.includes("BIN-1"),
  true,
)
check(
  "Attention recomputes from current related data — a matching promise clears it",
  schemeAttention(attentionScheme, {
    schemes: [attentionScheme],
    containers: [matchedContainer],
  }),
  [],
)
check(
  "a clean scheme has no Attention",
  schemeAttention(validated, { schemes: [validated] }),
  [],
)
check(
  "legacy records without structured recurrence have no live validation",
  schemeLiveValidation(
    { ...validated, submittedValues: undefined },
    { schemes: [] },
  ),
  null,
)

// Blocking issues are the Draft presentation, never folded into Attention.
const blockedScheme = makeScheme({
  status: "Draft",
  submittedValues: { containerIds: "" },
})
const blockedValidation = schemeLiveValidation(blockedScheme, {
  schemes: [blockedScheme],
})
check(
  "live validation surfaces blocking issues separately",
  (blockedValidation?.issues.length ?? 0) > 0,
  true,
)
check(
  "Attention stays warnings-only for a blocked scheme",
  schemeAttention(blockedScheme, { schemes: [blockedScheme] }),
  blockedValidation?.warnings ?? [],
)

// Attention consults the shared validation seam end to end: a conflicting
// default vehicle on another scheme is a live blocking issue, and a
// Draft/Allocated allocation overlap is a live warning.
const vehicleScheme = makeScheme({
  id: "scheme-vehicle",
  status: "Validated",
  effectiveFrom: "2026-08-01",
  effectiveTo: "2026-12-31",
  submittedValues: { plannedVehicleId: "vehicle-wh-24" },
})
const allocation: BusinessRecord = {
  ...makeScheme({ id: "allocation-1", status: "Allocated" }),
  name: "WH-24 depot cover",
  submittedValues: {
    vehicleId: "vehicle-wh-24",
    plannedStart: "2026-09-02",
    plannedEnd: "2026-09-02",
  },
}
const allocationWarnings = schemeAttention(vehicleScheme, {
  schemes: [vehicleScheme],
  allocations: [allocation],
})
check(
  "an unconfirmed allocation overlap surfaces as live Attention",
  allocationWarnings.length === 1 &&
    allocationWarnings[0]!.includes("WH-24 depot cover"),
  true,
)

/* ------------------ creation orchestration (issue #28) -------------------- */
// SPEC.md area A, D18/D24/D25: finishing a create immediately produces a
// working scheme — Validated generates the initial window with Plan Ahead on
// and becomes Scheduled; Draft generates nothing; a technically successful
// zero-route run still schedules; only a technical failure stays Validated.

check(
  "initial window starts today when effectiveFrom has passed",
  initialGenerationWindow("2026-09-01", "2026-08-01"),
  { from: "2026-09-01", to: "2026-09-08" },
)
check(
  "initial window starts at a future effectiveFrom",
  initialGenerationWindow("2026-09-01", "2026-09-15"),
  { from: "2026-09-15", to: "2026-09-22" },
)
check(
  "initial window falls back to today without an effectiveFrom",
  initialGenerationWindow("2026-09-01", undefined),
  { from: "2026-09-01", to: "2026-09-08" },
)

const creationRelated = {
  existingRoutes: [],
  existingPickups: [],
  containers: [],
}

// TODAY 2026-09-01 is a Tuesday; the weekly Wed+Sun scheme serves 2 Sep and
// 6 Sep inside the 1 Sep → 8 Sep initial window.
const created = planSchemeCreation(
  {
    scheme: makeScheme({ status: "Validated", effectiveFrom: "2026-08-01" }),
    today: TODAY,
    actorName: "Planner",
    generatedAt: GENERATED,
  },
  creationRelated,
)
check("create: Validated scheme schedules", created.outcome, "scheduled")
check("create: window is max(today, effectiveFrom) + 7 days", created.window, {
  from: "2026-09-01",
  to: "2026-09-08",
})
check(
  "create: routes generated for the window's service dates",
  created.routes.map((route) => route.submittedValues?.serviceDate),
  ["2026-09-02", "2026-09-06"],
)
check(
  "create: each route brings its pickups",
  created.pickups.length,
  2,
)
check(
  "create: scheme stamped Scheduled with the generation marker",
  [created.scheme.status, created.scheme.submittedValues?.lastGeneratedAt],
  ["Scheduled", GENERATED],
)
check("create: Plan Ahead on by default", isPlanAheadEnabled(created.scheme), true)
check(
  "create: derived status displays Effective once effectiveFrom has passed",
  effectiveSchemeStatus(created.scheme, TODAY),
  "Effective",
)

// Window boundary (D24, literal): `end = start + 7 days` with the engine's
// inclusive window semantics — a scheme serving the start date's weekday
// generates on day 0 AND day 7. This differs deliberately from the rolling
// planAheadWindow (tomorrow → +7): the initial window includes today so a
// scheme effective today gets today's route at creation.
const boundaryCreated = planSchemeCreation(
  {
    scheme: makeScheme({
      status: "Validated",
      effectiveFrom: "2026-08-01",
      submittedValues: { serviceDays: "tuesday" },
    }),
    today: TODAY, // 2026-09-01, a Tuesday
    actorName: "Planner",
    generatedAt: GENERATED,
  },
  creationRelated,
)
check(
  "create: inclusive window end — start weekday generates on day 0 and day 7",
  boundaryCreated.routes.map((route) => route.submittedValues?.serviceDate),
  ["2026-09-01", "2026-09-08"],
)

const futureCreated = planSchemeCreation(
  {
    scheme: makeScheme({ status: "Validated", effectiveFrom: "2026-09-15" }),
    today: TODAY,
    actorName: "Planner",
    generatedAt: GENERATED,
  },
  creationRelated,
)
check(
  "create: future effectiveFrom starts the window there",
  futureCreated.window,
  { from: "2026-09-15", to: "2026-09-22" },
)
check(
  "create: future effectiveFrom displays Scheduled, not Effective",
  effectiveSchemeStatus(futureCreated.scheme, TODAY),
  "Scheduled",
)

const draftCreated = planSchemeCreation(
  { scheme: makeScheme({ status: "Draft" }), today: TODAY, actorName: "Planner" },
  creationRelated,
)
check(
  "create: Draft generates nothing",
  [draftCreated.outcome, draftCreated.routes.length, draftCreated.pickups.length],
  ["draft", 0, 0],
)
check(
  "create: Draft keeps its record untouched — no Plan Ahead flag, no marker",
  [
    draftCreated.scheme.status,
    draftCreated.scheme.submittedValues?.planAhead,
    draftCreated.scheme.submittedValues?.lastGeneratedAt,
  ],
  ["Draft", undefined, undefined],
)

// A calendar working only Mondays invalidates every Wed/Sun window date: the
// run is technically successful with zero routes → still Scheduled (D25).
const mondayCalendar: BusinessRecord = {
  ...makeScheme({ id: "calendar-mondays", status: "Active" }),
  name: "Mondays only",
  submittedValues: { workingDays: "monday", validFrom: "2026-01-01", validTo: "2026-12-31" },
}
const zeroRouteCreated = planSchemeCreation(
  {
    scheme: makeScheme({
      status: "Validated",
      effectiveFrom: "2026-08-01",
      submittedValues: { calendarId: "calendar-mondays" },
    }),
    today: TODAY,
    actorName: "Planner",
    generatedAt: GENERATED,
  },
  { ...creationRelated, calendarRecords: [mondayCalendar] },
)
check(
  "create: zero-route success still schedules",
  [zeroRouteCreated.outcome, zeroRouteCreated.routes.length],
  ["scheduled", 0],
)
check(
  "create: zero-route success stamps the marker and keeps Plan Ahead on",
  [
    zeroRouteCreated.scheme.status,
    zeroRouteCreated.scheme.submittedValues?.lastGeneratedAt,
    isPlanAheadEnabled(zeroRouteCreated.scheme),
  ],
  ["Scheduled", GENERATED, true],
)

// Technical failure: a Validated record whose recurrence the engine cannot
// read plans nothing — the scheme stays Validated (never Scheduled), with
// Plan Ahead armed for when the configuration is repaired.
const failedCreated = planSchemeCreation(
  {
    scheme: makeScheme({
      status: "Validated",
      submittedValues: { frequency: "someday", serviceDays: "" },
    }),
    today: TODAY,
    actorName: "Planner",
    generatedAt: GENERATED,
  },
  creationRelated,
)
check(
  "create: technical generation failure stays Validated",
  [
    failedCreated.outcome,
    failedCreated.scheme.status,
    failedCreated.scheme.submittedValues?.lastGeneratedAt,
    failedCreated.routes.length,
  ],
  ["generation-failed", "Validated", undefined, 0],
)
check(
  "create: failed generation still arms Plan Ahead",
  isPlanAheadEnabled(failedCreated.scheme),
  true,
)

/* -------------------- review-step creation preview (D27) ------------------ */

const preview = previewSchemeCreation({
  today: TODAY,
  frequency: "weekly",
  serviceDays: ["wednesday", "sunday"],
  effectiveFrom: "2026-08-01",
  dayPlans: [
    { day: "wednesday", containerIds: ["c1", "c2"] },
    { day: "sunday", containerIds: ["c3"] },
  ],
})
check(
  "preview: route dates and estimated stops for the initial window",
  preview && {
    window: preview.window,
    routeDates: preview.routeDates,
    estimatedStops: preview.estimatedStops,
  },
  {
    window: { from: "2026-09-01", to: "2026-09-08" },
    routeDates: ["2026-09-02", "2026-09-06"],
    estimatedStops: 3,
  },
)
check(
  "preview: calendar-invalidated dates counted, not listed as routes",
  (() => {
    const skipped = previewSchemeCreation({
      today: TODAY,
      frequency: "weekly",
      serviceDays: ["wednesday", "sunday"],
      effectiveFrom: "2026-08-01",
      dayPlans: [{ day: "wednesday", containerIds: ["c1"] }],
      calendar: {
        id: "calendar-mondays",
        name: "Mondays only",
        status: "Active",
        workingDays: ["monday"],
        holidayDates: [],
        validFrom: "2026-01-01",
        validTo: "2026-12-31",
      },
    })
    return skipped && [skipped.routeDates.length, skipped.calendarSkipped]
  })(),
  [0, 2],
)
check(
  "preview: no structured recurrence → null",
  previewSchemeCreation({
    today: TODAY,
    frequency: "weekly",
    serviceDays: [],
    effectiveFrom: "",
    dayPlans: [],
  }),
  null,
)

/* ---------------- edit-save reconciliation (issue #33, D31) ---------------- */
// SPEC.md area G: Edit → Validate → Save → Reconcile future planning window.
// The fixture chain is behavioral: create a Wed+Sun scheme (routes 2 Sep and
// 6 Sep with pickups), then edit it and reconcile against those records.

const editBase = planSchemeCreation(
  {
    scheme: makeScheme({ id: "scheme-edit", status: "Validated", effectiveFrom: "2026-08-01" }),
    today: TODAY,
    actorName: "Planner",
    generatedAt: GENERATED,
  },
  creationRelated,
)

const withValues = (
  record: BusinessRecord,
  values: NonNullable<BusinessRecord["submittedValues"]>,
): BusinessRecord => ({
  ...record,
  submittedValues: { ...record.submittedValues, ...values },
})

// Edit: drop Sunday. Window = tomorrow (2 Sep) → today+7 (8 Sep): the kept
// Wednesday (2 Sep) refreshes, the dropped Sunday (6 Sep) cancels with the
// generation-authored resurrection marker; its pickup is skipped.
const dropSunday = planSchemeEditReconciliation(
  {
    before: editBase.scheme,
    after: withValues(editBase.scheme, { serviceDays: "wednesday" }),
    today: TODAY,
    actorName: "Planner",
    generatedAt: GENERATED,
  },
  {
    schemes: [editBase.scheme],
    existingRoutes: editBase.routes,
    existingPickups: editBase.pickups,
    containers: [],
  },
)
check("edit: valid edit reconciles", dropSunday.outcome, "reconciled")
check(
  "edit: kept date refreshes, dropped date cancels",
  dropSunday.routes.map((route) => [
    route.submittedValues?.serviceDate,
    route.status,
  ]),
  [
    ["2026-09-02", "Planned"],
    ["2026-09-06", "Cancelled"],
  ],
)
check(
  "edit: the cancel carries the resurrection marker",
  dropSunday.routes[1]?.submittedValues?.cancelledByGeneration,
  true,
)
check(
  "edit: the cancelled route's pickup is skipped, not deleted",
  dropSunday.pickups
    .filter((pickup) => pickup.submittedValues?.serviceDate === "2026-09-06")
    .map((pickup) => pickup.status),
  ["Skipped"],
)
check(
  "edit: scheme keeps Scheduled and restamps the generation marker",
  [dropSunday.scheme.status, dropSunday.scheme.submittedValues?.lastGeneratedAt],
  ["Scheduled", GENERATED],
)

// Touchability (SPEC G): only Draft/Planned routes are rewritten. An Active
// route on the dropped Sunday is left completely untouched, and a dispatcher
// vehicle override on the kept Wednesday survives the refresh.
const activeSunday = editBase.routes.map((route) =>
  route.submittedValues?.serviceDate === "2026-09-06"
    ? { ...route, status: "Active" }
    : { ...route, facts: { ...route.facts, Vehicle: "Spare truck WH-99" } },
)
const touchability = planSchemeEditReconciliation(
  {
    before: editBase.scheme,
    after: withValues(editBase.scheme, { serviceDays: "wednesday" }),
    today: TODAY,
    actorName: "Planner",
    generatedAt: GENERATED,
  },
  {
    schemes: [editBase.scheme],
    existingRoutes: activeSunday,
    existingPickups: editBase.pickups,
    containers: [],
  },
)
check(
  "edit: an Active route on a dropped date is never rewritten",
  touchability.routes.map((route) => route.submittedValues?.serviceDate),
  ["2026-09-02"],
)
check(
  "edit: a dispatcher vehicle override survives the refresh",
  touchability.routes[0]?.facts.Vehicle,
  "Spare truck WH-99",
)

// Window bounds: the window reaches the scheme's furthest future route so
// prior coverage cannot drift, and stays bounded by the engine's walked-range
// cap — a route past the 367-date truncation point is never judged.
check(
  "edit: window is tomorrow → today+7 when no routes reach further",
  editReconciliationWindow(TODAY, "scheme-edit", editBase.routes),
  { from: "2026-09-02", to: "2026-09-08" },
)
const farRoute = {
  ...editBase.routes[1]!,
  id: "route-gen-scheme-edit-2026-09-20",
  submittedValues: {
    ...editBase.routes[1]!.submittedValues,
    serviceDate: "2026-09-20",
    actualDate: "2026-09-20",
  },
}
check(
  "edit: window extends to the furthest future generated route",
  editReconciliationWindow(TODAY, "scheme-edit", [...editBase.routes, farRoute]),
  { from: "2026-09-02", to: "2026-09-20" },
)
const beyondWalkCap = {
  ...farRoute,
  id: "route-gen-scheme-edit-2027-10-30",
  submittedValues: {
    ...farRoute.submittedValues,
    serviceDate: "2027-10-30",
    actualDate: "2027-10-30",
  },
}
const boundedEdit = planSchemeEditReconciliation(
  {
    before: editBase.scheme,
    after: withValues(editBase.scheme, { serviceDays: "wednesday" }),
    today: TODAY,
    actorName: "Planner",
    generatedAt: GENERATED,
  },
  {
    schemes: [editBase.scheme],
    existingRoutes: [...editBase.routes, farRoute, beyondWalkCap],
    existingPickups: editBase.pickups,
    containers: [],
  },
)
check(
  "edit: a dropped-day route beyond the rolling window is still cancelled",
  boundedEdit.routes.find(
    (route) => route.submittedValues?.serviceDate === "2026-09-20",
  )?.status,
  "Cancelled",
)
check(
  "edit: a route past the walk cap is never judged (walked-range bound)",
  boundedEdit.routes.some(
    (route) => route.submittedValues?.serviceDate === "2027-10-30",
  ),
  false,
)

// Edit → Draft (SPEC G): an invalidating edit cancels — never deletes —
// future refreshable routes with the resurrection marker, and the scheme
// gains the future-planning-stopped explanation state the detail page shows.
const emptied = withValues(editBase.scheme, { containerIds: "" })
const invalidEdit = planSchemeEditReconciliation(
  {
    before: editBase.scheme,
    after: emptied,
    today: TODAY,
    actorName: "Planner",
    generatedAt: GENERATED,
  },
  {
    schemes: [editBase.scheme],
    existingRoutes: editBase.routes,
    existingPickups: editBase.pickups,
    containers: [],
  },
)
check("edit: invalidating edit saves as Draft", invalidEdit.scheme.status, "Draft")
check(
  "edit: Draft transition cancels every future refreshable route with the marker",
  invalidEdit.routes.map((route) => [
    route.status,
    route.submittedValues?.cancelledByGeneration,
  ]),
  [
    ["Cancelled", true],
    ["Cancelled", true],
  ],
)
check(
  "edit: Draft cancels skip the routes' open pickups",
  invalidEdit.pickups.map((pickup) => pickup.status),
  ["Skipped", "Skipped"],
)
check(
  "edit: Draft transition restamps the validation issues fact",
  Boolean(invalidEdit.scheme.facts["Validation issues"]),
  true,
)
check(
  "edit: the detail page can explain that future planning stopped",
  schemeFuturePlanningStopped(invalidEdit.scheme),
  true,
)
check(
  "edit: a never-generated Draft does not claim future planning stopped",
  schemeFuturePlanningStopped(makeScheme({ status: "Draft" })),
  false,
)
// The Draft-transition cancel honors the same walk cap as re-materialization:
// a cancel the fixing save could never resurrect would be a one-way door.
const cappedInvalidEdit = planSchemeEditReconciliation(
  {
    before: editBase.scheme,
    after: emptied,
    today: TODAY,
    actorName: "Planner",
    generatedAt: GENERATED,
  },
  {
    schemes: [editBase.scheme],
    existingRoutes: [...editBase.routes, beyondWalkCap],
    existingPickups: [],
    containers: [],
  },
)
check(
  "edit: the Draft-transition cancel never reaches past the walk cap",
  cappedInvalidEdit.routes.some(
    (route) => route.submittedValues?.serviceDate === "2027-10-30",
  ),
  false,
)

// Resurrection: fixing the scheme re-materializes the marked cancels under
// their original identities, while an operational cancel (no marker) stays
// cancelled forever.
const operationalCancel = {
  ...editBase.routes[1]!,
  status: "Cancelled",
}
const fixedEdit = planSchemeEditReconciliation(
  {
    before: invalidEdit.scheme,
    after: withValues(invalidEdit.scheme, { containerIds: "asset-1" }),
    today: TODAY,
    actorName: "Planner",
    generatedAt: GENERATED,
  },
  {
    schemes: [invalidEdit.scheme],
    existingRoutes: [invalidEdit.routes[0]!, operationalCancel],
    existingPickups: [],
    containers: [],
  },
)
check(
  "edit: fixing the scheme re-materializes the marked cancel idempotently",
  fixedEdit.routes.map((route) => [
    route.id,
    route.submittedValues?.serviceDate,
    route.status,
  ]),
  [[editBase.routes[0]!.id, "2026-09-02", "Planned"]],
)
check(
  "edit: an operationally cancelled route is never resurrected",
  fixedEdit.routes.some(
    (route) => route.submittedValues?.serviceDate === "2026-09-06",
  ),
  false,
)
check(
  "edit: the fixed scheme validates and re-records generation",
  [fixedEdit.scheme.status, fixedEdit.outcome],
  ["Scheduled", "reconciled"],
)

// Self-id exemption: a scheme holding its own Confirmed Vehicle Planning
// allocation must not flip to Draft on save; the same allocation on another
// scheme's save is a blocking issue.
const confirmedAllocation: BusinessRecord = {
  ...makeScheme({ id: "allocation-own", status: "Confirmed" }),
  name: "WH-24 scheme cover",
  submittedValues: {
    vehicleId: "vehicle-wh-24",
    plannedStart: "2026-09-02",
    plannedEnd: "2026-09-02",
    schemeId: "scheme-edit",
  },
}
const ownAllocationEdit = planSchemeEditReconciliation(
  {
    before: editBase.scheme,
    after: withValues(editBase.scheme, { plannedVehicleId: "vehicle-wh-24" }),
    today: TODAY,
    actorName: "Planner",
    generatedAt: GENERATED,
  },
  {
    schemes: [editBase.scheme],
    existingRoutes: editBase.routes,
    existingPickups: editBase.pickups,
    containers: [],
    allocations: [confirmedAllocation],
  },
)
check(
  "edit: saving with the scheme's own Confirmed allocation stays valid",
  [ownAllocationEdit.outcome, ownAllocationEdit.scheme.status],
  ["reconciled", "Scheduled"],
)
const foreignAllocationEdit = planSchemeEditReconciliation(
  {
    before: editBase.scheme,
    after: withValues(editBase.scheme, { plannedVehicleId: "vehicle-wh-24" }),
    today: TODAY,
    actorName: "Planner",
    generatedAt: GENERATED,
  },
  {
    schemes: [editBase.scheme],
    existingRoutes: editBase.routes,
    existingPickups: editBase.pickups,
    containers: [],
    allocations: [
      {
        ...confirmedAllocation,
        submittedValues: {
          ...confirmedAllocation.submittedValues,
          schemeId: "scheme-other",
        },
      },
    ],
  },
)
check(
  "edit: another scheme's Confirmed allocation still blocks the save",
  foreignAllocationEdit.outcome,
  "draft",
)

// Legacy records without structured recurrence save unchanged — nothing to
// validate or reconcile, no routes touched.
const legacyEdit = planSchemeEditReconciliation(
  {
    before: { ...editBase.scheme, submittedValues: undefined },
    after: { ...editBase.scheme, submittedValues: undefined },
    today: TODAY,
    actorName: "Planner",
  },
  {
    schemes: [],
    existingRoutes: editBase.routes,
    existingPickups: editBase.pickups,
    containers: [],
  },
)
check(
  "edit: a legacy scheme saves unchanged with no route writes",
  [legacyEdit.outcome, legacyEdit.routes.length, legacyEdit.pickups.length],
  ["legacy", 0, 0],
)

/* ---------------- deletion and expiry (issue #34, D32, SPEC H) ---------------- */
// Deletion is a safe boundary, not an eraser: the scheme is soft-deleted with
// Plan Ahead off, its future refreshable routes are cancelled through the
// shared generation-authored cancel shape (kept as records), and everything
// operational — past, Active, Completed routes and their Pickups — stays.

const deletionInput = {
  today: TODAY,
  actorName: "Planner",
  reason: "Created in error: duplicate of the Central plan",
  deletionLogId: "audit-delete-1",
  generatedAt: GENERATED,
}
const deleted = planSchemeDeletion(
  { scheme: editBase.scheme, ...deletionInput },
  { existingRoutes: editBase.routes, existingPickups: editBase.pickups },
)
check(
  "delete: the scheme is soft-deleted, never removed",
  isSoftDeleted(deleted.scheme),
  true,
)
check(
  "delete: Plan Ahead is turned off on the deleted scheme",
  [isPlanAheadEnabled(deleted.scheme), deleted.scheme.facts["Plan ahead"]],
  [false, "Off"],
)
check(
  "delete: future refreshable routes are cancelled with the generation-authored marker",
  deleted.routes.map((route) => [
    route.submittedValues?.serviceDate,
    route.status,
    route.submittedValues?.cancelledByGeneration,
  ]),
  [
    ["2026-09-02", "Cancelled", true],
    ["2026-09-06", "Cancelled", true],
  ],
)
check(
  "delete: the cancel note says the scheme was deleted",
  deleted.routes[0]?.facts.Deviation,
  SCHEME_DELETED_CANCEL_NOTE,
)
check(
  "delete: the cancelled routes' open pickups are skipped, not deleted",
  deleted.pickups.map((pickup) => pickup.status),
  ["Skipped", "Skipped"],
)
check(
  "delete: the deletion reason, actor and log link are written on the scheme",
  [
    deleted.scheme.facts["Deletion reason"],
    deleted.scheme.facts["Deleted by"],
    deleted.scheme.related[0],
  ],
  [
    "Created in error: duplicate of the Central plan",
    "Planner",
    "Deletion log audit-delete-1",
  ],
)

// Touchability (P2): an Active route and its pickups are operational history
// — never rewritten, counted as preserved.
const deletedWithActive = planSchemeDeletion(
  { scheme: editBase.scheme, ...deletionInput },
  { existingRoutes: activeSunday, existingPickups: editBase.pickups },
)
check(
  "delete: an Active route is never rewritten — it is operational history",
  deletedWithActive.routes.map((route) => route.submittedValues?.serviceDate),
  ["2026-09-02"],
)
check(
  "delete: the Active route's pickups stay untouched",
  deletedWithActive.pickups.map((pickup) => pickup.submittedValues?.serviceDate),
  ["2026-09-02"],
)
check(
  "delete: preserved counts the routes left as history",
  [deleted.preserved, deletedWithActive.preserved],
  [0, 1],
)

// History bounds: past routes, today's operating route, and an operational
// cancel (no marker) stay as stored. Unlike the edit path, the cancel is NOT
// capped at the walk range — nothing will ever resurrect a deleted scheme's
// cancels, and a dangling far-future Planned route is exactly the D32 bug.
const pastCompleted: BusinessRecord = {
  ...editBase.routes[0]!,
  id: "route-gen-scheme-edit-2026-08-26",
  status: "Completed",
  submittedValues: {
    ...editBase.routes[0]!.submittedValues,
    serviceDate: "2026-08-26",
    actualDate: "2026-08-26",
  },
}
const todayPlanned: BusinessRecord = {
  ...editBase.routes[0]!,
  id: "route-gen-scheme-edit-2026-09-01",
  submittedValues: {
    ...editBase.routes[0]!.submittedValues,
    serviceDate: "2026-09-01",
    actualDate: "2026-09-01",
  },
}
const historyDeletion = planSchemeDeletion(
  { scheme: editBase.scheme, ...deletionInput },
  {
    existingRoutes: [
      pastCompleted,
      todayPlanned,
      operationalCancel,
      editBase.routes[0]!,
      beyondWalkCap,
    ],
    existingPickups: [],
  },
)
check(
  "delete: past, today's and operationally cancelled routes stay as stored; far-future Planned is cancelled",
  historyDeletion.routes.map((route) => route.submittedValues?.serviceDate),
  ["2026-09-02", "2027-10-30"],
)
check(
  "delete: preserved = the scheme's routes left alone",
  historyDeletion.preserved,
  3,
)
check(
  "delete: the consequence line names the cancels and the preserved history",
  historyDeletion.message,
  "Deleted — 2 future routes cancelled and kept as records; 3 routes left untouched as history. Future planning stopped.",
)

// A never-generated Draft deletes cleanly; other schemes' routes are not its business.
const draftDeletion = planSchemeDeletion(
  { scheme: makeScheme({ id: "scheme-never", status: "Draft" }), ...deletionInput },
  { existingRoutes: editBase.routes, existingPickups: editBase.pickups },
)
check(
  "delete: a never-generated Draft deletes with no route writes",
  [
    draftDeletion.routes.length,
    draftDeletion.pickups.length,
    draftDeletion.preserved,
    draftDeletion.message,
  ],
  [0, 0, 0, "Deleted — no generated routes existed. Future planning stopped."],
)

// After deletion nothing plans for the scheme again — including a scheme
// soft-deleted before Plan Ahead was turned off on delete (legacy browser
// state still holds the flag on), so the guard is the marker, not the flag.
const legacyDeleted = softDeletedRecord(editBase.scheme, {
  reason: "Duplicate record: legacy",
  actorName: "Planner",
  deletionLogId: "audit-delete-0",
})
check(
  "delete: a soft-deleted scheme never auto-generates, even with Plan Ahead still on",
  [isPlanAheadEnabled(legacyDeleted), schemeAutoGenerates(legacyDeleted, TODAY)],
  [true, false],
)
check(
  "delete: a soft-deleted scheme cannot generate manually either",
  schemeCanGenerateRoutes(legacyDeleted, TODAY),
  false,
)
check(
  "delete: a Plan Ahead run over a deleted scheme writes nothing",
  (() => {
    const run = runPlanAhead({
      schemes: [legacyDeleted],
      today: TODAY,
      existingRoutes: [],
      existingPickups: [],
      deviationRecords: [],
      containers: [],
      actorName: "Plan Ahead",
    })
    return [run.routes.length, run.pickups.length, run.summary.schemes]
  })(),
  [0, 0, 0],
)

// A deleted scheme leaves planning entirely: its default assignment no
// longer blocks another scheme's save (a deleted scheme is hidden from the
// list, so a conflict with it could never be resolved).
const defaultVehicleScheme = (id: string) =>
  makeScheme({
    id,
    status: "Validated",
    submittedValues: { plannedVehicleId: "vehicle-wh-24" },
  })
const rival = defaultVehicleScheme("scheme-rival")
const liveTwin = defaultVehicleScheme("scheme-twin")
check(
  "delete: a live twin scheme's default vehicle blocks the save",
  schemeLiveValidation(rival, { schemes: [rival, liveTwin] })?.issues.some((issue) =>
    issue.includes("scheme-twin"),
  ),
  true,
)
check(
  "delete: a soft-deleted twin no longer blocks — deleted schemes leave planning",
  schemeLiveValidation(rival, {
    schemes: [
      rival,
      softDeletedRecord(liveTwin, {
        reason: "Duplicate record: twin",
        actorName: "Planner",
        deletionLogId: "audit-delete-2",
      }),
    ],
  })?.issues ?? [],
  [],
)
// The same filter feeds the create paths' validateGuidedScheme, so Guided
// Setup, Quick Create and edit never disagree about who can conflict.
check(
  "delete: schemesInPlanning drops soft-deleted schemes and keeps the rest",
  schemesInPlanning([
    rival,
    softDeletedRecord(liveTwin, {
      reason: "Duplicate record: twin",
      actorName: "Planner",
      deletionLogId: "audit-delete-2",
    }),
  ]).map((scheme) => scheme.id),
  ["scheme-rival"],
)

/* ------------------------------- expiry (D32) ------------------------------ */
// Expiry is derived (today > effectiveTo) and is a boundary, not an eraser:
// nothing is generated past effectiveTo, Plan Ahead stops extending, and
// valid routes inside the effective period are never retroactively cancelled.

// Creation with effectiveTo inside the initial window: Wed 2 Sep is served,
// Sun 6 Sep lies past effectiveTo 2026-09-03 and is never generated.
const endingSoon = planSchemeCreation(
  {
    scheme: makeScheme({
      id: "scheme-ending",
      status: "Validated",
      effectiveFrom: "2026-08-01",
      effectiveTo: "2026-09-03",
    }),
    today: TODAY,
    actorName: "Planner",
    generatedAt: GENERATED,
  },
  creationRelated,
)
check(
  "expiry: no generated route carries a service date after effectiveTo",
  endingSoon.routes.map((route) => route.submittedValues?.serviceDate),
  ["2026-09-02"],
)
check(
  "expiry: Effective through effectiveTo, Expired the day after",
  [
    effectiveSchemeStatus(endingSoon.scheme, "2026-09-03"),
    effectiveSchemeStatus(endingSoon.scheme, "2026-09-04"),
  ],
  ["Effective", "Expired"],
)

// Shortening effectiveTo: the Planned route now past it is cancelled with the
// resurrection marker (the scheme no longer serves that date); the route
// inside the period refreshes, never cancels.
const shortened = planSchemeEditReconciliation(
  {
    before: editBase.scheme,
    after: withValues(editBase.scheme, { effectiveTo: "2026-09-03" }),
    today: TODAY,
    actorName: "Planner",
    generatedAt: GENERATED,
  },
  {
    schemes: [editBase.scheme],
    existingRoutes: editBase.routes,
    existingPickups: editBase.pickups,
    containers: [],
  },
)
check(
  "expiry: shortening effectiveTo cancels the route past it (marked) and refreshes the one inside",
  shortened.routes.map((route) => [
    route.submittedValues?.serviceDate,
    route.status,
    route.submittedValues?.cancelledByGeneration ?? false,
  ]),
  [
    ["2026-09-02", "Planned", false],
    ["2026-09-06", "Cancelled", true],
  ],
)

// An expired scheme: Plan Ahead stops extending, manual regeneration inside
// the period stays available, and history inside the period is untouched.
const expiredScheme = makeScheme({
  id: "scheme-expired",
  status: "Scheduled",
  effectiveFrom: "2026-08-01",
  effectiveTo: "2026-08-31",
  lastGeneratedAt: GENERATED,
  submittedValues: { planAhead: true },
})
const expiredHistory: BusinessRecord[] = [
  {
    ...pastCompleted,
    id: "route-gen-scheme-expired-2026-08-26",
    submittedValues: { ...pastCompleted.submittedValues, schemeId: "scheme-expired" },
  },
  {
    ...editBase.routes[1]!,
    id: "route-gen-scheme-expired-2026-08-30",
    submittedValues: {
      ...editBase.routes[1]!.submittedValues,
      schemeId: "scheme-expired",
      serviceDate: "2026-08-30",
      actualDate: "2026-08-30",
    },
  },
]
check(
  "expiry: Expired stops Plan Ahead but keeps manual regeneration inside the period",
  [
    effectiveSchemeStatus(expiredScheme, TODAY),
    schemeAutoGenerates(expiredScheme, TODAY),
    schemeCanGenerateRoutes(expiredScheme, TODAY),
  ],
  ["Expired", false, true],
)
check(
  "expiry: a Plan Ahead run over an expired scheme writes nothing",
  (() => {
    const run = runPlanAhead({
      schemes: [expiredScheme],
      today: TODAY,
      existingRoutes: expiredHistory,
      existingPickups: [],
      deviationRecords: [],
      containers: [],
      actorName: "Plan Ahead",
    })
    return [run.routes.length, run.summary.schemes]
  })(),
  [0, 0],
)
const expiredEdit = planSchemeEditReconciliation(
  {
    before: expiredScheme,
    after: withValues(expiredScheme, { plannedStartTime: "07:00" }),
    today: TODAY,
    actorName: "Planner",
    generatedAt: GENERATED,
  },
  {
    schemes: [expiredScheme],
    existingRoutes: expiredHistory,
    existingPickups: [],
    containers: [],
  },
)
check(
  "expiry: a valid edit of an expired scheme generates nothing and leaves in-period routes untouched",
  [expiredEdit.outcome, expiredEdit.routes.length, expiredEdit.pickups.length],
  ["reconciled", 0, 0],
)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
