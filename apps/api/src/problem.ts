// How the API says no: every error body is an RFC 9457 Problem Details
// document, `application/problem+json`, in the shape @waste/contracts/problem
// spells (Issue #70; the #45 and #64 scaffolds deferred the error shape to
// "the first real endpoint"). A handler raises one by throwing
// `problem(status, { detail })`; the error handler installed by app.ts turns
// that, and anything else that escapes a handler, into a response:
//
//   a ProblemError          → its own body and headers (a 401 carries WWW-Authenticate)
//   one of Hono's own       → a problem of its status, the message as detail
//   SQLSTATE 23505          → 409, since a unique violation is the one database
//                             error a client can do something about, and the
//                             constraint it hit when Postgres names it
//   anything else           → 500 with no detail, the error logged whole; what
//                             the error said stays on the server
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
// one.
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

/** The one SQLSTATE with a meaning on the wire: a unique violation is a 409. */
const UNIQUE_VIOLATION = "23505"

/** The SQLSTATE of a failed statement, through Drizzle's wrapper (`cause`) or straight from postgres.js. */
function sqlstate(error: unknown): { code: string; constraint?: string } | undefined {
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    if (typeof candidate !== "object" || candidate === null) continue
    const { code, constraint_name: constraint } = candidate as { code?: unknown; constraint_name?: unknown }
    if (typeof code === "string") return { code, ...(typeof constraint === "string" ? { constraint } : {}) }
  }
  return undefined
}

/**
 * The constraint a unique violation names, when that is what the error is and
 * Postgres named it. A route that can foresee a collision reads this and
 * answers a sentence of its own (routes/shared.ts), which keeps constraint
 * names off the wire; the mapping below stays the backstop for the ones
 * nobody foresaw.
 */
export function uniqueConstraintOf(error: unknown): string | undefined {
  const failed = sqlstate(error)
  return failed?.code === UNIQUE_VIOLATION ? failed.constraint : undefined
}

/**
 * Hono's error handler: the mapping in the header. `log` receives what became
 * a 500, whole; console.error unless the composition root or a test says
 * otherwise.
 */
export function errorHandler(log: (error: unknown) => void = console.error): ErrorHandler {
  return (error) => {
    if (error instanceof ProblemError) return error.getResponse()
    if (error instanceof HTTPException) {
      return problemResponse(isProblemStatus(error.status) ? error.status : 500, error.message === "" ? {} : { detail: error.message })
    }
    const failed = sqlstate(error)
    if (failed?.code === UNIQUE_VIOLATION) {
      return problemResponse(409, {
        detail: `A record with the same key already exists${failed.constraint === undefined ? "" : ` (${failed.constraint})`}`,
      })
    }
    log(error)
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

/** What the problem calls each target hono can validate. */
const TARGET_LABELS: Readonly<Record<string, string>> = {
  json: "body",
  form: "form",
  query: "query",
  param: "path",
  header: "headers",
  cookie: "cookies",
}

const pathOf = (issue: Issue): string =>
  (issue.path ?? []).map((segment) => String(typeof segment === "object" ? segment.key : segment)).join(".")

/** Turns a failed validation into a 400 problem listing every issue by path; lets a passed one through. */
export function validationHook(result: Validation): void {
  if (result.success) return
  throw problem(400, {
    detail: `The request ${TARGET_LABELS[result.target] ?? result.target} is invalid`,
    errors: result.error.map((issue) => ({ path: pathOf(issue), message: issue.message })),
  })
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
