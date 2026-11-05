// The Holiday Lists' first rows (Settings › Operations › Holiday lists,
// 2026-11-05): a holiday list was a name on the Project and its dates were the
// project's Collection Calendar holidays; from this migration it is a row of
// the company's own, for one country, and the Project's name is a key into
// it. The migration runs these after the two tables and before the Project's
// key, as the owner:
//
// 1. every company is given one list per country its projects' list names
//    are of — a name this system knows is of its country (`Danish public
//    holidays` → DK), any other of the company's own — under the first name
//    in name order of those of that country;
// 2. a project whose list name lost that race names the list of its country;
// 3. each list is given the days its projects' calendars held, once a day,
//    under the name one of them gave it (the greatest, where two disagree).
//
// The calendars' holidays are left where they were, read by nothing from
// here on. holiday-lists-rendering.test.ts pins the three in the file.
import { KNOWN_HOLIDAY_LIST_NAMES, knownHolidayListCountry } from "@waste/domain/route-schemes/holiday-names"

import { literal } from "../schema/checks"

/** `CASE p."holiday_list" WHEN 'Danish public holidays' THEN 'DK' … ELSE c."country" END`: the country a project's list name is of. */
function countryOfListName(): string {
  const known = KNOWN_HOLIDAY_LIST_NAMES.map((name) => `WHEN ${literal(name)} THEN ${literal(knownHolidayListCountry(name) ?? "")}`).join(" ")
  return `CASE p."holiday_list" ${known} ELSE c."country" END`
}

/** The projects that name a list, with the country that list is of. */
function projectsWithCountry(): string {
  return `SELECT p."company_id", p."id", p."holiday_list", ${countryOfListName()} AS "country" FROM "wms"."project" AS p JOIN "wms"."company" AS c ON c."id" = p."company_id" WHERE p."holiday_list" IS NOT NULL`
}

/** Step 1: one list per company and country, under the first name of that country's. */
export function holidayListsFromProjects(): string {
  return (
    `INSERT INTO "wms"."holiday_list" ("company_id", "country", "name") ` +
    `SELECT DISTINCT ON (named."company_id", named."country") named."company_id", named."country", named."holiday_list" FROM (${projectsWithCountry()}) AS named ` +
    `ORDER BY named."company_id", named."country", named."holiday_list";`
  )
}

/** Step 2: a project names the list of its country, where the list took another name of that country. */
export function projectsOntoTheirList(): string {
  return (
    `UPDATE "wms"."project" AS target SET "holiday_list" = l."name" FROM (${projectsWithCountry()}) AS named ` +
    `JOIN "wms"."holiday_list" AS l ON l."company_id" = named."company_id" AND l."country" = named."country" ` +
    `WHERE target."company_id" = named."company_id" AND target."id" = named."id" AND target."holiday_list" IS DISTINCT FROM l."name";`
  )
}

/** Step 3: each list's days, from the calendars of the projects on it, once a day. */
export function holidaysFromCalendars(): string {
  return (
    `INSERT INTO "wms"."holiday_list_holiday" ("company_id", "holiday_list_id", "day", "name") ` +
    `SELECT h."company_id", l."id", h."day", max(h."name") FROM "wms"."collection_calendar_holiday" AS h ` +
    `JOIN "wms"."project" AS p ON p."company_id" = h."company_id" AND p."id" = h."project_id" ` +
    `JOIN "wms"."holiday_list" AS l ON l."company_id" = p."company_id" AND l."name" = p."holiday_list" ` +
    `GROUP BY h."company_id", l."id", h."day";`
  )
}

/** The three, in the order the migration runs them. */
export const holidayListsBackfill = (): string[] => [holidayListsFromProjects(), projectsOntoTheirList(), holidaysFromCalendars()]
