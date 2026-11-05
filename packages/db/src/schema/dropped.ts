// Tables a later migration dropped, as they stood when it dropped them. Not
// exported from index.ts, so drizzle-kit, the schema's gates and every
// query never see them: they are here only so the frozen lists of the files
// that wrote their statements — `AUDITED_AT_0019` (sql/audit-trail.ts),
// `SORTING_GUIDE_DOOR_AT_0017` and `COLLECTION_DAYS_DOOR_AT_0021`
// (sql/public-door.ts) — and those files' rendering tests can still spell
// what an applied file says, since an applied file is never edited. Nothing
// may read or write one.
import { sql } from "drizzle-orm"
import { date, text, uuid } from "drizzle-orm/pg-core"

import { wasteFraction } from "./catalogue"
import { oneOf } from "./checks"
import { collectionCalendar } from "./collection-calendars"
import { id, projectScoped, timestamps } from "./columns"
import { company, project } from "./organisation"
import { companyReference, projectKey, projectReference, tenantIndex, tenantReference, tenantUnique } from "./references"
import { wms } from "./wms"

/**
 * One holiday of one Collection Calendar (0006), dropped once a project's
 * holidays were the days of the company's Holiday List it names (the Holiday Lists' migration, then
 * the calendar-holidays file that dropped it behind a guard proving its days
 * were on the lists).
 */
export const collectionCalendarHoliday = wms.table(
  "collection_calendar_holiday",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    collectionCalendarId: uuid().notNull(),
    day: date().notNull(),
    name: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.collectionCalendarId], collectionCalendar),
    tenantUnique(t, t.collectionCalendarId, t.day),
    tenantIndex(t, t.projectId),
  ],
)

/** An item's statuses as the Sorting Guide's own vocabulary spelled them; it went with the guide. */
export const SORTING_GUIDE_ITEM_STATUSES = ["draft", "published", "withdrawn"] as const

/**
 * One item of a project's Sorting Guide (0017, #293 M1): what a resident
 * looked up to learn where a thing goes, dropped with the guide (the Sorting
 * Guide's removal).
 */
export const sortingGuideItem = wms.table(
  "sorting_guide_item",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    name: text().notNull(),
    synonyms: text().array().notNull().default(sql`'{}'::text[]`),
    wasteFractionId: uuid(),
    instructions: text(),
    status: text().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    tenantReference(t, [t.wasteFractionId], wasteFraction),
    tenantUnique(t, t.projectId, t.name),
    projectKey(t),
    oneOf(t.status, SORTING_GUIDE_ITEM_STATUSES),
    tenantIndex(t, t.wasteFractionId),
  ],
)

/** Every table here: what the frozen lists are filtered by where today's schema is read. */
export const DROPPED_TABLES = [collectionCalendarHoliday, sortingGuideItem] as const
