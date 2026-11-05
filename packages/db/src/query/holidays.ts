// A project's holidays (2026-11-05): the days of the company's Holiday List
// the project names (`project.holiday_list`, a key into `holiday_list` by
// name), each with the name a person gave it. Every reader of a project's
// holidays — generation, the occurrence read, a route's operating day, the
// held routes a change re-decides, the collection days, the public map and
// the bulky bookings — reads them here, so none reads a Collection
// Calendar's holidays, which nothing reads any more. A project without a list
// has none; `holidayListOf` (@waste/domain/planning/generation) names them.
import type { StoredHoliday } from "@waste/domain/planning/generation"
import { and, asc, eq, gte, lte, type SQL } from "drizzle-orm"

import type { Tx } from "../client"
import { holidayList, holidayListHoliday } from "../schema/organisation"

/** Both ends included, as ISO days. */
export type HolidayWindow = { from?: string; to?: string }

/**
 * The days of the company's list named `listName`, inside the window where
 * one is given, in date order; none for no list. Fenced by the company: the
 * caller's transaction carries its tenant, and the key says it again.
 */
export async function listHolidayRows(tx: Tx, companyId: string, listName: string | null, window: HolidayWindow = {}): Promise<StoredHoliday[]> {
  if (listName === null) return []
  const conditions: SQL[] = [eq(holidayList.companyId, companyId), eq(holidayList.name, listName)]
  if (window.from !== undefined) conditions.push(gte(holidayListHoliday.day, window.from))
  if (window.to !== undefined) conditions.push(lte(holidayListHoliday.day, window.to))
  return tx
    .select({ day: holidayListHoliday.day, name: holidayListHoliday.name })
    .from(holidayListHoliday)
    .innerJoin(holidayList, and(eq(holidayList.companyId, holidayListHoliday.companyId), eq(holidayList.id, holidayListHoliday.holidayListId)))
    .where(and(...conditions))
    .orderBy(asc(holidayListHoliday.day))
}
