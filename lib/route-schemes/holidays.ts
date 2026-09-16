// The holiday list a scheme's dates are judged against, read from records.
// Pure data logic (type-only import of BusinessRecord). The list itself is a
// date → name map (occurrences.ts HolidayList); names come from the Danish
// public-holiday lookup with "Holiday" as the fallback (holiday-names.ts),
// because the records store dates only.
//
// Today the list is the scheme's linked Collection Calendar (calendarId).

import type { BusinessRecord } from "../data/business-modules"
import { calendarFromRecord } from "./calendar"
import { holidayLabel } from "./holiday-names"
import {
  isHolidayPolicy,
  NO_HOLIDAYS,
  type HolidayList,
  type HolidayPolicy,
} from "./occurrences"
import { isIsoDate } from "./recurrence"
import { stringValue } from "./validation"

type StoredValues = Record<string, string | boolean | undefined>

/** Valid ISO dates → a sorted, named holiday list. */
export function holidayListFromDates(dates: Iterable<string>): HolidayList {
  const list = new Map<string, string>()
  for (const iso of [...new Set(dates)].filter(isIsoDate).sort()) {
    list.set(iso, holidayLabel(iso))
  }
  return list
}

/** The stored holiday policy; records that predate the field skip holidays, as they always did. */
export function schemeHolidayPolicy(values: StoredValues | undefined): HolidayPolicy {
  const policy = values?.holidayPolicy
  return isHolidayPolicy(policy) ? policy : "skip"
}

/** The holiday list the scheme generates against. */
export function schemeHolidayList(
  scheme: Pick<BusinessRecord, "submittedValues">,
  calendarRecords: readonly BusinessRecord[] | undefined,
): HolidayList {
  const calendarId = stringValue(scheme.submittedValues ?? {}, "calendarId")
  const calendar = calendarId
    ? calendarFromRecord(calendarRecords?.find((record) => record.id === calendarId))
    : null
  return calendar ? holidayListFromDates(calendar.holidayDates) : NO_HOLIDAYS
}
