// What an error looks like on the wire: RFC 9457 Problem Details, the one
// shape every non-2xx body of the API takes (Issue #70; the #45 and #64
// scaffolds deferred it to "the first real endpoint"). A client reads `status`
// off the body as off the response, `title` is the status's reason phrase,
// `detail` says what went wrong with this request in one sentence, and a 400
// from the request validator lists `errors`, one per field: `path` is the
// dotted path into the request (`projectIds.1`, an empty string for the root),
// `message` the validator's own words. The media type is
// `application/problem+json`.
//
// `type` is a URI reference that identifies the kind of problem. Every problem
// today is the generic one for its status, `about:blank`, because no client
// yet distinguishes one 409 from another; a specific type is a new URI and a
// paragraph in the document when that day comes, never a change to this shape.
import * as z from "zod"

/** The media type of every error body. */
export const PROBLEM_MEDIA_TYPE = "application/problem+json"

/** The `type` of a problem that is nothing more specific than its status. */
export const BLANK_PROBLEM_TYPE = "about:blank"

/** One field the request validator refused: where in the request, and why. */
export const ProblemFieldError = z.object({
  /** Dotted path into the request target (`name`, `projectIds.1`); empty for the target as a whole. */
  path: z.string(),
  message: z.string().min(1),
})
export type ProblemFieldError = z.infer<typeof ProblemFieldError>

export const Problem = z.object({
  /** A URI reference naming the kind of problem; `about:blank` when the status says it all. */
  type: z.string().min(1),
  /** The status's reason phrase when `type` is `about:blank`. */
  title: z.string().min(1),
  /** The response's own status, repeated so the body stands on its own. */
  status: z.int().min(400).max(599),
  /** What went wrong with this request, in one sentence; absent on a 500, which says nothing about itself. */
  detail: z.string().optional(),
  /** The fields a 400 refused. */
  errors: z.array(ProblemFieldError).optional(),
})
export type Problem = z.infer<typeof Problem>
