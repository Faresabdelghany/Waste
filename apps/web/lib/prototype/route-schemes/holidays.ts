// A holiday list's dates and names as a record spells them, and the
// scheme's holiday policy. Which list a project has — and whether it has one
// at all — is the project's explicit `holidayList` attribute, resolved in
// project-calendar.ts together with the weekend; since 2026-11-05 the list is
// the company's own record (holiday-list-records.ts), never the project's
// Collection Calendars, which carry no holidays. Pure data logic (type-only
// import of BusinessRecord).

import type { BusinessRecord } from "../prototype-record"
import { isHolidayPolicy, type HolidayPolicy } from "@waste/domain/planning/occurrences"
import { isIsoDate } from "@waste/domain/days"
import { stringValue } from "./validation"

type StoredValues = Record<string, string | boolean | undefined>

/** The stored holiday policy; records that predate the field skip holidays, as they always did. */
export function schemeHolidayPolicy(values: StoredValues | undefined): HolidayPolicy {
  const policy = values?.holidayPolicy
  return isHolidayPolicy(policy) ? policy : "skip"
}

/**
 * A holiday list record's `submittedValues` key for the names of its
 * holidays: a JSON object of ISO date to name, written by the Holiday lists
 * pane beside `holidayDates`. A list that carries none is named through its
 * lookup (@waste/domain/route-schemes/holiday-names).
 */
export const HOLIDAY_NAMES_KEY = "holidayNames"

/** The names a record carries, by date; anything that is not that object is no names. */
export function parseHolidayNames(raw: string | boolean | undefined): Map<string, string> {
  const names = new Map<string, string>()
  if (typeof raw !== "string" || raw.trim() === "") return names
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return names
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return names
  for (const [date, name] of Object.entries(parsed)) {
    if (isIsoDate(date) && typeof name === "string" && name.trim() !== "") {
      names.set(date, name.trim())
    }
  }
  return names
}

/** The names as the record stores them, keys in date order; blank for none. */
export function serializeHolidayNames(names: ReadonlyMap<string, string>): string {
  if (names.size === 0) return ""
  return JSON.stringify(Object.fromEntries([...names.entries()].sort(([a], [b]) => a.localeCompare(b))))
}

/** The project a stored scheme plans for: its typed projectId, else its record scope. */
export function schemeProjectId(
  scheme: Pick<BusinessRecord, "submittedValues" | "projectIds">,
): string | undefined {
  return stringValue(scheme.submittedValues ?? {}, "projectId") ?? scheme.projectIds?.[0]
}
