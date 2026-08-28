// Headless checks for the Route Scheme guided-setup validation (spec FR-5,
// ticket #5): per-day service plans, blocking checks at review, and the
// submittedValues round trip the generation engine will read.
// Run: npx tsx scripts/route-scheme-validation-harness.ts
import type { CollectionCalendar } from "../lib/route-schemes/calendar"
import {
  dayPlanCountSummary,
  dayPlansFromValues,
  dayPlansToValues,
  effectiveDayPlans,
  schemeDefaultsFromValues,
  validateScheme,
  type SchemeDayPlans,
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

/* --------------------------- effectiveDayPlans --------------------------- */

const sharedPlans: SchemeDayPlans = {
  sameAllDays: true,
  sharedContainerIds: ["c1", "c2"],
  containersByDay: { wednesday: ["ignored"] },
}

check(
  "shared mode: every day gets the shared list",
  effectiveDayPlans(["sunday", "wednesday"], sharedPlans),
  [
    { day: "wednesday", containerIds: ["c1", "c2"] },
    { day: "sunday", containerIds: ["c1", "c2"] },
  ],
)

const perDayPlans: SchemeDayPlans = {
  sameAllDays: false,
  sharedContainerIds: ["c1"],
  containersByDay: { wednesday: ["w1", "w2"], sunday: ["s1"] },
}

check(
  "per-day mode: each day gets its own list, days sorted Monday-first",
  effectiveDayPlans(["sunday", "wednesday"], perDayPlans),
  [
    { day: "wednesday", containerIds: ["w1", "w2"] },
    { day: "sunday", containerIds: ["s1"] },
  ],
)

check(
  "per-day mode: a day without a plan yields an empty list",
  effectiveDayPlans(["monday"], { sameAllDays: false, sharedContainerIds: [], containersByDay: {} }),
  [{ day: "monday", containerIds: [] }],
)

/* ------------------------------ validation ------------------------------- */

const validInput: SchemeValidationInput = {
  serviceDays: ["wednesday", "sunday"],
  effectiveFrom: "2026-08-28",
  effectiveTo: "2026-12-31",
  plans: perDayPlans,
  plannedVehicleId: "vehicle-1",
  plannedDriverId: "driver-1",
}

check("all checks pass → Validated with no issues", validateScheme(validInput, []), {
  status: "Validated",
  issues: [],
  warnings: [],
})

check(
  "no service days → Draft, named issue",
  validateScheme({ ...validInput, serviceDays: [] }, []),
  { status: "Draft", issues: ["Pick at least one service day"], warnings: [] },
)

check(
  "missing effective to → Draft, named issue",
  validateScheme({ ...validInput, effectiveTo: "" }, []),
  { status: "Draft", issues: ["Set the effective from and to dates"], warnings: [] },
)

check(
  "missing effective from → Draft, named issue",
  validateScheme({ ...validInput, effectiveFrom: "" }, []),
  { status: "Draft", issues: ["Set the effective from and to dates"], warnings: [] },
)

check(
  "effective to before from → Draft, named issue",
  validateScheme({ ...validInput, effectiveTo: "2026-08-27" }, []),
  { status: "Draft", issues: ["Effective to must be on or after effective from"], warnings: [] },
)

check(
  "effective to equal to from is allowed",
  validateScheme({ ...validInput, effectiveTo: "2026-08-28" }, []).status,
  "Validated",
)

check(
  "shared mode with no containers → Draft, named issue",
  validateScheme(
    {
      ...validInput,
      plans: { sameAllDays: true, sharedContainerIds: [], containersByDay: {} },
    },
    [],
  ),
  { status: "Draft", issues: ["Pick at least one container"], warnings: [] },
)

check(
  "per-day mode with one empty day names the day",
  validateScheme(
    {
      ...validInput,
      plans: { sameAllDays: false, sharedContainerIds: [], containersByDay: { wednesday: ["w1"] } },
    },
    [],
  ),
  { status: "Draft", issues: ["Pick containers for Sun"], warnings: [] },
)

check(
  "per-day mode with several empty days names them Monday-first",
  validateScheme(
    {
      ...validInput,
      serviceDays: ["sunday", "monday", "wednesday"],
      plans: { sameAllDays: false, sharedContainerIds: [], containersByDay: { monday: ["m1"] } },
    },
    [],
  ),
  { status: "Draft", issues: ["Pick containers for Wed, Sun"], warnings: [] },
)

/* --------------------- default vehicle/driver conflicts ------------------ */

const otherScheme = {
  schemeName: "RS-Central · Week A",
  serviceDays: ["wednesday"] as const,
  plannedVehicleId: "vehicle-1",
  plannedDriverId: "driver-2",
}

check(
  "same default vehicle on a shared service day → Draft, named issue",
  validateScheme(validInput, [otherScheme]),
  {
    status: "Draft",
    issues: [
      'Default vehicle is already the default on "RS-Central · Week A" (shares Wed)',
    ],
    warnings: [],
  },
)

check(
  "same default driver on a shared service day → Draft, named issue",
  validateScheme({ ...validInput, plannedVehicleId: "vehicle-9" }, [
    { ...otherScheme, plannedVehicleId: "vehicle-8", plannedDriverId: "driver-1" },
  ]),
  {
    status: "Draft",
    issues: [
      'Default driver is already the default on "RS-Central · Week A" (shares Wed)',
    ],
    warnings: [],
  },
)

check(
  "same defaults but no shared service day → no conflict",
  validateScheme(validInput, [{ ...otherScheme, serviceDays: ["monday"] }]),
  { status: "Validated", issues: [], warnings: [] },
)

check(
  "different defaults on a shared day → no conflict",
  validateScheme(validInput, [
    { ...otherScheme, plannedVehicleId: "vehicle-9", plannedDriverId: "driver-9" },
  ]),
  { status: "Validated", issues: [], warnings: [] },
)

check(
  "unset own defaults never conflict",
  validateScheme(
    { ...validInput, plannedVehicleId: undefined, plannedDriverId: undefined },
    [{ ...otherScheme, plannedVehicleId: undefined, plannedDriverId: undefined }],
  ),
  { status: "Validated", issues: [], warnings: [] },
)

check(
  "vehicle and driver conflicts across schemes both listed, shared days joined",
  validateScheme({ ...validInput, serviceDays: ["wednesday", "sunday"] }, [
    { schemeName: "A", serviceDays: ["wednesday", "sunday"], plannedVehicleId: "vehicle-1" },
    { schemeName: "B", serviceDays: ["sunday"], plannedDriverId: "driver-1" },
  ]),
  {
    status: "Draft",
    issues: [
      'Default vehicle is already the default on "A" (shares Wed, Sun)',
      'Default driver is already the default on "B" (shares Sun)',
    ],
    warnings: [],
  },
)

/* -------------------- record extraction & serialization ------------------ */

check(
  "schemeDefaultsFromValues reads the quick-create value shape",
  schemeDefaultsFromValues("RS-X", {
    serviceDays: "wednesday, sunday",
    plannedVehicleId: "vehicle-1",
    plannedDriverId: "",
  }),
  {
    schemeName: "RS-X",
    serviceDays: ["wednesday", "sunday"],
    plannedVehicleId: "vehicle-1",
    plannedDriverId: undefined,
  },
)

check(
  "schemeDefaultsFromValues → null without structured service days",
  schemeDefaultsFromValues("RS-Legacy", { serviceDays: "Mon–Fri narrative" }),
  null,
)

check(
  "schemeDefaultsFromValues → null without any default assignment",
  schemeDefaultsFromValues("RS-Y", { serviceDays: "monday" }),
  null,
)

check("schemeDefaultsFromValues → null for missing values", schemeDefaultsFromValues("RS-Z", undefined), null)

const roundTrip = dayPlansFromValues(dayPlansToValues(perDayPlans))
check("day plans survive the submittedValues round trip", roundTrip, perDayPlans)

check(
  "shared plans serialize without per-day noise",
  dayPlansToValues(sharedPlans),
  {
    sameAllDays: true,
    containerIds: "c1,c2",
    containersByDay: JSON.stringify({ wednesday: ["ignored"] }),
  },
)

check(
  "dayPlansFromValues tolerates malformed JSON",
  dayPlansFromValues({ sameAllDays: false, containerIds: "c1", containersByDay: "{oops" }),
  { sameAllDays: false, sharedContainerIds: ["c1"], containersByDay: {} },
)

check(
  "dayPlansFromValues defaults to shared mode when unset",
  dayPlansFromValues(undefined),
  { sameAllDays: true, sharedContainerIds: [], containersByDay: {} },
)

check(
  "dayPlansFromValues drops non-service-day keys",
  dayPlansFromValues({
    sameAllDays: false,
    containerIds: "",
    containersByDay: JSON.stringify({ wednesday: ["w1"], funday: ["x"], monday: "not-a-list" }),
  }),
  { sameAllDays: false, sharedContainerIds: [], containersByDay: { wednesday: ["w1"] } },
)

/* ------------------------------- summaries -------------------------------- */

check(
  "per-day count summary reads Wed 11 · Sun 11",
  dayPlanCountSummary([
    { day: "wednesday", containerIds: Array.from({ length: 11 }, (_, i) => `w${i}`) },
    { day: "sunday", containerIds: Array.from({ length: 11 }, (_, i) => `s${i}`) },
  ]),
  "Wed 11 · Sun 11",
)

check("empty plan summary", dayPlanCountSummary([]), "No service days")


/* --------------------------- calendar warnings ---------------------------- */
// PLAN_SIMPLIFICATION Q6/Q7: calendar caveats warn at save time and never
// demote a scheme to Draft.

const centralCalendar: CollectionCalendar = {
  id: "calendar-central",
  name: "Copenhagen Central 2026",
  status: "Active",
  workingDays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
  holidayDates: ["2026-12-25", "2026-12-26"],
  validFrom: "2026-01-01",
  validTo: "2026-12-31",
}

check(
  "service day outside calendar working days → warning, still Validated",
  validateScheme({ ...validInput, calendar: centralCalendar }, []),
  {
    status: "Validated",
    issues: [],
    warnings: [
      "Sun is not a working day on Copenhagen Central 2026 — those dates are skipped at generation",
    ],
  },
)

check(
  "all service days working → no warnings",
  validateScheme(
    { ...validInput, serviceDays: ["wednesday"], calendar: centralCalendar },
    [],
  ),
  { status: "Validated", issues: [], warnings: [] },
)

check(
  "non-Active calendar → warning, still Validated",
  validateScheme(
    {
      ...validInput,
      serviceDays: ["wednesday"],
      calendar: { ...centralCalendar, status: "Draft" },
    },
    [],
  ),
  {
    status: "Validated",
    issues: [],
    warnings: [
      "Calendar Copenhagen Central 2026 is Draft — its working days and holidays may not be final",
    ],
  },
)

check(
  "scheme effective period past calendar validity → warning",
  validateScheme(
    {
      ...validInput,
      serviceDays: ["wednesday"],
      calendar: { ...centralCalendar, validTo: "2026-10-31" },
    },
    [],
  ),
  {
    status: "Validated",
    issues: [],
    warnings: [
      "Scheme effective period extends outside Copenhagen Central 2026 validity — uncovered dates generate without calendar rules",
    ],
  },
)

check(
  "open-ended scheme with a bounded calendar → validity warning stacks with blocking issues",
  validateScheme(
    {
      ...validInput,
      serviceDays: ["wednesday"],
      effectiveTo: "",
      calendar: centralCalendar,
    },
    [],
  ),
  {
    status: "Draft",
    issues: ["Set the effective from and to dates"],
    warnings: [
      "Scheme effective period extends outside Copenhagen Central 2026 validity — uncovered dates generate without calendar rules",
    ],
  },
)

check(
  "no calendar → no warnings",
  validateScheme(validInput, []).warnings,
  [],
)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
