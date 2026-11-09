// What an error looks like on the wire: RFC 9457 Problem Details, the one
// shape every non-2xx body of the API takes (Issue #70; the #45 and #64
// scaffolds deferred it to "the first real endpoint"). A client reads `status`
// off the body as off the response, `title` names the kind of problem,
// `detail` says what went wrong with this request in one sentence, and a 400
// from the request validator lists `errors`, one per field: `path` is the
// dotted path into the request (`projectIds.1`, an empty string for the root),
// `message` the validator's own words. The media type is
// `application/problem+json`.
//
// `type` is a URI reference that identifies the kind of problem. Every problem
// is the generic one for its status, `about:blank` with the reason phrase as
// its title, but two: `NO_ACTIVE_ACCOUNT` (Issue #150), the refusal a client
// must tell apart from every other 403, because it is the account that is
// refused and not the request, and `NO_PROOF_STORAGE` (O1 of #290), a
// deployment with no Storage key. A further type is a new URI and a paragraph in
// the document when a client needs one, never a change to this shape.
import { PROBLEM_STATUS } from "@waste/domain/requests"
import * as z from "zod"

/** A kind of problem beyond its status: the URI that names it and its title, which RFC 9457 keeps the same on every occurrence (`NO_ACTIVE_ACCOUNT`, @waste/domain/access/accounts; `NO_PROOF_STORAGE`, @waste/domain/storage-objects). */
export type ProblemKind = { readonly type: string; readonly title: string }

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
  /** The status's reason phrase when `type` is `about:blank`, the kind's own title otherwise. */
  title: z.string().min(1),
  /** The response's own status, repeated so the body stands on its own. */
  status: z.int().min(PROBLEM_STATUS.min).max(PROBLEM_STATUS.max),
  /** What went wrong with this request, in one sentence; absent on a 500, which says nothing about itself. */
  detail: z.string().optional(),
  /** The fields a 400 refused. */
  errors: z.array(ProblemFieldError).optional(),
})
export type Problem = z.infer<typeof Problem>
