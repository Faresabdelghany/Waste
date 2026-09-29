// What the API says when it refuses, as the web reads it (Issue #81). Every
// non-2xx body of `apps/api` is an RFC 9457 problem (`@waste/contracts/problem`):
// a status, a title, one sentence of `detail`, and on a 400 the `errors` the
// validator refused, each a `path` into the request and the validator's own
// `message` — which, for an unknown body member, names the members the body
// accepts (Issue #74). The shape is read structurally and not through the
// contracts' zod schema: the store that reads it sits in the root layout, so
// a runtime zod import would land in every route's client bundle, and the web
// meets zod only through the contracts in its tests (CLAUDE.md, contracts).
// The type is the contracts' own, imported as a type, so the two cannot drift
// in shape without the type check saying so.
import type { Problem, ProblemFieldError } from "@waste/contracts/problem"

export type { Problem, ProblemFieldError }

/** The media type every error body carries; spelled once here as in the contracts. */
export const PROBLEM_MEDIA_TYPE = "application/problem+json"

/**
 * The `type` of the one refusal that ends a session (Issue #150): the token
 * is sound but the account behind it is refused, not the request. The
 * contracts' `NO_ACTIVE_ACCOUNT.type`, re-spelled like the media type above
 * so no zod reaches the bundle, and held equal to it by a test.
 */
export const NO_ACTIVE_ACCOUNT_PROBLEM_TYPE = "urn:waste:problem:no-active-account"

/** Whether a problem refuses the account itself: the one kind that ends the session, where a permission 403 (`about:blank`) never does. */
export function isAccountRefusal(problem: Problem): boolean {
  return problem.type === NO_ACTIVE_ACCOUNT_PROBLEM_TYPE
}

/** The reason phrases the web falls back on when a body carries no title of its own. */
const REASON_PHRASES: Readonly<Record<number, string>> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
}

function isFieldError(value: unknown): value is ProblemFieldError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ProblemFieldError).path === "string" &&
    typeof (value as ProblemFieldError).message === "string"
  )
}

/**
 * A problem read off a parsed body, or null when the body is not one. The
 * status in the body is trusted over the response's only when it is a
 * 4xx/5xx number, since the body is what the API wrote for this refusal.
 */
export function problemOf(body: unknown): Problem | null {
  if (typeof body !== "object" || body === null) return null
  const candidate = body as Record<string, unknown>
  if (typeof candidate.type !== "string" || typeof candidate.title !== "string") return null
  if (typeof candidate.status !== "number" || candidate.status < 400 || candidate.status > 599) return null
  const errors = Array.isArray(candidate.errors) ? candidate.errors.filter(isFieldError) : undefined
  return {
    type: candidate.type,
    title: candidate.title,
    status: candidate.status,
    ...(typeof candidate.detail === "string" ? { detail: candidate.detail } : {}),
    ...(errors === undefined ? {} : { errors }),
  }
}

/** The problem a response that carried no readable problem body stands for: its status and nothing more. */
export function genericProblem(status: number, detail?: string): Problem {
  return {
    type: "about:blank",
    title: REASON_PHRASES[status] ?? `HTTP ${status}`,
    status,
    ...(detail === undefined ? {} : { detail }),
  }
}

/**
 * A refused request, thrown by the client with the problem the API answered.
 * `status` repeats the problem's so a caller can branch without reading the
 * body, and `fields` is `errors` keyed by path for a form that wants to put
 * a message beside the field it refused.
 */
export class ApiProblem extends Error {
  readonly status: number
  readonly problem: Problem

  constructor(problem: Problem) {
    super(problemSentence(problem))
    this.name = "ApiProblem"
    this.status = problem.status
    this.problem = problem
  }

  get fields(): Readonly<Record<string, string>> {
    return Object.fromEntries((this.problem.errors ?? []).map((error) => [error.path, error.message]))
  }
}

/** True for what the client throws; a type guard a catch block can lean on. */
export function isApiProblem(error: unknown): error is ApiProblem {
  return error instanceof ApiProblem
}

/**
 * One sentence for a person: the detail when there is one, else the title,
 * with the refused fields appended as `path: message`, the request as a
 * whole (`path` "") spelled as "body". This is the text the store's toast
 * shows and the message of the thrown error.
 */
export function problemSentence(problem: Problem): string {
  const lead = problem.detail ?? problem.title
  const errors = (problem.errors ?? []).map((error) => `${error.path === "" ? "body" : error.path}: ${error.message}`)
  return errors.length === 0 ? lead : `${lead} — ${errors.join("; ")}`
}
