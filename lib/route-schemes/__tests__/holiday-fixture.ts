// Shared fixture for the holiday regression tests (not a test file itself).

import type { SchemeRecurrence } from "../recurrence"

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

export const weekdays: SchemeRecurrence = {
  frequency: "weekly",
  serviceDays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
  effectiveFrom: "2026-09-13",
  effectiveTo: "",
}
