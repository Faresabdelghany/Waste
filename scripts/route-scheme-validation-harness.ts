// Headless checks for the Route Scheme guided-setup validation (spec FR-5,
// ticket #5): per-day service plans, blocking checks at review, and the
// submittedValues round trip the generation engine will read. Issue #11 adds
// the Vehicle Planning allocation cross-check and effective-period overlap.
// Run: npx tsx scripts/route-scheme-validation-harness.ts
import type { CollectionCalendar } from "../lib/route-schemes/calendar"
import {
  quickSchemeDraftFromValues,
  type GuidedSchemeData,
} from "../lib/route-schemes/quick-create"
import {
  allocationConflictSourceFromValues,
  allocationConflictSources,
  dayPlanCountSummary,
  dayPlansFromValues,
  dayPlansToValues,
  effectiveDayPlans,
  schemeDefaultsFromValues,
  schemeFrequencyReconciliationWarnings,
  validateScheme,
  type AllocationConflictSource,
  type SchemeDayPlans,
  type SchemeFrequencyPromise,
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

// Issue #28 (D23): effectiveTo is optional — an omitted To means the scheme
// runs open-ended; only a To before From still blocks.
check(
  "missing effective to → Validated (open-ended scheme)",
  validateScheme({ ...validInput, effectiveTo: "" }, []),
  { status: "Validated", issues: [], warnings: [] },
)

check(
  "missing effective from → Draft, named issue",
  validateScheme({ ...validInput, effectiveFrom: "" }, []),
  { status: "Draft", issues: ["Set the effective from date"], warnings: [] },
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

check(
  "provably disjoint effective periods → no conflict despite shared day + vehicle",
  validateScheme(validInput, [
    { ...otherScheme, effectiveFrom: "2027-01-01", effectiveTo: "2027-06-30" },
  ]),
  { status: "Validated", issues: [], warnings: [] },
)

check(
  "overlapping effective periods still conflict",
  validateScheme(validInput, [
    { ...otherScheme, effectiveFrom: "2026-12-01", effectiveTo: "2027-06-30" },
  ]).status,
  "Draft",
)

check(
  "other scheme without period info conservatively conflicts",
  validateScheme(validInput, [otherScheme]).status,
  "Draft",
)

check(
  "open-ended other scheme starting before the draft ends conflicts",
  validateScheme(validInput, [
    { ...otherScheme, effectiveFrom: "2026-01-01", effectiveTo: "" },
  ]).status,
  "Draft",
)

check(
  "datetime-shaped period values still prove disjointness at date level",
  validateScheme(validInput, [
    { ...otherScheme, effectiveFrom: "2027-01-01T00:00", effectiveTo: "2027-06-30" },
  ]).status,
  "Validated",
)

check(
  "malformed period values never prove disjointness → conservative conflict",
  validateScheme(validInput, [
    { ...otherScheme, effectiveFrom: "next spring", effectiveTo: "someday" },
  ]).status,
  "Draft",
)

/* ---------------- Vehicle Planning allocation cross-check ---------------- */
// Issue #11: scheme validation consults fleet.vehicle-planning. Confirmed
// allocations block; Draft/Allocated warn; Released and scheme-own never do.

const confirmedAllocation: AllocationConflictSource = {
  allocationName: "26 Jul · WH-24",
  status: "Confirmed",
  vehicleId: "vehicle-1",
  driverId: "driver-9",
  plannedStart: "2026-08-30T05:30",
  plannedEnd: "2026-08-30T16:00",
}

check(
  "confirmed allocation of the default vehicle in the effective period → Draft, named issue",
  // 2026-08-30 is a Sunday; validInput serves Wed + Sun from 2026-08-28.
  validateScheme(validInput, [], [confirmedAllocation]),
  {
    status: "Draft",
    issues: [
      'Default vehicle conflicts with confirmed Vehicle Planning allocation "26 Jul · WH-24" (2026-08-30)',
    ],
    warnings: [],
  },
)

check(
  "confirmed allocation of the default driver → Draft, named issue",
  validateScheme(validInput, [], [
    { ...confirmedAllocation, vehicleId: "vehicle-9", driverId: "driver-1" },
  ]),
  {
    status: "Draft",
    issues: [
      'Default driver conflicts with confirmed Vehicle Planning allocation "26 Jul · WH-24" (2026-08-30)',
    ],
    warnings: [],
  },
)

check(
  "unconfirmed allocation → warning only, still Validated",
  validateScheme(validInput, [], [{ ...confirmedAllocation, status: "Allocated" }]),
  {
    status: "Validated",
    issues: [],
    warnings: [
      'Default vehicle is planned on Vehicle Planning allocation "26 Jul · WH-24" (Allocated · 2026-08-30) — confirm or release it in Fleet',
    ],
  },
)

check(
  "released allocation never conflicts",
  validateScheme(validInput, [], [{ ...confirmedAllocation, status: "Released" }]),
  { status: "Validated", issues: [], warnings: [] },
)

check(
  "allocation window before the effective period → no conflict",
  validateScheme(validInput, [], [
    {
      ...confirmedAllocation,
      plannedStart: "2026-07-26T05:30",
      plannedEnd: "2026-07-26T16:00",
    },
  ]),
  { status: "Validated", issues: [], warnings: [] },
)

check(
  "allocation window inside the period but on a non-service weekday → no conflict",
  // 2026-08-31 is a Monday; validInput serves only Wed + Sun.
  validateScheme(validInput, [], [
    {
      ...confirmedAllocation,
      plannedStart: "2026-08-31T05:30",
      plannedEnd: "2026-08-31T16:00",
    },
  ]),
  { status: "Validated", issues: [], warnings: [] },
)

check(
  "week-long allocation window always touches some service day",
  validateScheme(validInput, [], [
    {
      ...confirmedAllocation,
      plannedStart: "2026-08-31T00:00",
      plannedEnd: "2026-09-08T23:59",
    },
  ]).status,
  "Draft",
)

check(
  "allocation without parseable window dates conservatively conflicts",
  validateScheme(validInput, [], [
    { ...confirmedAllocation, plannedStart: undefined, plannedEnd: undefined },
  ]).status,
  "Draft",
)

check(
  "missing plannedEnd means open-ended: a start inside the period conflicts",
  // Start Monday 2026-08-31 (not a service day) but the open window reaches
  // Wed 2026-09-02.
  validateScheme(validInput, [], [
    { ...confirmedAllocation, plannedStart: "2026-08-31T05:30", plannedEnd: undefined },
  ]).status,
  "Draft",
)

check(
  "missing plannedEnd with a start after the effective period → no conflict",
  validateScheme(validInput, [], [
    { ...confirmedAllocation, plannedStart: "2027-01-05T05:30", plannedEnd: undefined },
  ]).status,
  "Validated",
)

check(
  "allocation targeting the scheme itself is exempt",
  validateScheme({ ...validInput, schemeId: "scheme-own" }, [], [
    { ...confirmedAllocation, schemeId: "scheme-own" },
  ]),
  { status: "Validated", issues: [], warnings: [] },
)

check(
  "allocation targeting another scheme still conflicts",
  validateScheme({ ...validInput, schemeId: "scheme-own" }, [], [
    { ...confirmedAllocation, schemeId: "scheme-other" },
  ]).status,
  "Draft",
)

check(
  "vehicle and driver both allocated → one issue per resource",
  validateScheme(validInput, [], [
    { ...confirmedAllocation, driverId: "driver-1" },
  ]).issues,
  [
    'Default vehicle conflicts with confirmed Vehicle Planning allocation "26 Jul · WH-24" (2026-08-30)',
    'Default driver conflicts with confirmed Vehicle Planning allocation "26 Jul · WH-24" (2026-08-30)',
  ],
)

check(
  "allocation warnings stack after calendar warnings",
  validateScheme(
    {
      ...validInput,
      calendar: {
        id: "calendar-x",
        name: "Cal X",
        status: "Active",
        workingDays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
        holidayDates: [],
        validFrom: "2026-01-01",
        validTo: "2027-12-31",
      },
    },
    [],
    [{ ...confirmedAllocation, status: "Draft" }],
  ).warnings,
  [
    "Sun is not a working day on Cal X — those dates are skipped at generation",
    'Default vehicle is planned on Vehicle Planning allocation "26 Jul · WH-24" (Draft · 2026-08-30) — confirm or release it in Fleet',
  ],
)

check(
  "allocationConflictSourceFromValues reads the fleet.vehicle-planning value shape",
  allocationConflictSourceFromValues("26 Jul · WH-24", "Confirmed", {
    vehicleId: "vehicle-wh24",
    driverId: "driver-mads",
    plannedStart: "2026-07-26T05:30",
    plannedEnd: "2026-07-26T16:00",
    schemeId: "",
  }),
  {
    allocationName: "26 Jul · WH-24",
    status: "Confirmed",
    vehicleId: "vehicle-wh24",
    driverId: "driver-mads",
    plannedStart: "2026-07-26T05:30",
    plannedEnd: "2026-07-26T16:00",
  },
)

check(
  "allocationConflictSourceFromValues → null without typed vehicle or driver",
  allocationConflictSourceFromValues("26 Jul · WH-17", "Conflict", {
    plannedStart: "2026-07-26T00:00",
  }),
  null,
)

check(
  "allocationConflictSourceFromValues → null for missing values",
  allocationConflictSourceFromValues("Legacy", "Confirmed", undefined),
  null,
)

/* -------------- allocation supersession (append-event form) --------------- */
// The Plan allocation form's confirm/release/change submissions create NEW
// event records pointing at the original via existingAllocationId; the
// supersession pass folds them back onto their targets.

const baseAllocationRecord = {
  id: "alloc-1",
  name: "26 Jul · WH-24",
  status: "Confirmed",
  submittedValues: {
    vehicleId: "vehicle-1",
    plannedStart: "2026-08-30T05:30",
    plannedEnd: "2026-08-30T16:00",
  },
}

check(
  "allocationConflictSources passes plain allocations through",
  allocationConflictSources([baseAllocationRecord]).map((s) => s.status),
  ["Confirmed"],
)

check(
  "a release event retires its target and never conflicts itself",
  validateScheme(validInput, [], allocationConflictSources([
    baseAllocationRecord,
    {
      id: "alloc-2",
      name: "Vehicle allocation · Release allocation",
      status: "Released",
      submittedValues: { allocationAction: "release", existingAllocationId: "alloc-1" },
    },
  ])),
  { status: "Validated", issues: [], warnings: [] },
)

check(
  "a confirm event promotes its Draft target to blocking",
  validateScheme(validInput, [], allocationConflictSources([
    { ...baseAllocationRecord, status: "Draft" },
    {
      id: "alloc-3",
      name: "Vehicle allocation · Confirm allocation",
      status: "Confirmed",
      submittedValues: { allocationAction: "confirm", existingAllocationId: "alloc-1" },
    },
  ])).status,
  "Draft",
)

check(
  "a change event retires the original; the change record is the active source",
  allocationConflictSources([
    baseAllocationRecord,
    {
      id: "alloc-4",
      name: "Vehicle allocation · Change allocation",
      status: "Allocated",
      submittedValues: {
        allocationAction: "change",
        existingAllocationId: "alloc-1",
        vehicleId: "vehicle-2",
        plannedStart: "2026-09-06T05:30",
        plannedEnd: "2026-09-06T16:00",
      },
    },
  ]).map((s) => `${s.allocationName}:${s.status}:${s.vehicleId}`),
  [
    "26 Jul · WH-24:Released:vehicle-1",
    "Vehicle allocation · Change allocation:Allocated:vehicle-2",
  ],
)

check(
  "later events override earlier ones in store order",
  allocationConflictSources([
    { ...baseAllocationRecord, status: "Draft" },
    {
      id: "alloc-5",
      name: "Vehicle allocation · Confirm allocation",
      status: "Confirmed",
      submittedValues: { allocationAction: "confirm", existingAllocationId: "alloc-1" },
    },
    {
      id: "alloc-6",
      name: "Vehicle allocation · Release allocation",
      status: "Released",
      submittedValues: { allocationAction: "release", existingAllocationId: "alloc-1" },
    },
  ]).map((s) => s.status),
  ["Released"],
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
  "open-ended scheme with a bounded calendar → Validated with a validity warning",
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
    status: "Validated",
    issues: [],
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

/* ----------------------- frequency reconciliation ------------------------- */
// Issue #21: scheme recurrence vs promised service frequency, compared on the
// collections-per-week scale. Under- and over-service both warn; neither
// demotes status.

const weeklyPromise = (containerName: string): SchemeFrequencyPromise => ({
  containerName,
  promisedName: "Every week",
  promisedRate: 1,
})
const fortnightPromise = (containerName: string): SchemeFrequencyPromise => ({
  containerName,
  promisedName: "Every 2 weeks",
  promisedRate: 1 / 2,
})
const monthlyPromise = (containerName: string): SchemeFrequencyPromise => ({
  containerName,
  promisedName: "Once a month",
  promisedRate: 12 / 52,
})

check(
  "promise matches the recurrence → no reconciliation warnings",
  schemeFrequencyReconciliationWarnings({
    frequency: "every-2-weeks",
    promises: [fortnightPromise("BIN-1"), fortnightPromise("BIN-2")],
  }),
  [],
)

check(
  "no promises → no reconciliation warnings",
  schemeFrequencyReconciliationWarnings({ frequency: "weekly", promises: [] }),
  [],
)

check(
  "weekly promise on an every-2-weeks scheme → under-served",
  schemeFrequencyReconciliationWarnings({
    frequency: "every-2-weeks",
    promises: [weeklyPromise("BIN-1")],
  }),
  [
    "Recurrence Every 2 weeks under-serves 1 container promised Every week (BIN-1) — raise the frequency or adjust the promised service frequency",
  ],
)

check(
  "monthly promise on a weekly scheme → over-served",
  schemeFrequencyReconciliationWarnings({
    frequency: "weekly",
    promises: [monthlyPromise("GL-1"), monthlyPromise("GL-2")],
  }),
  [
    "Recurrence Every week over-serves 2 containers promised Once a month (GL-1, GL-2) — collections run more often than the promised service frequency",
  ],
)

check(
  "monthly promise on a monthly scheme → equal rates, no warning (12/52 both sides)",
  schemeFrequencyReconciliationWarnings({
    frequency: "monthly",
    promises: [monthlyPromise("GL-1")],
  }),
  [],
)

check(
  "an every-3-weeks interval promise orders without a scheme-cadence counterpart",
  schemeFrequencyReconciliationWarnings({
    frequency: "every-2-weeks",
    promises: [
      { containerName: "BIN-3W", promisedName: "Every 3 weeks", promisedRate: 1 / 3 },
    ],
  }),
  [
    "Recurrence Every 2 weeks over-serves 1 container promised Every 3 weeks (BIN-3W) — collections run more often than the promised service frequency",
  ],
)

check(
  "grouped per promised cadence, names sorted and capped at three",
  schemeFrequencyReconciliationWarnings({
    frequency: "monthly",
    promises: [
      weeklyPromise("BIN-4"),
      weeklyPromise("BIN-2"),
      weeklyPromise("BIN-1"),
      weeklyPromise("BIN-3"),
    ],
  }),
  [
    "Recurrence Once a month under-serves 4 containers promised Every week (BIN-1, BIN-2, BIN-3, +1 more) — raise the frequency or adjust the promised service frequency",
  ],
)

check(
  "under-served groups lead over-served ones, most frequent promise first",
  schemeFrequencyReconciliationWarnings({
    frequency: "every-2-weeks",
    promises: [monthlyPromise("GL-1"), weeklyPromise("BIN-1")],
  }),
  [
    "Recurrence Every 2 weeks under-serves 1 container promised Every week (BIN-1) — raise the frequency or adjust the promised service frequency",
    "Recurrence Every 2 weeks over-serves 1 container promised Once a month (GL-1) — collections run more often than the promised service frequency",
  ],
)

check(
  "reconciliation warnings never demote status (through validateScheme)",
  validateScheme(
    {
      ...validInput,
      frequencyReconciliation: {
        frequency: "every-2-weeks",
        promises: [weeklyPromise("BIN-1")],
      },
    },
    [],
  ),
  {
    status: "Validated",
    issues: [],
    warnings: [
      "Recurrence Every 2 weeks under-serves 1 container promised Every week (BIN-1) — raise the frequency or adjust the promised service frequency",
    ],
  },
)

check(
  "reconciliation warnings stack after calendar warnings",
  validateScheme(
    {
      ...validInput,
      calendar: centralCalendar,
      frequencyReconciliation: {
        frequency: "weekly",
        promises: [monthlyPromise("GL-1")],
      },
    },
    [],
  ).warnings,
  [
    "Sun is not a working day on Copenhagen Central 2026 — those dates are skipped at generation",
    "Recurrence Every week over-serves 1 container promised Once a month (GL-1) — collections run more often than the promised service frequency",
  ],
)

check(
  "no reconciliation input → previous behavior unchanged",
  validateScheme(validInput, []),
  { status: "Validated", issues: [], warnings: [] },
)

/* ------------- Quick Create parity (issue #31, D19/D23/D29, P1) ----------- */

// Quick Create maps its form values onto the wizard's draft shape
// (quickSchemeDraftFromValues) and shares record creation from there, so
// parity is asserted at the mapping seam plus the domain rules over mapped
// drafts — there is no second create path to compare against.

const quickValues: Record<string, string | boolean | undefined> = {
  schemeName: " Nørrebro glass ",
  projectId: "project-cph",
  planningAreaId: "area-norrebro",
  calendarId: "calendar-central",
  frequency: "every-2-weeks",
  weekRotation: "even",
  serviceDays: "sunday, wednesday",
  effectiveFrom: "2026-09-01",
  effectiveTo: "",
  plannedStartTime: "07:00",
  contractorId: "",
  plannedVehicleId: "vehicle-1",
  plannedDriverId: "driver-1",
  depotId: "depot-1",
  unloadingStationId: "depot-2",
  stopSelection: "rule",
  matchFractions: "Glass, Metal",
  matchVehicleType: "Glass crane",
  // Quick-only descriptor fields — never part of the draft.
  endBehavior: "depot",
  proposalSource: "internal",
}

const quickDraft = quickSchemeDraftFromValues(quickValues)

check("quick values map onto the wizard draft shape", quickDraft, {
  schemeName: "Nørrebro glass",
  projectId: "project-cph",
  planningAreaId: "area-norrebro",
  calendarId: "calendar-central",
  frequency: "every-2-weeks",
  weekRotation: "even",
  serviceDays: ["wednesday", "sunday"],
  effectiveFrom: "2026-09-01",
  effectiveTo: "",
  plannedStartTime: "07:00",
  plannedVehicleId: "vehicle-1",
  plannedDriverId: "driver-1",
  depotId: "depot-1",
  unloadingStationId: "depot-2",
  stopSelection: "rule",
  sameAllDays: true,
  sharedContainerIds: [],
  containersByDay: {},
  matchRule: { fractions: ["Glass", "Metal"], vehicleType: "Glass crane" },
  matchRulesByDay: {},
} satisfies GuidedSchemeData)

check(
  "single-rule by design (D29): per-day and manual stray values are ignored",
  quickSchemeDraftFromValues({
    ...quickValues,
    sameAllDays: false,
    matchRulesByDay: JSON.stringify({ sunday: { fractions: ["Paper"] } }),
    containerIds: "c1,c2",
    containersByDay: JSON.stringify({ sunday: ["c1"] }),
  }),
  quickDraft,
)

check(
  "manual stop selection is preserved with empty lists, never converted to a rule",
  (() => {
    const draft = quickSchemeDraftFromValues({
      ...quickValues,
      stopSelection: "manual",
    })
    return {
      stopSelection: draft.stopSelection,
      sharedContainerIds: draft.sharedContainerIds,
    }
  })(),
  { stopSelection: "manual", sharedContainerIds: [] },
)

check(
  "wizard defaults fill unknown frequency and rotation; an empty start time stays empty (issue #32)",
  (() => {
    const draft = quickSchemeDraftFromValues({
      schemeName: "Fallbacks",
      frequency: "four-week",
      weekRotation: "",
      plannedStartTime: "",
    })
    return [draft.frequency, draft.weekRotation, draft.plannedStartTime]
  })(),
  ["weekly", "odd", ""],
)

// The domain rules over a mapped quick draft — the same validateScheme the
// wizard runs, composed the way the create path composes it (one shared rule
// across every service day, matches pre-resolved by the caller).
const quickValidation = (
  draft: GuidedSchemeData,
  matchedCount: number,
) =>
  validateScheme(
    {
      serviceDays: draft.serviceDays,
      effectiveFrom: draft.effectiveFrom,
      effectiveTo: draft.effectiveTo,
      plans: {
        sameAllDays: draft.sameAllDays,
        sharedContainerIds: draft.sharedContainerIds,
        containersByDay: draft.containersByDay,
      },
      plannedVehicleId: draft.plannedVehicleId,
      plannedDriverId: draft.plannedDriverId,
      ...(draft.stopSelection === "rule"
        ? {
            stopMatching: {
              areaId: draft.planningAreaId,
              sameAllDays: true,
              dayRules: draft.serviceDays.map((day) => ({
                day,
                fractions: draft.matchRule.fractions,
                vehicleType: draft.matchRule.vehicleType,
                matchedCount,
              })),
            },
          }
        : {}),
    },
    [],
  )

check(
  "valid quick draft with an open-ended effective period → Validated (D23)",
  quickValidation(quickDraft, 3),
  { status: "Validated", issues: [], warnings: [] },
)

check(
  "quick draft with effective to before from → Draft, named issue",
  quickValidation({ ...quickDraft, effectiveTo: "2026-08-31" }, 3).issues,
  ["Effective to must be on or after effective from"],
)

check(
  "quick draft whose rule matches zero containers → Draft, blocking (FR-18)",
  quickValidation(quickDraft, 0),
  {
    status: "Draft",
    issues: ["No containers currently match the stop rule"],
    warnings: [],
  },
)

check(
  "quick draft without a planning area → Draft, named issue",
  quickValidation({ ...quickDraft, planningAreaId: undefined }, 3).issues,
  ["Pick a planning area — the stop rule matches containers inside it"],
)

check(
  "manual quick draft blocks with the wizard's missing-containers issue",
  quickValidation(
    quickSchemeDraftFromValues({ ...quickValues, stopSelection: "manual" }),
    0,
  ).issues,
  ["Pick at least one container"],
)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
