// Headless checks for the scheme lifecycle module (issue #25; SPEC.md area B,
// DECISIONS D5/D20/D25/D30): the canonical derived status (all five values,
// Effective/Expired against varying `today`, distrust of stale persisted
// Effective/Expired), the first-generation event, generation eligibility
// re-expressed through the derived status, and live Attention derivation.
// Run: npx tsx scripts/route-scheme-lifecycle-harness.ts
import type { BusinessRecord } from "../lib/data/business-modules"
import {
  effectiveSchemeStatus,
  recordSchemeGeneration,
  schemeAttention,
  schemeCanGenerateRoutes,
  schemeGenerationRecorded,
  schemeLiveValidation,
  withEffectiveSchemeStatus,
} from "../lib/route-schemes/lifecycle"
import { schemeAutoGenerates } from "../lib/route-schemes/plan-ahead"

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

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
