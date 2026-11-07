// The list-query parameters more than one route reads (Issue #78). The page
// itself is `PageRequest`'s; what is added here is the filter every
// project-scoped list takes, so eight routes cannot spell `projectId` eight
// ways. A filter one resource alone has stays in that resource's module and
// extends this one.
//
// Every filter is optional, and absent means "do not filter": a caller who
// names no project asks for the resource across the projects it reaches,
// which is what the request's principal already decides.
import { DAY_WINDOW_ORDERED } from "@waste/domain/days"
import * as z from "zod"

import { Id } from "./ids"
import { PageRequest } from "./pagination"

/** A page of a project-scoped resource, from one project or from all of them. */
export const ProjectScopedListQuery = PageRequest.extend({
  projectId: Id.optional(),
})
export type ProjectScopedListQuery = z.infer<typeof ProjectScopedListQuery>

/**
 * A window of calendar days a list is asked over — `from` and `to`, both
 * `YYYY-MM-DD`, both inclusive — as Execution's route and pickup lists take
 * it over the operating date (Issue #104), refused at `to`, the bound a
 * caller can move, when it runs backward (@waste/domain/days).
 */
export const dayWindowIsOrdered = { message: DAY_WINDOW_ORDERED, path: ["to"] }
