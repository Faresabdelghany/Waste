// How the API says no: every error body is an RFC 9457 Problem Details
// document, `application/problem+json`, in the shape @waste/contracts/problem
// spells (Issue #70; the #45 and #64 scaffolds deferred the error shape to
// "the first real endpoint"). A handler raises one by throwing
// `problem(status, { detail })`; the error handler installed by app.ts turns
// that, and anything else that escapes a handler, into a response:
//
//   a ProblemError          → its own body and headers (a 401 carries WWW-Authenticate)
//   one of Hono's own       → a problem of its status, the message as detail
//   SQLSTATE 23505 or 23P01 → 409, since a key already taken and a period
//                             already covered are the database errors a client
//                             can do something about, and the constraint each
//                             hit when Postgres names it
//   anything else           → 500 with no detail, a projection of the error
//                             logged (`loggable`: never a statement or its
//                             bound parameters); what the error said stays on
//                             the server
//
// Throwing rather than returning is what lets the request's transaction roll
// back (auth/principal.ts reads the context's error after the handler), and
// what keeps the mapping in one place. `problemResponse` exists for the two
// places that answer instead of throwing: Hono's not-found hook, and a
// handler that has nothing to roll back and a status to explain.
//
// The request validator is wired here too: `validate(target, schema)` is
// hono-openapi's validator with the hook that turns zod's issues into a 400
// listing `errors: [{ path, message }]`, the path dotted into the target and
// empty for the target as a whole. A route validates through `validate`, never
// through the bare validator, so the 400 shape is in force wherever there is
// one. That 400 is `invalidRequest(target, errors)` and it is exported,
// because a schema is not the only thing that can refuse a field: a cursor
// this API did not write, a project the account does not work in, an id
// naming nobody's row. They are all the same answer, so they are all built
// here.
import { STATUS_CODES } from "node:http"

import { BLANK_PROBLEM_TYPE, PROBLEM_MEDIA_TYPE, Problem, type ProblemFieldError } from "@waste/contracts/problem"
import type { ErrorHandler, NotFoundHandler } from "hono"
import { HTTPException } from "hono/http-exception"
import type { ClientErrorStatusCode, ServerErrorStatusCode } from "hono/utils/http-status"
import { resolver, validator } from "hono-openapi"

/** A status a problem can carry: 4xx or 5xx. */
export type ProblemStatus = ClientErrorStatusCode | ServerErrorStatusCode

export type ProblemOptions = {
  /** One sentence on what went wrong with this request. Never on a 500. */
  detail?: string
  /** The fields a 400 refused. */
  errors?: ProblemFieldError[]
  /** Response headers the status needs, such as a 401's `WWW-Authenticate`. */
  headers?: Readonly<Record<string, string>>
}

const isProblemStatus = (status: number): status is ProblemStatus => status >= 400 && status <= 599

/** The body of a problem of this status: `about:blank`, the reason phrase as title, and what the caller added. */
export function problemBody(status: ProblemStatus, { detail, errors }: ProblemOptions = {}): Problem {
  return {
    type: BLANK_PROBLEM_TYPE,
    title: STATUS_CODES[status] ?? `${status}`,
    status,
    ...(detail === undefined ? {} : { detail }),
    ...(errors === undefined ? {} : { errors }),
  }
}

function toResponse(body: Problem, headers: Readonly<Record<string, string>> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: body.status,
    headers: { ...headers, "content-type": `${PROBLEM_MEDIA_TYPE}; charset=utf-8` },
  })
}

/** A problem as a Response, for a place that answers instead of throwing. */
export function problemResponse(status: ProblemStatus, options: ProblemOptions = {}): Response {
  return toResponse(problemBody(status, options), options.headers)
}

/**
 * A problem as a throwable. Hono's HTTPException underneath, so that even
 * Hono's default error handler would answer it with its status and body; the
 * response is built afresh on every getResponse, since a Response body reads
 * once.
 */
export class ProblemError extends HTTPException {
  readonly body: Problem
  readonly headers: Readonly<Record<string, string>>

  constructor(status: ProblemStatus, options: ProblemOptions = {}) {
    const body = problemBody(status, options)
    super(status, { message: body.detail ?? body.title })
    this.name = "ProblemError"
    this.body = body
    this.headers = options.headers ?? {}
  }

  override getResponse(): Response {
    return toResponse(this.body, this.headers)
  }
}

/** `throw problem(404, { detail: "..." })`: how a handler or a middleware says no. */
export function problem(status: ProblemStatus, options: ProblemOptions = {}): ProblemError {
  return new ProblemError(status, options)
}

// The SQLSTATEs with a meaning on the wire. Both are the database saying "a
// row already there says otherwise", which is a 409 and not a 500: the
// request was well-formed and would be fine against another key or another
// period. A unique violation is two rows with the same key (23505); an
// exclusion violation is two rows whose periods overlap (23P01, the Registry's
// effective-dated tables, Issue #78). Everything else the database refuses is
// ours to have prevented, so it is a 500 with the error logged.
const UNIQUE_VIOLATION = "23505"
const EXCLUSION_VIOLATION = "23P01"

/** What a conflict says when no route foresaw it; the constraint's name is appended where Postgres gave one. */
const CONFLICTS: Readonly<Record<string, string>> = {
  [UNIQUE_VIOLATION]: "A record with the same key already exists",
  [EXCLUSION_VIOLATION]: "A record overlapping this one already exists",
}

/** The SQLSTATE of a failed statement, through Drizzle's wrapper (`cause`) or straight from postgres.js. */
function sqlstate(error: unknown): { code: string; constraint?: string } | undefined {
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    if (typeof candidate !== "object" || candidate === null) continue
    const { code, constraint_name: constraint } = candidate as { code?: unknown; constraint_name?: unknown }
    if (typeof code === "string") return { code, ...(typeof constraint === "string" ? { constraint } : {}) }
  }
  return undefined
}

/** The constraint a failed statement names, when it failed this way and Postgres named one. */
function constraintOf(error: unknown, code: string): string | undefined {
  const failed = sqlstate(error)
  return failed?.code === code ? failed.constraint : undefined
}

/**
 * The constraint a unique violation names, when that is what the error is and
 * Postgres named it. A route that can foresee a collision reads this and
 * answers a sentence of its own (routes/shared.ts), which keeps constraint
 * names off the wire; the mapping below stays the backstop for the ones
 * nobody foresaw.
 */
export function uniqueConstraintOf(error: unknown): string | undefined {
  return constraintOf(error, UNIQUE_VIOLATION)
}

/** The same for an exclusion violation: which `EXCLUDE USING gist` refused the period, for the route that foresaw it. */
export function exclusionConstraintOf(error: unknown): string | undefined {
  return constraintOf(error, EXCLUSION_VIOLATION)
}

/** How far down a `cause` chain the projection below goes; Drizzle wraps postgres.js, which wraps nothing. */
const LOG_CAUSE_DEPTH = 3

/**
 * What goes in the log when a request became a 500: a projection of the
 * error, never the error itself. A postgres.js error carries the statement it
 * sent and the `parameters` it bound, so logging one whole would print an
 * invitee's e-mail address and name (a failed `POST /users`), a company's
 * registration number, or whatever else the body held, into the operator's
 * log — data the request never asked to have kept. What is left is what an
 * operator debugs with: who threw, what it said, the SQLSTATE and the
 * constraint when Postgres named one, the stack, and the same projection of
 * the cause, which is where Drizzle keeps the database's own error.
 */
export function loggable(error: unknown, depth: number = LOG_CAUSE_DEPTH): unknown {
  if (typeof error !== "object" || error === null) return error
  const { name, message, code, constraint_name: constraint, stack, cause } = error as Record<string, unknown>
  return {
    ...(typeof name === "string" ? { name } : {}),
    ...(typeof message === "string" ? { message } : {}),
    ...(typeof code === "string" ? { code } : {}),
    ...(typeof constraint === "string" ? { constraint_name: constraint } : {}),
    ...(typeof stack === "string" ? { stack } : {}),
    ...(cause === undefined || depth <= 0 ? {} : { cause: loggable(cause, depth - 1) }),
  }
}

/**
 * Hono's error handler: the mapping in the header. `log` receives what became
 * a 500, as the projection above; console.error unless the composition root
 * or a test says otherwise.
 */
export function errorHandler(log: (error: unknown) => void = console.error): ErrorHandler {
  return (error) => {
    if (error instanceof ProblemError) return error.getResponse()
    if (error instanceof HTTPException) {
      return problemResponse(isProblemStatus(error.status) ? error.status : 500, error.message === "" ? {} : { detail: error.message })
    }
    const failed = sqlstate(error)
    if (failed !== undefined) {
      const conflict = CONFLICTS[failed.code]
      if (conflict !== undefined) {
        return problemResponse(409, { detail: `${conflict}${failed.constraint === undefined ? "" : ` (${failed.constraint})`}` })
      }
    }
    log(loggable(error))
    return problemResponse(500)
  }
}

/** Hono's not-found hook: an unknown path, or a known one with another method, is a 404 problem too. */
export const notFound: NotFoundHandler = (c) => problemResponse(404, { detail: `No route ${c.req.method} ${c.req.path}` })

/** What a route says about a problem status in its OpenAPI description. */
export function describeProblem(description: string) {
  return { description, content: { [PROBLEM_MEDIA_TYPE]: { schema: resolver(Problem) } } }
}

// The validator hook. Standard Schema's issue shape, spelled here rather than
// imported: @standard-schema/spec is hono-openapi's dependency, not ours.
type Issue = { readonly message: string; readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined }
type Validation = ({ readonly success: true } | { readonly success: false; readonly error: readonly Issue[] }) & { readonly target: string }

/** What the problem calls each target hono can validate; anything else is the part of the request it already names. */
const TARGET_LABELS: Readonly<Record<string, string>> = {
  json: "body",
  form: "form",
  query: "query",
  param: "path",
  header: "headers",
  cookie: "cookies",
}

/**
 * The 400 a refused part of a request answers: "The request <part> is
 * invalid", and one error per field. Exported because a schema is not the
 * only thing that can refuse a field — a cursor this API did not write
 * (pagination.ts), a project the account does not work in (auth/projects.ts)
 * and an id naming nobody's row (routes/shared.ts) all end here, so a client
 * reads one shape whatever noticed. `target` is hono's name for the part
 * (`json`, `param`) or the part itself (`body`, `query`).
 */
export function invalidRequest(target: string, errors: ProblemFieldError[]): ProblemError {
  return problem(400, { detail: `The request ${TARGET_LABELS[target] ?? target} is invalid`, errors })
}

const pathOf = (issue: Issue): string =>
  (issue.path ?? []).map((segment) => String(typeof segment === "object" ? segment.key : segment)).join(".")

/** Turns a failed validation into a 400 problem listing every issue by path; lets a passed one through. */
export function validationHook(result: Validation): void {
  if (result.success) return
  throw invalidRequest(
    result.target,
    result.error.map((issue) => ({ path: pathOf(issue), message: issue.message })),
  )
}

type ValidationTarget = Parameters<typeof validator>[0]
type ValidationSchema = Parameters<typeof validator>[1]

/**
 * hono-openapi's validator with the 400 above in force. Routes validate
 * through this and nothing else; `c.req.valid(target)` in the handler is
 * typed by the schema as with the bare validator.
 */
export function validate<Schema extends ValidationSchema, Target extends ValidationTarget>(target: Target, schema: Schema) {
  return validator(target, schema, validationHook)
}
