// The Drop-off Points on the wire (Issue #293, M3): the places residents
// bring waste to themselves, a project's recycling centres and bring banks.
// Every rule of resource.ts holds: a resource spreads `stamped`, a write body
// is strict, a patch is every field optional and at least one given, and a
// point never moves between projects; its `code` is set once.
//
// A point travels with its three sets — the fractions it takes, its weekly
// hours, its dated exceptions — each replaced whole through its own `PUT`,
// and a create may carry the sets it starts with. The sets are judged by the
// domain's own rules (`hoursIssues`, `exceptionIssues`), the ones the public
// map reads the days by, so a form and the API refuse in the same words.
// Times are `HH:MM` on the project's clock. A point open always keeps any
// weekly hours it had, which are not read while it is.
import { exceptionIssues, hoursIssues } from "@waste/domain/resources/drop-off-points"
import * as z from "zod"

import { IsoDate, IsoTime } from "./dates"
import { FlatPoint } from "./geojson"
import { Id } from "./ids"
import { ServiceDay } from "./planning"
import { ProjectScopedListQuery } from "./queries"
import { changesSomething, eachOnce, eachOnceSentence, somethingToChange, stamped } from "./resource"
import { DropOffPointKind, DropOffPointStatus } from "./resources"
import { Label, Paragraph } from "./text"

/** The most fractions or windows a set may name: a form's list, not an import. */
const SET_MAX = 200
/** The most exceptions a set may name: a year of them, one a day. */
const EXCEPTIONS_MAX = 366

/** A weekday's window on the project's clock. */
export const WeeklyWindow = z.strictObject({ weekday: ServiceDay, opensAt: IsoTime, closesAt: IsoTime })
export type WeeklyWindow = z.infer<typeof WeeklyWindow>

/** A dated exception: its window, or both times null for closed all day, and why. */
export const OpeningException = z.strictObject({ date: IsoDate, opensAt: IsoTime.nullable(), closesAt: IsoTime.nullable(), note: Label.nullable() })
export type OpeningException = z.infer<typeof OpeningException>

export const EACH_FRACTION_ONCE = eachOnceSentence("waste fraction")

const WasteFractionIds = z.array(Id).max(SET_MAX).refine((ids) => eachOnce(ids), { message: EACH_FRACTION_ONCE })
/** Whether every time of a set is `HH:MM`: its windows are judged together only once each is, so a time is refused once, at itself. */
const clocked = (times: readonly (string | null)[]) => times.every((time) => time === null || IsoTime.safeParse(time).success)

/** Each issue the domain finds, as a 400 at the set. */
const Hours = z
  .array(WeeklyWindow)
  .max(SET_MAX)
  .superRefine((hours, context) => {
    if (!clocked(hours.flatMap((window) => [window.opensAt, window.closesAt]))) return
    for (const issue of hoursIssues(hours)) context.addIssue({ code: "custom", message: issue })
  })
const Exceptions = z
  .array(OpeningException)
  .max(EXCEPTIONS_MAX)
  .superRefine((exceptions, context) => {
    if (!clocked(exceptions.flatMap((exception) => [exception.opensAt, exception.closesAt]))) return
    for (const issue of exceptionIssues(exceptions)) context.addIssue({ code: "custom", message: issue })
  })

export const DropOffPoint = z.object({
  ...stamped,
  projectId: Id,
  /** The stable reference a person quotes: `GS-AMAGER`. Unique per project; set once. */
  code: Label,
  /** Unique per project. */
  name: Label,
  kind: DropOffPointKind,
  address: Paragraph,
  /** The public map draws it, so a point is always located. */
  location: FlatPoint,
  /** Open at all hours: a bring bank on a street. Its weekly hours are not read while it is. */
  openAlways: z.boolean(),
  /** Closed on the project's holidays unless an exception says otherwise. */
  closedOnHolidays: z.boolean(),
  /** What a resident is told beside the hours. */
  publicNote: Paragraph.nullable(),
  status: DropOffPointStatus,
  /** The office's own notes, never on the public map. */
  notes: Paragraph.nullable(),
  /** The fractions it takes, by id; replaced whole through its own route. */
  wasteFractionIds: z.array(Id),
  /** Its weekly windows, by weekday and then opening. */
  hours: z.array(WeeklyWindow),
  /** Its exceptions, by date. */
  exceptions: z.array(OpeningException),
})
export type DropOffPoint = z.infer<typeof DropOffPoint>

export const DropOffPointCreate = z.strictObject({
  projectId: Id,
  code: Label,
  name: Label,
  kind: DropOffPointKind,
  address: Paragraph,
  location: FlatPoint,
  openAlways: z.boolean().default(false).describe("Defaults to false when absent: a recycling centre keeps hours."),
  closedOnHolidays: z.boolean().default(false).describe("Defaults to false when absent."),
  publicNote: Paragraph.nullable().optional(),
  status: DropOffPointStatus.default("draft").describe("Defaults to draft when absent: a point reaches the public map when the office makes it active."),
  notes: Paragraph.nullable().optional(),
  wasteFractionIds: WasteFractionIds.default([]).describe("The fractions it starts out taking; none when absent."),
  hours: Hours.default([]).describe("Its weekly windows; none when absent."),
  exceptions: Exceptions.default([]).describe("Its dated exceptions; none when absent."),
})
export type DropOffPointCreate = z.infer<typeof DropOffPointCreate>

/** Everything but the project, the code, the sets and the stamps. */
export const DropOffPointPatch = z
  .strictObject({
    name: Label.optional(),
    kind: DropOffPointKind.optional(),
    address: Paragraph.optional(),
    location: FlatPoint.optional(),
    openAlways: z.boolean().optional(),
    closedOnHolidays: z.boolean().optional(),
    publicNote: Paragraph.nullable().optional(),
    status: DropOffPointStatus.optional(),
    notes: Paragraph.nullable().optional(),
  })
  .refine(changesSomething, somethingToChange)
export type DropOffPointPatch = z.infer<typeof DropOffPointPatch>

/** The whole set of fractions the point takes, replacing what it had. */
export const DropOffPointFractionsSet = z.strictObject({ wasteFractionIds: WasteFractionIds })
export type DropOffPointFractionsSet = z.infer<typeof DropOffPointFractionsSet>

/** The whole week of windows, replacing what it had. */
export const DropOffPointHoursSet = z.strictObject({ hours: Hours })
export type DropOffPointHoursSet = z.infer<typeof DropOffPointHoursSet>

/** The whole set of exceptions, replacing what it had. */
export const DropOffPointExceptionsSet = z.strictObject({ exceptions: Exceptions })
export type DropOffPointExceptionsSet = z.infer<typeof DropOffPointExceptionsSet>

/** A page of drop-off points, from one project, of one status and one kind. */
export const DropOffPointListQuery = ProjectScopedListQuery.extend({
  status: DropOffPointStatus.optional(),
  kind: DropOffPointKind.optional(),
})
export type DropOffPointListQuery = z.infer<typeof DropOffPointListQuery>
