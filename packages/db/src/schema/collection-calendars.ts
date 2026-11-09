// When work may not happen (Issue #97): the Collection Calendar. A project
// has one calendar in force at a time — the per-year records tile the
// project's timeline, which the exclusion constraint over `project_id` alone
// holds — so a Route Scheme reads its project's calendars and never picks one.
//
// `collection_calendar` is effective-dated (ADR-0005) with a name a person
// reads (`Copenhagen Central 2027`), unique per project. The prototype's
// `weekStart` and `timezone` are not columns: the working week is the
// Project's (`project.weekend`) and so is the timezone.
//
// A calendar carries no holidays (2026-11-05): a project's holidays are the
// days of the company's Holiday List it names (`project.holiday_list`,
// organisation.ts), and the calendar's own `collection_calendar_holiday`,
// read by nothing once the lists came (0100), was dropped behind a guard that
// proved its days were on the lists (0101_calendar_holidays_dropped.sql).
import { text } from "drizzle-orm/pg-core"

import { id, projectScoped, timestamps, validity, validPeriod } from "./columns"
import { company, project } from "./organisation"
import { policies } from "./policies"
import { companyReference, projectKey, tenantReference, tenantUnique } from "./references"
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

export const collectionCalendarPolicies = policies(collectionCalendar, { audited: {} })
