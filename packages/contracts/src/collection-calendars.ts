// When work may not happen, on the wire (Issue #97): the Collection
// Calendar. A calendar is effective-dated (ADR-0005) and a project has one in
// force at a time — the per-year records tile the project's timeline, which
// the database holds — so a Route Scheme reads its project's calendars and
// never picks one, and `CollectionCalendarListQuery.validOn` is how a caller
// asks which one a day falls in.
//
// A calendar carries no holidays (2026-11-05): a project's holidays are the
// days of the company's Holiday List it names (`Project.holidayList`,
// holiday-lists.ts), so a body naming `holidays` is refused by name.
//
// The prototype's `weekStart` and `timezone` are not here: the working week is
// the Project's (`weekend`) and so is the timezone.
import * as z from "zod"

import { IsoDate } from "./dates"
import { Id } from "./ids"
import { ProjectScopedListQuery } from "./queries"
import { stamped } from "./resource"
import { Label } from "./text"
import { effectiveDated, effectiveDatedBodies } from "./validity"

export const CollectionCalendar = effectiveDated(
  z.object({
    ...stamped,
    projectId: Id,
    /** What a person reads: `Copenhagen Central 2027`. Unique per project. */
    name: Label,
  }),
)
export type CollectionCalendar = z.infer<typeof CollectionCalendar>

/** A patch changes the name and the period; a null end reopens it. */
const collectionCalendarBodies = effectiveDatedBodies({ projectId: Id, name: Label }, { keys: ["projectId"] })

export const CollectionCalendarCreate = collectionCalendarBodies.create
export type CollectionCalendarCreate = z.infer<typeof CollectionCalendarCreate>

export const CollectionCalendarPatch = collectionCalendarBodies.patch
export type CollectionCalendarPatch = z.infer<typeof CollectionCalendarPatch>

/** A page of calendars, from one project, in force on a day. */
export const CollectionCalendarListQuery = ProjectScopedListQuery.extend({
  /** The day the period is read against; absent asks for every calendar, whenever it ran. */
  validOn: IsoDate.optional(),
})
export type CollectionCalendarListQuery = z.infer<typeof CollectionCalendarListQuery>
