// The list-query parameters more than one route reads (Issue #78). The page
// itself is `PageRequest`'s; what is added here is the filter every
// project-scoped list takes, so eight routes cannot spell `projectId` eight
// ways, and the window of days or instants a list or a report is asked over.
// A filter one resource alone has stays in that resource's module and
// extends this one.
//
// Every filter is optional, and absent means "do not filter": a caller who
// names no project asks for the resource across the projects it reaches,
// which is what the request's principal already decides.
import { instantWindowOrdered, OCCURRED_WINDOW_ORDERED } from "@waste/domain/clock"
import { DAY_WINDOW_ORDERED, dayWindowFits, dayWindowOrdered } from "@waste/domain/days"
import * as z from "zod"

import { IsoDate, IsoDateTime } from "./dates"
import { Id } from "./ids"
import { PageRequest } from "./pagination"
import { holding } from "./resource"

/** A page of a project-scoped resource, from one project or from all of them. */
export const ProjectScopedListQuery = PageRequest.extend({
  projectId: Id.optional(),
})
export type ProjectScopedListQuery = z.infer<typeof ProjectScopedListQuery>

type Window = { from?: string; to?: string }

/** A rule over a window's two days and the sentence it refuses with, at `to`: the bound a caller can move. */
type WindowRule = readonly [holds: (window: Window) => boolean, message: string]

/** The base with the window's two days after its own fields, and each rule after the base's own, which `safeExtend` keeps. */
function windowed<Shape extends z.core.$ZodShape, Config extends z.core.$ZodObjectConfig, Days extends { from: z.core.SomeType; to: z.core.SomeType }>(
  base: z.ZodObject<Shape, Config>,
  days: Days,
  rules: readonly WindowRule[],
): z.ZodObject<z.core.util.Extend<Shape, Days>, Config> {
  const extended = (base as unknown as z.ZodObject).safeExtend(days) as unknown as z.ZodObject<z.core.util.Extend<Shape, Days>, Config>
  return rules.reduce((schema, [holds, message]) => holding(schema, holds, { message, path: ["to"] }), extended)
}

/**
 * A query asked over a window of calendar days, `from` to `to`, both
 * inclusive — as Execution's route and pickup lists take it over the
 * operating date (Issue #104): the base's fields, then the two days, each
 * optional, an absent one no bound on its side, and the window held to run
 * forward (@waste/domain/days). The rule comes with the fields, so a query
 * cannot take the days and leave the rule behind.
 */
export function dayWindow<Shape extends z.core.$ZodShape, Config extends z.core.$ZodObjectConfig>(base: z.ZodObject<Shape, Config>) {
  return windowed(base, { from: IsoDate.optional(), to: IsoDate.optional() }, [[dayWindowOrdered, DAY_WINDOW_ORDERED]])
}

/**
 * A window a read must be asked over: both days required and held to run
 * forward as `dayWindow`'s are, and, with `maxDays`, to at most that many
 * days, both ends in, refused with the context's sentence. `day` is what each
 * end takes where a context bounds it further: a report's days, from its
 * first day on.
 */
export function requiredDayWindow<Shape extends z.core.$ZodShape, Config extends z.core.$ZodObjectConfig>(
  base: z.ZodObject<Shape, Config>,
  options: { maxDays?: { days: number; tooLong: string }; day?: typeof IsoDate } = {},
) {
  const { maxDays, day = IsoDate } = options
  const fits: WindowRule[] = maxDays === undefined ? [] : [[(window) => dayWindowFits(window as Required<Window>, maxDays.days), maxDays.tooLong]]
  return windowed(base, { from: day, to: day }, [[dayWindowOrdered, DAY_WINDOW_ORDERED], ...fits])
}

/** A query asked over a window of instants, both inclusive, as `dayWindow` is over days: each end optional, the window held to run forward (@waste/domain/clock). */
export function instantWindow<Shape extends z.core.$ZodShape, Config extends z.core.$ZodObjectConfig>(base: z.ZodObject<Shape, Config>) {
  return windowed(base, { from: IsoDateTime.optional(), to: IsoDateTime.optional() }, [[instantWindowOrdered, OCCURRED_WINDOW_ORDERED]])
}
