// The Cairo project the project-calendar tests resolve (not a test file
// itself): the Egyptian public holidays the round-3 brief pins its table on,
// Egypt's Friday–Saturday weekend, and its Sun–Thu weekly scheme. The domain's
// occurrence tests keep their own copy beside them.

import type { ServiceDay } from "@waste/domain/days"
import type { SchemeCalendar } from "@waste/domain/planning/occurrences"
import type { SchemeRecurrence } from "@waste/domain/planning/recurrence"

// Armed Forces Day (Tue), Coptic Christmas (Thu), Revolution Day (Mon), Eid
// al-Fitr (Mon, Tue), Sinai Liberation Day (Sun).
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
