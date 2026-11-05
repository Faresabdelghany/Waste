// Tables a later migration dropped, as they stood when it dropped them. Not
// exported from index.ts, so drizzle-kit, the schema's gates and every
// query never see them: they are here only so the frozen lists of the files
// that wrote their statements — `AUDITED_AT_0019` (sql/audit-trail.ts),
// `COLLECTION_DAYS_DOOR_AT_0021` (sql/public-door.ts) — and those files'
// rendering tests can still spell what an applied file says, since an
// applied file is never edited. Nothing may read or write one.
import { date, text, uuid } from "drizzle-orm/pg-core"

import { collectionCalendar } from "./collection-calendars"
import { id, projectScoped, timestamps } from "./columns"
import { company, project } from "./organisation"
import { companyReference, projectReference, tenantIndex, tenantReference, tenantUnique } from "./references"
import { wms } from "./wms"

/**
 * One holiday of one Collection Calendar (0006), dropped once a project's
 * holidays were the days of the company's Holiday List it names (0099, then
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

/** Every table here: what the frozen lists are filtered by where today's schema is read. */
export const DROPPED_TABLES = [collectionCalendarHoliday] as const
