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
import { changesSomething, somethingToChange, stamped } from "./resource"
import { Label } from "./text"
import { endsAfterItStarts, Validity, ValidityCreate, validityOrdered } from "./validity"

export const CollectionCalendar = z
  .object({
    ...stamped,
    projectId: Id,
    /** What a person reads: `Copenhagen Central 2027`. Unique per project. */
    name: Label,
    ...Validity.shape,
  })
  .refine(validityOrdered, endsAfterItStarts)
export type CollectionCalendar = z.infer<typeof CollectionCalendar>

export const CollectionCalendarCreate = z
  .strictObject({
    projectId: Id,
    name: Label,
    ...ValidityCreate,
  })
  .refine(validityOrdered, endsAfterItStarts)
export type CollectionCalendarCreate = z.infer<typeof CollectionCalendarCreate>

/** The name and the period. */
export const CollectionCalendarPatch = z
  .strictObject({
    name: Label.optional(),
    validFrom: IsoDate.optional(),
    /** Null reopens the period; a day ends it. */
    validTo: IsoDate.nullable().optional(),
  })
  .refine(changesSomething, somethingToChange)
  .refine(validityOrdered, endsAfterItStarts)
export type CollectionCalendarPatch = z.infer<typeof CollectionCalendarPatch>

/** A page of calendars, from one project, in force on a day. */
export const CollectionCalendarListQuery = ProjectScopedListQuery.extend({
  /** The day the period is read against; absent asks for every calendar, whenever it ran. */
  validOn: IsoDate.optional(),
})
export type CollectionCalendarListQuery = z.infer<typeof CollectionCalendarListQuery>
