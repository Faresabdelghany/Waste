// Headless checks for the derived Collection Calendars list presentation
// (issue #27; docs/new-changes/SPEC.md area J, decisions D13/D22/D28iii):
// KPI tiles and table row summaries derive from each calendar record's
// structured submittedValues plus an explicit `today` — never from display
// facts or the module's static metrics.
// Run: npx tsx scripts/collection-calendar-list-harness.ts
import type { BusinessRecord } from "../lib/data/business-modules"
import {
  calendarKpis,
  calendarRowSummary,
  formatHolidaySpan,
  formatValidity,
  formatWorkingDays,
  nextHolidaySpan,
  withDerivedCalendarValue,
} from "../lib/route-schemes/calendar-list"

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

const TODAY = "2026-08-31"

function makeCalendar(
  id: string,
  status: string,
  submittedValues: Record<string, string> | undefined,
  value = "",
): BusinessRecord {
  return {
    id,
    name: id,
    context: "",
    status,
    owner: "",
    value,
    updated: "",
    description: "",
    facts: {},
    related: [],
    source: "",
    freshness: "",
    submittedValues,
  }
}

const CENTRAL_HOLIDAYS =
  "2026-01-01, 2026-04-02, 2026-04-03, 2026-04-05, 2026-04-06, 2026-05-14, 2026-05-24, 2026-05-25, 2026-06-05, 2026-12-25, 2026-12-26"

const central = makeCalendar(
  "calendar-central",
  "Active",
  {
    calendarName: "Copenhagen Central 2026",
    weekStart: "monday",
    workingDays: "monday, tuesday, wednesday, thursday, friday",
    holidayDates: CENTRAL_HOLIDAYS,
    validFrom: "2026-01-01",
    validTo: "2026-12-31",
    timezone: "Europe/Copenhagen",
  },
  "25–26 Dec",
)

const harbor = makeCalendar("calendar-harbor", "Draft", {
  calendarName: "Harbor Offices service calendar",
  weekStart: "monday",
  workingDays: "tuesday, friday",
  holidayDates: "",
  validFrom: "2026-09-01",
  validTo: "2027-08-31",
  timezone: "Europe/Copenhagen",
})

const legacy = makeCalendar("calendar-legacy", "Active", undefined, "12 Oct")

/* ----------------------------- nextHolidaySpan ---------------------------- */

check("no holidays → no span", nextHolidaySpan([], TODAY), [])
check(
  "all past holidays → no span",
  nextHolidaySpan(["2026-01-01", "2026-06-05"], TODAY),
  [],
)
check(
  "a holiday today starts the span",
  nextHolidaySpan(["2026-08-31"], TODAY),
  ["2026-08-31"],
)
check(
  "consecutive dates extend the span",
  nextHolidaySpan(["2026-12-25", "2026-12-26"], TODAY),
  ["2026-12-25", "2026-12-26"],
)
check(
  "a gap ends the span",
  nextHolidaySpan(["2026-12-24", "2026-12-26"], TODAY),
  ["2026-12-24"],
)
check(
  "unsorted input is sorted before spanning",
  nextHolidaySpan(["2026-12-26", "2026-12-25"], TODAY),
  ["2026-12-25", "2026-12-26"],
)
check(
  "the Easter run stops at the first missing day",
  nextHolidaySpan(
    ["2026-04-02", "2026-04-03", "2026-04-05", "2026-04-06"],
    "2026-03-01",
  ),
  ["2026-04-02", "2026-04-03"],
)

/* ---------------------------- formatHolidaySpan --------------------------- */

check("empty span renders an em dash", formatHolidaySpan([]), "—")
check("single date renders day + month", formatHolidaySpan(["2026-12-25"]), "25 Dec")
check(
  "same-month span collapses to one month",
  formatHolidaySpan(["2026-12-25", "2026-12-26"]),
  "25–26 Dec",
)
check(
  "three-day same-month span keeps first–last",
  formatHolidaySpan(["2026-04-03", "2026-04-04", "2026-04-05"]),
  "3–5 Apr",
)
check(
  "cross-month span names both months",
  formatHolidaySpan(["2026-12-31", "2027-01-01"]),
  "31 Dec – 1 Jan",
)

/* ---------------------------- formatWorkingDays --------------------------- */

check("no working days renders an em dash", formatWorkingDays([]), "—")
check("single day renders its short label", formatWorkingDays(["monday"]), "Mon")
check(
  "a contiguous run renders first–last",
  formatWorkingDays(["monday", "tuesday", "wednesday", "thursday", "friday"]),
  "Mon–Fri",
)
check(
  "the weekend run is contiguous too",
  formatWorkingDays(["saturday", "sunday"]),
  "Sat–Sun",
)
check(
  "all seven days render as Mon–Sun",
  formatWorkingDays([
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
  ]),
  "Mon–Sun",
)
check(
  "non-contiguous days join with slashes",
  formatWorkingDays(["tuesday", "friday"]),
  "Tue/Fri",
)
check(
  "unsorted input is ordered Monday-first",
  formatWorkingDays(["friday", "monday", "wednesday"]),
  "Mon/Wed/Fri",
)

/* ------------------------------ formatValidity ---------------------------- */

check("no validity renders an em dash", formatValidity("", ""), "—")
check("open end renders From", formatValidity("2026-01-01", ""), "From 1 Jan 2026")
check("open start renders Until", formatValidity("", "2026-12-31"), "Until 31 Dec 2026")
check(
  "same-year range omits the first year",
  formatValidity("2026-01-01", "2026-12-31"),
  "1 Jan – 31 Dec 2026",
)
check(
  "cross-year range keeps both years",
  formatValidity("2026-09-01", "2027-08-31"),
  "1 Sep 2026 – 31 Aug 2027",
)

/* ---------------------------- calendarRowSummary -------------------------- */

check(
  "the central fixture derives the artboard row",
  calendarRowSummary(central, TODAY),
  {
    workingDays: "Mon–Fri",
    holidays: "11",
    validity: "1 Jan – 31 Dec 2026",
    nextHoliday: "25–26 Dec",
  },
)
check(
  "the harbor draft derives honest values (no invented holidays)",
  calendarRowSummary(harbor, TODAY),
  {
    workingDays: "Tue/Fri",
    holidays: "0",
    validity: "1 Sep 2026 – 31 Aug 2027",
    nextHoliday: "—",
  },
)
check(
  "a record without structured data derives nothing",
  calendarRowSummary(legacy, TODAY),
  { workingDays: "—", holidays: "—", validity: "—", nextHoliday: "—" },
)
check(
  "a missing record derives nothing",
  calendarRowSummary(undefined, TODAY),
  { workingDays: "—", holidays: "—", validity: "—", nextHoliday: "—" },
)

/* -------------------------- withDerivedCalendarValue ---------------------- */

check(
  "an already-correct stored value keeps the same object (referential stability)",
  withDerivedCalendarValue(central, TODAY) === central,
  true,
)
check(
  "a stale placeholder value is replaced by the derived next holiday",
  withDerivedCalendarValue(
    makeCalendar("calendar-new", "Draft", central.submittedValues as Record<string, string>, "Create calendar"),
    TODAY,
  ).value,
  "25–26 Dec",
)
check(
  "no upcoming holidays derive an em dash value",
  withDerivedCalendarValue(harbor, TODAY).value,
  "—",
)
check(
  "a record without structured data keeps its stored value untouched",
  withDerivedCalendarValue(legacy, TODAY) === legacy,
  true,
)

/* -------------------------------- calendarKpis ---------------------------- */

const fixtureTiles = calendarKpis([central, harbor], TODAY)
check(
  "fixture tiles derive from real records (D13), never illustrative numbers",
  fixtureTiles,
  [
    { label: "Active calendars", value: "1", helper: "1 Draft" },
    { label: "Upcoming holidays", value: "0", helper: "Next: 25 Dec" },
    {
      label: "Working-day rules",
      value: "2",
      helper: "All calendars configured",
      tone: "positive",
    },
    { label: "Expiring within 90d", value: "0", helper: "Earliest: 31 Dec 2026" },
  ],
)

check(
  "no calendars → zero tiles with honest helpers",
  calendarKpis([], TODAY),
  [
    { label: "Active calendars", value: "0", helper: "No calendars yet" },
    { label: "Upcoming holidays", value: "0", helper: "None scheduled" },
    { label: "Working-day rules", value: "0", helper: "No calendars yet" },
    { label: "Expiring within 90d", value: "0", helper: "No end dates set" },
  ],
)

const expiring = makeCalendar("calendar-expiring", "Active", {
  workingDays: "monday",
  holidayDates: "2026-09-15",
  validFrom: "2026-01-01",
  validTo: "2026-09-30",
})
const expiringTiles = calendarKpis([expiring, legacy], TODAY)
check(
  "a validity end inside 90 days counts and warns, naming the earliest end",
  expiringTiles[3],
  {
    label: "Expiring within 90d",
    value: "1",
    helper: "Earliest: 30 Sep 2026",
    tone: "warning",
  },
)
check(
  "a record without structured data counts as missing working-day rules",
  expiringTiles[2],
  {
    label: "Working-day rules",
    value: "1",
    helper: "1 calendar without rules",
    tone: "warning",
  },
)
check(
  "all calendars active reads as such",
  calendarKpis([expiring], TODAY)[0],
  { label: "Active calendars", value: "1", helper: "All calendars active" },
)
check(
  "holidays inside the 60-day window count distinct dates across calendars",
  calendarKpis(
    [
      expiring,
      makeCalendar("calendar-b", "Active", {
        workingDays: "monday",
        holidayDates: "2026-09-15, 2026-09-20",
      }),
    ],
    TODAY,
  )[1],
  { label: "Upcoming holidays", value: "2", helper: "Within 60 days" },
)
check(
  "an ended validity window reads as ended, not expiring",
  calendarKpis(
    [
      makeCalendar("calendar-old", "Superseded", {
        workingDays: "monday",
        validFrom: "2025-01-01",
        validTo: "2025-12-31",
      }),
    ],
    TODAY,
  )[3],
  { label: "Expiring within 90d", value: "0", helper: "All validity ended" },
)
check(
  "non-active statuses break down deterministically (count desc, then name)",
  calendarKpis(
    [
      makeCalendar("a", "Draft", { workingDays: "monday" }),
      makeCalendar("b", "Archived", { workingDays: "monday" }),
      makeCalendar("c", "Archived", { workingDays: "monday" }),
    ],
    TODAY,
  )[0],
  { label: "Active calendars", value: "0", helper: "2 Archived · 1 Draft" },
)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
