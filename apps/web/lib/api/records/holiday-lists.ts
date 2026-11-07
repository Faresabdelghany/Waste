// The company's Holiday Lists (Settings › Operations › Holiday lists,
// 2026-11-05) as records: the second kind of `configure.calendars`, the API's
// grant key for `/holiday-lists`, beside the per-year calendars. A list is
// `holiday-list-<uuid>` from the start, named, of one country, its days
// spelled as a calendar's are — `holidayDates` and `holidayNames` — so
// `resolveProjectCalendar` (@waste/domain/route-schemes/project-calendar)
// reads a project's holidays from the list it names. A list's days travel
// with it and are replaced whole through their own route; an edit that moves
// the name or the country and the days is two requests, the list first.
// Removing a list is an action (`REMOVE_HOLIDAY_LIST`), since the store has
// no delete: the API refuses a list a project still names, in its sentence.
import type { HolidayList, HolidayListHoliday } from "@waste/contracts/holiday-lists"
import { HOLIDAY_LIST_KEYS, HOLIDAY_LIST_KIND, HOLIDAY_LIST_PREFIX, holidayListEntries } from "@waste/domain/route-schemes/holiday-list-records"
import { holidayEntryValues } from "@waste/domain/route-schemes/holiday-lists"

import { type BusinessRecord } from "@/lib/data/business-modules"
import { COLLECTION_CALENDARS_MODULE } from "@/lib/data/collection-calendars"

import { create, get, listAll, patch, put, remove } from "../client"
import { NO_PRESENTATION, ofKind, patchOf, stampFacts, typed, webIdOf, type LocalRefusal, type RecordAction, type ResourceAdapter } from "./adapter"
import type { ActionOutcome, SendAction } from "./server-records"

const refusal = (path: string, message: string): LocalRefusal => ({ path, message })

/** The list's days as the wire spells them, from the record's typed values. */
function holidaysOf(record: BusinessRecord): HolidayListHoliday[] {
  return holidayListEntries(record).map((entry) => ({ day: entry.date, name: entry.name.trim() === "" ? null : entry.name.trim() }))
}

/** What a list's update carries: the list's own fields, the days, or both. */
type HolidayListWrite = { list?: { name?: string; country?: string }; holidays?: HolidayListHoliday[] }

/** The action that removes a list, answering nothing. */
export const REMOVE_HOLIDAY_LIST = "remove-holiday-list"

const actions: Readonly<Record<string, RecordAction<unknown>>> = {
  [REMOVE_HOLIDAY_LIST]: {
    run: (client, serverId) => remove(client, `/holiday-lists/${serverId}`).then(() => null),
    refused: (record) => `${record.name} was not removed`,
  },
}

export const holidayListAdapter: ResourceAdapter<HolidayList> = {
  prefix: HOLIDAY_LIST_PREFIX,
  auditTable: "holiday_list",
  owns: ofKind(HOLIDAY_LIST_PREFIX, [HOLIDAY_LIST_KIND]),
  // No status on the wire: a list is in use by the projects that name it.
  statuses: undefined,
  list: (client) => listAll<HolidayList>(client, "/holiday-lists"),
  toRecord: (list, context) => {
    const { holidayDates, holidayNames } = holidayEntryValues(list.holidays.map((holiday) => ({ date: holiday.day, name: holiday.name ?? "" })))
    const projects = `${list.projectCount} ${list.projectCount === 1 ? "project" : "projects"}`
    return {
      id: webIdOf(HOLIDAY_LIST_PREFIX, list.id),
      name: list.name,
      context: `${list.country} · ${projects}`,
      status: "Active",
      ...NO_PRESENTATION,
      ...stampFacts(list, context.now),
      value: "—",
      facts: { Country: list.country, Holidays: String(list.holidays.length), Projects: String(list.projectCount) },
      projectIds: [],
      recordKind: HOLIDAY_LIST_KIND,
      submittedValues: {
        [HOLIDAY_LIST_KEYS.name]: list.name,
        [HOLIDAY_LIST_KEYS.country]: list.country,
        [HOLIDAY_LIST_KEYS.dates]: holidayDates,
        ...(holidayNames === "" ? {} : { [HOLIDAY_LIST_KEYS.names]: holidayNames }),
        projectCount: String(list.projectCount),
      },
    }
  },
  toCreateBody: (record) => {
    const name = typed(record, HOLIDAY_LIST_KEYS.name) ?? record.name
    const country = typed(record, HOLIDAY_LIST_KEYS.country)
    if (!country) return refusal(HOLIDAY_LIST_KEYS.country, "Pick a country")
    return { country, name, holidays: holidaysOf(record) }
  },
  toPatchBody: (before, after) => {
    const list = patchOf(before, after, (record) => ({ name: typed(record, HOLIDAY_LIST_KEYS.name) ?? record.name, country: typed(record, HOLIDAY_LIST_KEYS.country) }))
    const was = holidaysOf(before)
    const is = holidaysOf(after)
    const holidays = JSON.stringify(was) === JSON.stringify(is) ? undefined : is
    if (list === null && holidays === undefined) return null
    const write: HolidayListWrite = { ...(list === null ? {} : { list }), ...(holidays === undefined ? {} : { holidays }) }
    return write
  },
  create: (client, body) => create<HolidayList>(client, "/holiday-lists", body).then((created) => created.body),
  // The list first, then the days; the answer is the list as it now stands.
  update: async (client, serverId, body) => {
    const write = body as HolidayListWrite
    let list: HolidayList | undefined
    if (write.list !== undefined) list = await patch<HolidayList>(client, `/holiday-lists/${serverId}`, write.list)
    if (write.holidays !== undefined) list = await put<HolidayList>(client, `/holiday-lists/${serverId}/holidays`, { holidays: write.holidays })
    return list ?? (await get<HolidayList>(client, `/holiday-lists/${serverId}`))
  },
  read: (client, serverId) => get<HolidayList>(client, `/holiday-lists/${serverId}`),
  actions,
}

/** Removes a list through the store's `sendAction`; the module is read again by the caller once it lands. */
export function removeHolidayList(sendAction: SendAction, recordId: string): Promise<ActionOutcome<null>> {
  return sendAction(COLLECTION_CALENDARS_MODULE.workspaceId, COLLECTION_CALENDARS_MODULE.moduleId, recordId, REMOVE_HOLIDAY_LIST) as Promise<ActionOutcome<null>>
}
