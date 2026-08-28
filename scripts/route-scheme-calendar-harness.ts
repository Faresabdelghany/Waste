// Headless checks for the Collection Calendar model (spec
// docs/specs/PLAN_SIMPLIFICATION.md §1, decisions Q5/Q6/Q9): parsing the
// structured calendar fields from a record, validity coverage, and the
// per-date working / holiday / non-working / uncovered verdicts generation
// consumes.
// Run: npx tsx scripts/route-scheme-calendar-harness.ts
import type { BusinessRecord } from "../lib/data/business-modules"
import {
  calendarCoversDate,
  calendarDayStatus,
  calendarFromRecord,
  parseHolidayDates,
  type CollectionCalendar,
} from "../lib/route-schemes/calendar"

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

/* ---------------------------- parseHolidayDates --------------------------- */

check(
  "comma-separated ISO dates parse, sorted and deduped",
  parseHolidayDates("2026-12-26, 2026-12-25, 2026-12-25"),
  ["2026-12-25", "2026-12-26"],
)
check(
  "newline-separated dates parse too",
  parseHolidayDates("2026-01-01\n2026-06-05"),
  ["2026-01-01", "2026-06-05"],
)
check(
  "non-ISO and invalid dates are dropped",
  parseHolidayDates("25 Dec 2026, 2026-02-30, 2026-13-01, , 2026-04-03"),
  ["2026-04-03"],
)
check("empty and undefined parse to nothing", [
  parseHolidayDates(""),
  parseHolidayDates(undefined),
], [[], []])

/* ---------------------------- calendarFromRecord -------------------------- */

const calendarRecord: BusinessRecord = {
  id: "calendar-central",
  name: "Copenhagen Central 2026",
  context: "Copenhagen Central · Europe/Copenhagen",
  status: "Active",
  owner: "Operations Admin",
  value: "",
  updated: "",
  description: "",
  facts: { WeekStart: "Monday", Holidays: "2", WorkingDays: "Mon–Fri" },
  related: [],
  source: "",
  freshness: "",
  submittedValues: {
    calendarName: "Copenhagen Central 2026",
    weekStart: "monday",
    workingDays: "monday, tuesday, wednesday, thursday, friday",
    holidayDates: "2026-12-25, 2026-12-26",
    validFrom: "2026-01-01",
    validTo: "2026-12-31",
    timezone: "Europe/Copenhagen",
  },
}

check("a structured record parses to a calendar", calendarFromRecord(calendarRecord), {
  id: "calendar-central",
  name: "Copenhagen Central 2026",
  status: "Active",
  workingDays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
  holidayDates: ["2026-12-25", "2026-12-26"],
  validFrom: "2026-01-01",
  validTo: "2026-12-31",
  timezone: "Europe/Copenhagen",
})

check("a missing record parses to null", calendarFromRecord(undefined), null)
check(
  "a record without structured fields parses to null (legacy display-only)",
  calendarFromRecord({ ...calendarRecord, submittedValues: undefined }),
  null,
)
check(
  "invalid validity dates are treated as unset",
  calendarFromRecord({
    ...calendarRecord,
    submittedValues: {
      ...calendarRecord.submittedValues,
      validFrom: "January 2026",
      validTo: "2026-02-30",
    },
  })?.validFrom,
  "",
)

/* ------------------------------ coverage ---------------------------------- */

const calendar = calendarFromRecord(calendarRecord) as CollectionCalendar

check("dates inside validity are covered", calendarCoversDate(calendar, "2026-06-15"), true)
check("dates before validity are not covered", calendarCoversDate(calendar, "2025-12-31"), false)
check("dates after validity are not covered", calendarCoversDate(calendar, "2027-01-01"), false)
check(
  "open-ended validity covers everything",
  calendarCoversDate({ ...calendar, validFrom: "", validTo: "" }, "2031-01-01"),
  true,
)

/* --------------------------- calendarDayStatus ----------------------------- */

check("a working weekday is working", calendarDayStatus(calendar, "2026-09-02"), "working")
check("a holiday is a holiday", calendarDayStatus(calendar, "2026-12-25"), "holiday")
check(
  "a weekend outside working days is non-working",
  calendarDayStatus(calendar, "2026-09-06"),
  "non-working",
)
check(
  "a holiday on a working weekday is still a holiday",
  calendarDayStatus({ ...calendar, holidayDates: ["2026-09-02"] }, "2026-09-02"),
  "holiday",
)
check(
  "a date outside validity is uncovered, never non-working",
  calendarDayStatus(calendar, "2027-01-03"),
  "uncovered",
)
check("no calendar at all is uncovered", calendarDayStatus(null, "2026-09-02"), "uncovered")
check(
  "empty working days constrain nothing",
  calendarDayStatus({ ...calendar, workingDays: [] }, "2026-09-06"),
  "working",
)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
