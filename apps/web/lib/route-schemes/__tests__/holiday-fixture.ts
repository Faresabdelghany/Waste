// Shared fixtures for the holiday regression tests (not a test file itself):
// one Danish and one Egyptian project, each with its holiday dates, weekend,
// and the weekly recurrence the round-2 / round-3 briefs pin their values on.

import type { SchemeCalendar } from "../occurrences"
import type { SchemeRecurrence, ServiceDay } from "../recurrence"

// The Danish public holidays of Sep 2026 – Dec 2027 (plus Christmas Eve and
// New Year's Eve) — the regression fixture the redesign brief pins its
// values on. Names resolve through the holiday-name lookup.
export const REGRESSION_HOLIDAY_DATES = [
  "2026-12-24",
  "2026-12-25",
  "2026-12-26",
  "2026-12-31",
  "2027-01-01",
  "2027-03-25",
  "2027-03-26",
  "2027-03-29",
  "2027-05-06",
  "2027-05-17",
  "2027-06-05",
  "2027-12-24",
]

export const DANISH_WEEKEND: readonly ServiceDay[] = ["saturday", "sunday"]

export const weekdays: SchemeRecurrence = {
  frequency: "weekly",
  serviceDays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
  effectiveFrom: "2026-09-13",
  effectiveTo: "",
}

// Egyptian public holidays the round-3 brief pins its table on: Armed Forces
// Day (Tue), Coptic Christmas (Thu), Revolution Day (Mon), Eid al-Fitr (Mon,
// Tue), Sinai Liberation Day (Sun). Egypt's weekend is Friday–Saturday.
export const EGYPT_HOLIDAY_DATES = [
  "2026-10-06",
  "2027-01-07",
  "2027-01-25",
  "2027-03-08",
  "2027-03-09",
  "2027-04-25",
]

export const EGYPT_WEEKEND: readonly ServiceDay[] = ["friday", "saturday"]

/** Sun–Thu weekly from 13 Sep 2026, open-ended — the Cairo scheme. */
export const sunToThu: SchemeRecurrence = {
  frequency: "weekly",
  serviceDays: ["sunday", "monday", "tuesday", "wednesday", "thursday"],
  effectiveFrom: "2026-09-13",
  effectiveTo: "",
}

export const calendarOf = (
  holidays: SchemeCalendar["holidays"],
  weekend: readonly ServiceDay[],
): SchemeCalendar => ({ holidays, weekend: [...weekend] })
