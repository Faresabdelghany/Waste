// Headless checks for the Route Scheme recurrence engine (spec FR-3/FR-4,
// ticket #4): matches(date) semantics, ISO-week parity, once-a-month =
// first occurrence of each selected weekday, date preview, identity keys.
// Run: npx tsx scripts/route-scheme-recurrence-harness.ts
import {
  addDays,
  formatServiceDate,
  isoWeek,
  isoWeekRotation,
  matchesRecurrence,
  nextServiceDates,
  parseServiceDays,
  recurrenceFromValues,
  recurrenceSentence,
  routeIdentityKey,
  serviceDayOf,
  type SchemeRecurrence,
} from "../lib/route-schemes/recurrence"

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

// Ground truth: 2026-08-28 is a Friday (the spec's canonical "today").

/* ------------------------------- date math ------------------------------ */

check("serviceDayOf: 2026-08-28 is friday", serviceDayOf("2026-08-28"), "friday")
check("serviceDayOf: 2026-08-30 is sunday", serviceDayOf("2026-08-30"), "sunday")
check("addDays: +1 crosses month end", addDays("2026-08-31", 1), "2026-09-01")
check("addDays: +7 plain week", addDays("2026-08-28", 7), "2026-09-04")

check("isoWeek: 2026-01-01 is week 1", isoWeek("2026-01-01"), 1)
check("isoWeek: 2026-08-30 is week 35", isoWeek("2026-08-30"), 35)
check("isoWeek: 2027-01-01 belongs to week 53 of 2026", isoWeek("2027-01-01"), 53)
check("isoWeekRotation: week 35 is odd", isoWeekRotation("2026-08-30"), "odd")
check("isoWeekRotation: week 36 is even", isoWeekRotation("2026-09-06"), "even")

/* ------------------------------ matches() ------------------------------- */

const weeklySunday: SchemeRecurrence = {
  frequency: "weekly",
  serviceDays: ["sunday"],
  effectiveFrom: "2026-08-28",
  effectiveTo: "2026-12-31",
}

check("weekly: sunday inside window matches", matchesRecurrence(weeklySunday, "2026-08-30"), true)
check("weekly: saturday does not match", matchesRecurrence(weeklySunday, "2026-08-29"), false)
check(
  "weekly: sunday before effectiveFrom does not match",
  matchesRecurrence({ ...weeklySunday, effectiveFrom: "2026-09-01" }, "2026-08-30"),
  false,
)
check(
  "weekly: sunday after effectiveTo does not match",
  matchesRecurrence({ ...weeklySunday, effectiveTo: "2026-09-01" }, "2026-09-06"),
  false,
)
check(
  "weekly: effective bounds are inclusive",
  matchesRecurrence({ ...weeklySunday, effectiveFrom: "2026-08-30", effectiveTo: "2026-08-30" }, "2026-08-30"),
  true,
)
check(
  "weekly: empty effectiveTo means open-ended",
  matchesRecurrence({ ...weeklySunday, effectiveTo: "" }, "2027-06-06"),
  true,
)

const biweeklyOdd: SchemeRecurrence = { ...weeklySunday, frequency: "every-2-weeks", weekRotation: "odd" }
check("every-2-weeks odd: week 35 sunday matches", matchesRecurrence(biweeklyOdd, "2026-08-30"), true)
check("every-2-weeks odd: week 36 sunday skipped", matchesRecurrence(biweeklyOdd, "2026-09-06"), false)
check("every-2-weeks odd: week 37 sunday matches", matchesRecurrence(biweeklyOdd, "2026-09-13"), true)
check(
  "every-2-weeks even: week 36 sunday matches",
  matchesRecurrence({ ...biweeklyOdd, weekRotation: "even" }, "2026-09-06"),
  true,
)

const monthlyWednesday: SchemeRecurrence = {
  frequency: "monthly",
  serviceDays: ["wednesday"],
  effectiveFrom: "2026-08-28",
  effectiveTo: "2027-06-30",
}
check("monthly: first wednesday of month matches", matchesRecurrence(monthlyWednesday, "2026-09-02"), true)
check("monthly: second wednesday does not match", matchesRecurrence(monthlyWednesday, "2026-09-09"), false)
check("monthly: first wednesday on day 7 still matches", matchesRecurrence(monthlyWednesday, "2026-10-07"), true)

/* --------------------------- nextServiceDates --------------------------- */

check(
  "preview: weekly sunday, first 4 dates",
  nextServiceDates(weeklySunday, { from: "2026-08-29", count: 4 }),
  ["2026-08-30", "2026-09-06", "2026-09-13", "2026-09-20"],
)
check(
  "preview: window end truncates the list",
  nextServiceDates({ ...weeklySunday, effectiveTo: "2026-09-30" }, { from: "2026-08-29", count: 8 }),
  ["2026-08-30", "2026-09-06", "2026-09-13", "2026-09-20", "2026-09-27"],
)
check(
  "preview: effectiveFrom in the future shifts the first date",
  nextServiceDates({ ...weeklySunday, effectiveFrom: "2026-09-01" }, { from: "2026-08-29", count: 2 }),
  ["2026-09-06", "2026-09-13"],
)
check(
  "preview: every-2-weeks odd skips even weeks",
  nextServiceDates(biweeklyOdd, { from: "2026-08-29", count: 3 }),
  ["2026-08-30", "2026-09-13", "2026-09-27"],
)
check(
  "preview: monthly wednesday spans months",
  nextServiceDates(monthlyWednesday, { from: "2026-08-29", count: 4 }),
  ["2026-09-02", "2026-10-07", "2026-11-04", "2026-12-02"],
)
check(
  "preview: monthly wed+sun previews first occurrence of each day",
  nextServiceDates(
    { ...monthlyWednesday, serviceDays: ["wednesday", "sunday"] },
    { from: "2026-08-29", count: 4 },
  ),
  ["2026-09-02", "2026-09-06", "2026-10-04", "2026-10-07"],
)
check(
  "preview: several weekly days interleave in date order",
  nextServiceDates({ ...weeklySunday, serviceDays: ["sunday", "wednesday"] }, { from: "2026-08-29", count: 4 }),
  ["2026-08-30", "2026-09-02", "2026-09-06", "2026-09-09"],
)
check("preview: no service days yields nothing", nextServiceDates({ ...weeklySunday, serviceDays: [] }, { from: "2026-08-29", count: 8 }), [])

/* ------------------------- sentences & formatting ----------------------- */

check(
  "sentence: weekly",
  recurrenceSentence({ ...weeklySunday, serviceDays: ["thursday", "monday"] }),
  "Every week on Mon, Thu",
)
check("sentence: every 2 weeks", recurrenceSentence(biweeklyOdd), "Every 2 weeks (odd ISO weeks) on Sun")
check("sentence: monthly", recurrenceSentence(monthlyWednesday), "Once a month (first Wed of the month)")
check("sentence: no days", recurrenceSentence({ ...weeklySunday, serviceDays: [] }), "No service days selected")
check("formatServiceDate", formatServiceDate("2026-08-30"), "Sun 30 Aug")

/* ------------------------------- identity ------------------------------- */

check("routeIdentityKey is deterministic", routeIdentityKey("scheme-central-a", "2026-08-30"), "scheme-central-a:2026-08-30")

/* --------------------------- form-value parsing -------------------------- */

check("parseServiceDays: comma list, sorted Mon-first", parseServiceDays("thursday, monday"), ["monday", "thursday"])
check("parseServiceDays: unknown tokens dropped", parseServiceDays("monday, someday"), ["monday"])

const formValues = {
  frequency: "every-2-weeks",
  serviceDays: "sunday",
  weekRotation: "odd",
  effectiveFrom: "2026-08-28",
  effectiveTo: "2026-12-31",
  plannedStartTime: "06:30",
}
check("recurrenceFromValues: full round trip", recurrenceFromValues(formValues), {
  frequency: "every-2-weeks",
  serviceDays: ["sunday"],
  weekRotation: "odd",
  effectiveFrom: "2026-08-28",
  effectiveTo: "2026-12-31",
  startTime: "06:30",
})
check(
  "recurrenceFromValues: every-2-weeks without rotation is incomplete",
  recurrenceFromValues({ ...formValues, weekRotation: "" }),
  null,
)
check(
  "recurrenceFromValues: weekly ignores rotation",
  recurrenceFromValues({ ...formValues, frequency: "weekly", weekRotation: "" }),
  {
    frequency: "weekly",
    serviceDays: ["sunday"],
    effectiveFrom: "2026-08-28",
    effectiveTo: "2026-12-31",
    startTime: "06:30",
  },
)
check("recurrenceFromValues: missing frequency is incomplete", recurrenceFromValues({ ...formValues, frequency: "" }), null)
check(
  "recurrenceFromValues: Object.prototype keys are not frequencies",
  ["toString", "constructor", "hasOwnProperty", "valueOf"].map((frequency) =>
    recurrenceFromValues({ ...formValues, frequency }),
  ),
  [null, null, null, null],
)
check(
  "recurrenceFromValues: malformed effectiveFrom is rejected",
  ["9999-99", "9999-99-99", "2026-02-30"].map((effectiveFrom) =>
    recurrenceFromValues({ ...formValues, effectiveFrom }),
  ),
  [null, null, null],
)
check(
  "recurrenceFromValues: malformed effectiveTo is rejected",
  recurrenceFromValues({ ...formValues, effectiveTo: "garbage" }),
  null,
)
check("recurrenceFromValues: no service days is incomplete", recurrenceFromValues({ ...formValues, serviceDays: "" }), null)
check(
  "recurrenceFromValues: missing effectiveFrom is incomplete",
  recurrenceFromValues({ ...formValues, effectiveFrom: "" }),
  null,
)
check(
  "recurrenceFromValues: open-ended effectiveTo is allowed",
  recurrenceFromValues({ ...formValues, frequency: "weekly", effectiveTo: "" }),
  {
    frequency: "weekly",
    serviceDays: ["sunday"],
    effectiveFrom: "2026-08-28",
    effectiveTo: "",
    startTime: "06:30",
  },
)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
