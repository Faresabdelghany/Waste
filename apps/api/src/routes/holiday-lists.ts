// The company's Holiday Lists (Settings › Operations › Holiday lists,
// 2026-11-05): one per country, with its days and their names, which every
// Project that rests on it names by the list's name (`project.holiday_list`,
// a key into `holiday_list` that follows a rename). `GET /holiday-lists`
// lists them with their days, `POST` adds one, `GET`/`PATCH`/`DELETE
// /holiday-lists/:id` read, rename or re-country and remove one, and `PUT
// /holiday-lists/:id/holidays` replaces its days whole.
//
// A list is the company's, not a project's, so it is fenced by the company
// alone; the grant is `configure.calendars`, the one a project's holidays
// were always edited under. A change of a list's days re-decides the holds
// of every project resting on it (#226, @waste/db/commands/route-holds), whatever
// projects the caller works in: the holds are the system's reading of the
// days, not the office's word. A list a project rests on cannot be deleted
// (409): the project is moved off it, or onto another, first.
import { HolidayList, HolidayListCreate, HolidayListHolidaysSet, HolidayListListQuery, HolidayListPatch, type HolidayListHoliday } from "@waste/contracts/holiday-lists"
import { Page } from "@waste/contracts/pagination"
import type { Tx } from "@waste/db/client"
import { holidayList, holidayListHoliday, project } from "@waste/db/schema/organisation"
import { and, asc, count, eq, inArray } from "drizzle-orm"
import { newId } from "@waste/db/ids"
import { changeProjectCalendars } from "@waste/db/commands/route-holds"
import { lockRow, refuseDuplicate, strengthFor } from "@waste/db/commands/shared"
import { stampsOf } from "@waste/db/shapes/times"
import type { RouteDeps } from "../deps"
import { created, describeCreated, describeJson, IdParam, routes } from "../operation"
import { pageAt } from "../pagination"
import { describeProblem, invalidRequest, problem } from "../problem"
import { scoped } from "../scoped"
import { stamp } from "./shared"

const MODULE = "configure.calendars"
const HolidayListPage = Page(HolidayList)

const columns = {
  id: holidayList.id,
  country: holidayList.country,
  name: holidayList.name,
  createdAt: holidayList.createdAt,
  updatedAt: holidayList.updatedAt,
}

type Row = Pick<typeof holidayList.$inferSelect, keyof typeof columns>
type Holiday = HolidayListHoliday

function listOf(row: Row, holidays: readonly Holiday[], projectCount: number): HolidayList {
  return { id: row.id, country: row.country, name: row.name, holidays: [...holidays], projectCount, ...stampsOf(row) }
}

/** `unique (company_id, country)` and `unique (company_id, name)`: each is one list's inside a company. */
const COUNTRY_TAKEN = "holiday_list_country_key"
const NAME_TAKEN = "holiday_list_name_key"
const countryTaken = (country: string) => `This company already has a holiday list for ${country}`
const nameTaken = (name: string) => `This company already has a holiday list called ${JSON.stringify(name)}`

const { noSuch: noSuchList, get: getList, list: listLists } = scoped(holidayList, { noun: "holiday list", reach: "company", columns })

export const NO_SUCH_HOLIDAY_LIST = "Not a holiday list of this company: add it in Settings › Holiday lists first"

/**
 * Holds a project body's `holidayList` to a list the company holds: a 400 at
 * the field where it holds none of that name. The project's key is the
 * backstop, and would answer 23503, a 500 saying nothing.
 */
export async function requireHolidayList(tx: Tx, companyId: string, name: string | null | undefined): Promise<void> {
  if (name == null) return
  const [found] = await tx
    .select({ id: holidayList.id })
    .from(holidayList)
    .where(and(eq(holidayList.companyId, companyId), eq(holidayList.name, name)))
    .limit(1)
  if (found === undefined) throw invalidRequest("body", [{ path: "holidayList", message: NO_SUCH_HOLIDAY_LIST }])
}

async function holidaysOf(tx: Tx, companyId: string, listIds: readonly string[]): Promise<Map<string, Holiday[]>> {
  const byList = new Map<string, Holiday[]>()
  if (listIds.length === 0) return byList
  const rows = await tx
    .select({ list: holidayListHoliday.holidayListId, day: holidayListHoliday.day, name: holidayListHoliday.name })
    .from(holidayListHoliday)
    .where(and(eq(holidayListHoliday.companyId, companyId), inArray(holidayListHoliday.holidayListId, [...listIds])))
    .orderBy(asc(holidayListHoliday.day))
  for (const row of rows) byList.set(row.list, [...(byList.get(row.list) ?? []), { day: row.day, name: row.name }])
  return byList
}

async function projectCountsOf(tx: Tx, companyId: string, names: readonly string[]): Promise<Map<string, number>> {
  if (names.length === 0) return new Map()
  const rows = await tx
    .select({ name: project.holidayList, projects: count() })
    .from(project)
    .where(and(eq(project.companyId, companyId), inArray(project.holidayList, [...names])))
    .groupBy(project.holidayList)
  return new Map(rows.flatMap((row) => (row.name === null ? [] : [[row.name, row.projects] as const])))
}

async function projectsOn(tx: Tx, companyId: string, name: string): Promise<string[]> {
  const rows = await tx
    .select({ id: project.id })
    .from(project)
    .where(and(eq(project.companyId, companyId), eq(project.holidayList, name)))
    .orderBy(asc(project.id))
  return rows.map((row) => row.id)
}

async function readList(tx: Tx, companyId: string, row: Row): Promise<HolidayList> {
  const holidays = (await holidaysOf(tx, companyId, [row.id])).get(row.id) ?? []
  const projects = (await projectCountsOf(tx, companyId, [row.name])).get(row.name) ?? 0
  return listOf(row, holidays, projects)
}

async function writeHolidays(tx: Tx, companyId: string, listId: string, holidays: readonly Holiday[]): Promise<void> {
  if (holidays.length === 0) return
  await tx.insert(holidayListHoliday).values(holidays.map((holiday) => ({ id: newId(), companyId, holidayListId: listId, day: holiday.day, name: holiday.name })))
}

/** The body's days in the order the table reads them back, by day, so a write answers what the next read says. */
const byDay = (holidays: readonly Holiday[]): Holiday[] => [...holidays].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))

export function holidayListRoutes(deps: RouteDeps) {
  return routes(deps)
    .get(
      "/holiday-lists",
      {
        operationId: "listHolidayLists",
        summary: "The company's holiday lists",
        description:
          "One page of the company's holiday lists, oldest first (ids are time-ordered), each with its days by day and how many of the company's projects rest on it. Hand `nextCursor` back as `cursor` for the next page.",
        module: MODULE,
        action: "view",
        query: HolidayListListQuery,
        responses: {
          200: describeJson("One page of holiday lists.", HolidayListPage),
        },
      },
      async (c) => {
        const { limit, cursor } = c.req.valid("query")
        const at = pageAt({ cursor, limit })
        const { companyId } = c.get("principal")
        const tx = c.get("tx")
        const page = await listLists(tx, c.get("principal"), at)
        const holidays = await holidaysOf(tx, companyId, page.items.map((row) => row.id))
        const projects = await projectCountsOf(tx, companyId, page.items.map((row) => row.name))
        return c.json({ ...page, items: page.items.map((row) => listOf(row, holidays.get(row.id) ?? [], projects.get(row.name) ?? 0)) })
      },
    )
    .post(
      "/holiday-lists",
      {
        operationId: "createHolidayList",
        summary: "Add a holiday list",
        description:
          "Adds a list to the company's own: `country` is ISO 3166-1 alpha-2 and `name` what a person reads and a project names, each once inside the company; `holidays` the days it starts with, each named once, none when absent. The server mints the id. A project rests on it once its `holidayList` names it.",
        module: MODULE,
        action: "create",
        body: HolidayListCreate,
        invalid: ["the body is missing a field, holds a value of the wrong shape, names a member the server owns, names the same day twice, or carries more than 400 days"],
        responses: {
          201: describeCreated("The holiday list as it was written.", HolidayList),
          409: describeProblem("The company already has a holiday list for that country, or one with that name."),
        },
      },
      async (c) => {
        const { holidays, ...values } = c.req.valid("json")
        const { companyId } = c.get("principal")
        const tx = c.get("tx")
        const [row] = await refuseDuplicate({ [COUNTRY_TAKEN]: countryTaken(values.country), [NAME_TAKEN]: nameTaken(values.name) }, () =>
          tx
            .insert(holidayList)
            .values({ ...values, id: newId(), companyId })
            .returning(columns),
        )
        await writeHolidays(tx, companyId, row.id, holidays)
        return created(c, "/holiday-lists", listOf(row, byDay(holidays), 0))
      },
    )
    .get(
      "/holiday-lists/:id",
      {
        operationId: "getHolidayList",
        summary: "One holiday list",
        description: "One list of the caller's company, with its days by day. Another company's list is a list that does not exist here.",
        module: MODULE,
        action: "view",
        params: IdParam,
        responses: {
          200: describeJson("The holiday list.", HolidayList),
          404: describeProblem("No holiday list with that id in this company."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const { companyId } = c.get("principal")
        const row = await getList(tx, c.get("principal"), id)
        return c.json(await readList(tx, companyId, row))
      },
    )
    .patch(
      "/holiday-lists/:id",
      {
        operationId: "patchHolidayList",
        summary: "Rename a holiday list, or move it to another country",
        description:
          "Changes the country or the name. A new name follows to every project resting on the list in the same statement (the projects' `holidayList` is a key into it), so no project leaves the list by a rename. The days are a set and are replaced through `PUT /holiday-lists/:id/holidays`.",
        module: MODULE,
        action: "edit",
        params: IdParam,
        body: HolidayListPatch,
        invalid: ["the patch is empty, names a field the caller does not own, or holds a value of the wrong shape"],
        responses: {
          200: describeJson("The holiday list as it now stands.", HolidayList),
          404: describeProblem("No holiday list with that id in this company."),
          409: describeProblem("The company already has another holiday list for that country, or with that name."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const { companyId } = c.get("principal")
        const tx = c.get("tx")
        await lockRow(tx, holidayList, { companyId, id }, strengthFor(holidayList, patch))
        const sentences: Record<string, string> = {
          ...(patch.country === undefined ? {} : { [COUNTRY_TAKEN]: countryTaken(patch.country) }),
          ...(patch.name === undefined ? {} : { [NAME_TAKEN]: nameTaken(patch.name) }),
        }
        const [row] = await refuseDuplicate(sentences, () =>
          tx
            .update(holidayList)
            .set(patch)
            .where(and(eq(holidayList.companyId, companyId), eq(holidayList.id, id)))
            .returning(columns),
        )
        if (row === undefined) throw noSuchList(id)
        return c.json(await readList(tx, companyId, row))
      },
    )
    .delete(
      "/holiday-lists/:id",
      {
        operationId: "deleteHolidayList",
        summary: "Remove a holiday list",
        description: "Removes a list no project rests on, with its days. A list a project still names is refused: move the project off it, or onto another list, first.",
        module: MODULE,
        action: "delete",
        params: IdParam,
        responses: {
          204: { description: "The list and its days are gone." },
          404: describeProblem("No holiday list with that id in this company."),
          409: describeProblem("A project of the company rests on the list."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const { companyId } = c.get("principal")
        const tx = c.get("tx")
        // The list's row lock as a key share's opposite: a project naming it waits for this, or this for it.
        await lockRow(tx, holidayList, { companyId, id }, "update")
        const row = await getList(tx, c.get("principal"), id)
        const projects = await projectsOn(tx, companyId, row.name)
        if (projects.length > 0) {
          throw problem(409, { detail: `${projects.length === 1 ? "A project rests" : `${projects.length} projects rest`} on this holiday list: move ${projects.length === 1 ? "it" : "them"} off it first` })
        }
        await tx.delete(holidayListHoliday).where(and(eq(holidayListHoliday.companyId, companyId), eq(holidayListHoliday.holidayListId, id)))
        await tx.delete(holidayList).where(and(eq(holidayList.companyId, companyId), eq(holidayList.id, id)))
        return c.body(null, 204)
      },
    )
    .put(
      "/holiday-lists/:id/holidays",
      {
        operationId: "putHolidayListHolidays",
        summary: "Replace a holiday list's days",
        description:
          "Replaces the whole set with the one in the body: a day the body leaves out is not a holiday afterwards, and an empty set is a list without holidays. Each entry is a day and a name or null, each day named once (400 on `holidays`). The list's `updatedAt` moves, since the days are part of the list on the wire. The change releases in the same transaction, in every project resting on the list, the hold on each route the office moved by hand (`heldAt`) that it re-decides under its scheme's holiday policy — one standing where the scheme put the collection, when a holiday added or taken away moves or skips it, and one the office moved to a day that becomes a holiday the scheme moves collections off — so the next generation run plans them with their neighbours (#226).",
        module: MODULE,
        action: "edit",
        params: IdParam,
        body: HolidayListHolidaysSet,
        invalid: ["the body is missing `holidays`, names a member it does not own, names the same day twice, or carries more than 400 days"],
        responses: {
          200: describeJson("The holiday list with the days it now has.", HolidayList),
          404: describeProblem("No holiday list with that id in this company."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const { holidays } = c.req.valid("json")
        const { companyId } = c.get("principal")
        const tx = c.get("tx")
        // The list's own row is stamped first: the set is part of the list on
        // the wire, the update says so, takes the row lock, and answers "no
        // such list here".
        const [row] = await tx
          .update(holidayList)
          .set(stamp())
          .where(and(eq(holidayList.companyId, companyId), eq(holidayList.id, id)))
          .returning(columns)
        if (row === undefined) throw noSuchList(id)
        const projects = await projectsOn(tx, companyId, row.name)
        // The held routes the new set re-decides go back to their schemes, project by project (#226).
        await changeProjectCalendars(tx, projects.map((projectId) => ({ companyId, projectId })), async () => {
          await tx.delete(holidayListHoliday).where(and(eq(holidayListHoliday.companyId, companyId), eq(holidayListHoliday.holidayListId, id)))
          await writeHolidays(tx, companyId, id, holidays)
        })
        return c.json(listOf(row, byDay(holidays), projects.length))
      },
    )
}
