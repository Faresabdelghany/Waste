// The demo company's Holiday Lists (Settings › Operations › Holiday lists,
// 2026-11-05): one per list its projects name — Danish for Copenhagen
// Central, Egyptian for Cairo Operations — holding the fixtures' days, 22 and
// 9, named as the list's lookup names them (`holidayNamesFor`,
// @waste/domain/planning/holiday-names) and unnamed where it does not:
// Cairo's two Eid days of 2027. They are the days the seed once wrote on the
// projects' Collection Calendars, which the Holiday Lists' migration carried onto the lists
// before the calendars' holidays were dropped, so a run after the migrations
// finds the days as they should be and writes nothing. The migration minted
// its own ids for the lists, so a list the company already holds by its
// country or its name is left under the id it has, and its days are written
// against that id; the days are a set `PUT
// /holiday-lists/:id/holidays` replaces whole, written through `replaceSets`.
// The lists are written before the projects, whose `holiday_list` is a key
// into them.
import { holidayNamesFor, knownHolidayListCountry } from "@waste/domain/planning/holiday-names"
import { and, eq, inArray } from "drizzle-orm"

import type { Tx } from "../client"
import { holidayList, holidayListHoliday } from "../schema/organisation"
import { counted, DEMO_COMPANY_ID } from "./ids"
import { replaceSets } from "./upsert"

/** Each list the projects name (demo.ts spells the name on the project), with its days. */
const SPECS: readonly { name: string; days: readonly string[] }[] = [
  {
    name: "Danish public holidays",
    days: [
      ...["2026-01-01", "2026-04-02", "2026-04-03", "2026-04-05", "2026-04-06", "2026-05-14", "2026-05-24", "2026-05-25", "2026-06-05", "2026-12-25", "2026-12-26"],
      ...["2027-01-01", "2027-03-25", "2027-03-26", "2027-03-28", "2027-03-29", "2027-05-06", "2027-05-16", "2027-05-17", "2027-06-05", "2027-12-25", "2027-12-26"],
    ],
  },
  { name: "Egyptian public holidays", days: ["2026-10-06", "2027-01-07", "2027-01-25", "2027-03-08", "2027-03-09", "2027-04-25", "2027-05-01", "2027-06-30", "2027-07-23"] },
]

const NAMES: readonly string[] = SPECS.map((spec) => spec.name)

const nextList = counted("holidayList")
const LISTS: readonly (typeof holidayList.$inferInsert)[] = NAMES.map((name) => {
  const country = knownHolidayListCountry(name)
  if (country === undefined) throw new Error(`demo seed: the holiday list ${name} is of no country this system knows`)
  return { id: nextList(), companyId: DEMO_COMPANY_ID, country, name }
})

const DAYS: readonly { list: string; day: string }[] = SPECS.flatMap((spec) => [...new Set(spec.days)].sort().map((day) => ({ list: spec.name, day })))

/** Every holiday list id the seed writes on a fresh database, by name. */
export const HOLIDAY_LIST_IDS: Readonly<Record<string, string>> = Object.fromEntries(LISTS.map((row) => [row.name, row.id as string]))

export const HOLIDAY_LISTS_COUNTS = { holidayLists: LISTS.length, holidayListHolidays: DAYS.length }
export type HolidayListsCounts = typeof HOLIDAY_LISTS_COUNTS

/** Writes the lists the company lacks and every list's days into an open transaction, and answers how many rows it wrote. */
export async function applyHolidayLists(tx: Tx): Promise<number> {
  let changed = (await tx.insert(holidayList).values([...LISTS]).onConflictDoNothing().returning({ id: holidayList.id })).length
  const held = await tx
    .select({ id: holidayList.id, name: holidayList.name })
    .from(holidayList)
    .where(and(eq(holidayList.companyId, DEMO_COMPANY_ID), inArray(holidayList.name, [...NAMES])))
  const idOf = new Map(held.map((row) => [row.name, row.id]))
  const nextDay = counted("holidayListHoliday")
  const rows: (typeof holidayListHoliday.$inferInsert)[] = DAYS.flatMap(({ list, day }) => {
    const holidayListId = idOf.get(list)
    // A list the company holds under another name, by the same country, keeps its own days.
    if (holidayListId === undefined) return []
    return [{ id: nextDay(), companyId: DEMO_COMPANY_ID, holidayListId, day, name: holidayNamesFor(list)(day) ?? null }]
  })
  changed += await replaceSets(tx, {
    table: holidayListHoliday,
    of: holidayListHoliday.holidayListId,
    parents: [...idOf.values()],
    rows,
    compared: [holidayListHoliday.day, holidayListHoliday.name],
  })
  return changed
}
