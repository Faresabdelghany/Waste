// The demo company's Holiday Lists (Settings › Operations › Holiday lists,
// 2026-11-05): one per list its projects name — Danish for Copenhagen
// Central, Egyptian for Cairo Operations — holding every day its projects'
// calendars hold (planning.ts's `CALENDARS`), named as the list names them.
// That is what the Holiday Lists' migration makes of a database the seed
// wrote before it, so a run after the migration finds the days as they
// should be and writes nothing. The migration minted its own ids for the lists, so a list the
// company already holds by its country or its name is left under the id it
// has, and its days are written against that id; the days are a set `PUT
// /holiday-lists/:id/holidays` replaces whole, written through `replaceSets`.
// The lists are written before the projects, whose `holiday_list` is a key
// into them.
import { holidayNamesFor, knownHolidayListCountry } from "@waste/domain/route-schemes/holiday-names"
import { and, eq, inArray } from "drizzle-orm"

import type { Tx } from "../client"
import { holidayList, holidayListHoliday } from "../schema/organisation"
import { counted, DEMO_COMPANY_ID } from "./ids"
import { CALENDARS } from "./planning"
import { replaceSets } from "./upsert"

/** The list names the projects carry, in the calendars' order, each once. */
const NAMES: readonly string[] = [...new Set(CALENDARS.flatMap((spec) => (spec.holidayList === null ? [] : [spec.holidayList])))]

const nextList = counted("holidayList")
const LISTS: readonly (typeof holidayList.$inferInsert)[] = NAMES.map((name) => {
  const country = knownHolidayListCountry(name)
  if (country === undefined) throw new Error(`demo seed: the holiday list ${name} is of no country this system knows`)
  return { id: nextList(), companyId: DEMO_COMPANY_ID, country, name }
})

/** The days of each list, once a day, in date order. */
const DAYS: readonly { list: string; day: string }[] = NAMES.flatMap((name) =>
  [...new Set(CALENDARS.filter((spec) => spec.holidayList === name).flatMap((spec) => spec.holidays))].sort().map((day) => ({ list: name, day })),
)

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
