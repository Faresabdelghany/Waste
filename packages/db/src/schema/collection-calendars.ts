// When work may not happen (Issue #97): the Collection Calendar and its
// holidays. A project has one calendar in force at a time — the per-year
// records tile the project's timeline, which the exclusion constraint over
// `project_id` alone holds — so a Route Scheme reads its project's calendars
// and never picks one, and a scheme's holiday policy is applied against
// whatever calendar is in force on the day.
//
// `collection_calendar` is effective-dated (ADR-0005) with a name a person
// reads (`Copenhagen Central 2027`), unique per project. The prototype's
// `weekStart` and `timezone` are not columns: the working week is the
// Project's (`project.weekend`) and so is the timezone.
//
// `collection_calendar_holiday` is one day of one calendar, with the name the
// prototype kept as a JSON of date to name (#36). The set is replaced whole
// with `PUT …/holidays`; a day outside the calendar's period is the API's
// 400, and a calendar shortened under its holidays its 409 — Postgres cannot
// hold a child's day inside its parent's period without a trigger. Nothing
// references a holiday, so it carries no `projectKey` and its reference to the
// Project takes a `tenantIndex`.
//
// Whether the holidays are read at all is the Project's `holiday_list`: a
// project with none rests on its weekend only, whatever calendars it has.
import { date, text, uuid } from "drizzle-orm/pg-core"

import { id, projectScoped, timestamps, validity, validPeriod } from "./columns"
import { company, project } from "./organisation"
import { companyReference, projectKey, projectReference, tenantIndex, tenantReference, tenantUnique } from "./references"
import { wms } from "./wms"

export const collectionCalendar = wms.table(
  "collection_calendar",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    ...validity,
    /** What a person reads: `Copenhagen Central 2027`. Unique per project. */
    name: text().notNull(),
  },
  (t) => [companyReference(t, company), tenantReference(t, [t.projectId], project), tenantUnique(t, t.projectId, t.name), projectKey(t), validPeriod(t)],
)

export const collectionCalendarHoliday = wms.table(
  "collection_calendar_holiday",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    collectionCalendarId: uuid().notNull(),
    /** The holiday, a calendar day inside the calendar's period (the API holds that). */
    day: date().notNull(),
    /** What the day is called (`Grundlovsdag`); null where nobody named it. */
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
