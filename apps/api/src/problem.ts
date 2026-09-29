// How the API says no: every error body is an RFC 9457 Problem Details
// document, `application/problem+json`, in the shape @waste/contracts/problem
// spells (Issue #70; the #45 and #64 scaffolds deferred the error shape to
// "the first real endpoint"). A handler raises one by throwing
// `problem(status, { detail })`; the error handler installed by app.ts turns
// that, and anything else that escapes a handler, into a response:
//
//   a ProblemError          → its own body and headers (a 401 carries WWW-Authenticate)
//   a Refused               → the problem of its status: a shared write
//                             statement (`@waste/db/commands/*`, which the
//                             worker runs too and which therefore throws no
//                             ProblemError) refused a rule — a 409 with its
//                             sentence, or a 400 at the field the value came
//                             in, the shape the validator's own 400s take
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
// empty for the target as a whole. A member a strict body does not know is
// one error per key at the key's own path, naming it and the members that
// object does accept, read off the schema at the issue's path (`membersAt`;
// Issue #74). A route validates through `validate`, never
// through the bare validator, so the 400 shape is in force wherever there is
// one. That 400 is `invalidRequest(target, errors)` and it is exported,
// because a schema is not the only thing that can refuse a field: a cursor
// this API did not write, a project the account does not work in, an id
// naming nobody's row. They are all the same answer, so they are all built
// here.
import { STATUS_CODES } from "node:http"

import { BLANK_PROBLEM_TYPE, PROBLEM_MEDIA_TYPE, Problem, type ProblemFieldError, type ProblemKind } from "@waste/contracts/problem"
import { Refused } from "@waste/db/commands/shared"
import { checkConstraintOf, EXCLUSION_VIOLATION, exclusionConstraintOf, sqlstate, UNIQUE_VIOLATION, uniqueConstraintOf } from "@waste/db/sqlstate"
import type { ErrorHandler, NotFoundHandler } from "hono"
import { HTTPException } from "hono/http-exception"
import type { ClientErrorStatusCode, ServerErrorStatusCode } from "hono/utils/http-status"
import { resolver, validator } from "hono-openapi"

/** A status a problem can carry: 4xx or 5xx. */
export type ProblemStatus = ClientErrorStatusCode | ServerErrorStatusCode

export type ProblemOptions = {
  /**
   * The kind of problem when it is more than its status, a type and title of
   * `@waste/contracts/problem`; only the principal's two account refusals
   * name one (auth/principal.ts). Absent, the problem is `about:blank`.
   */
  kind?: ProblemKind
  /** One sentence on what went wrong with this request. Never on a 500. */
  detail?: string
  /** The fields a 400 refused. */
  errors?: ProblemFieldError[]
  /** Response headers the status needs, such as a 401's `WWW-Authenticate`. */
  headers?: Readonly<Record<string, string>>
}

const isProblemStatus = (status: number): status is ProblemStatus => status >= 400 && status <= 599

/** The body of a problem of this status: its kind's type and title, else `about:blank` and the reason phrase, and what the caller added. */
export function problemBody(status: ProblemStatus, { kind, detail, errors }: ProblemOptions = {}): Problem {
  return {
    type: kind?.type ?? BLANK_PROBLEM_TYPE,
    title: kind?.title ?? STATUS_CODES[status] ?? `${status}`,
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

// The SQLSTATEs with a meaning on the wire, read through `@waste/db/sqlstate`
// since Issue #109 part B, where the worker reads them too (a unique
// violation on `ticket_source_event_id_idx` is an event handled before). Both
// are the database saying "a row already there says otherwise", which is a
// 409 and not a 500: the request was well-formed and would be fine against
// another key or another period. A unique violation is two rows with the
// same key (23505); an exclusion violation is two rows whose periods overlap
// (23P01, the Registry's effective-dated tables, Issue #78). Everything else
// the database refuses is ours to have prevented, so it is a 500 with the
// error logged. A check violation (23514) is different news: the row is
// alone and its own value will not do. Where the API could run the check
// itself it does, and the caller reads a 400 before any write; where only
// the database can (the Planning context's `st_isvalid` on a polygon, Issue
// #97), the route names the constraint and reads it through
// `checkConstraintOf` to answer that same 400 on the field (routes/shared.ts,
// `refuseCheck`). It is not in CONFLICTS below: a check nobody foresaw is
// ours to have prevented, so it stays a 500, which is the signal that a
// sentence is missing. The three readers are re-exported under the names the
// routes and their tests always used.
export { checkConstraintOf, exclusionConstraintOf, uniqueConstraintOf }

/** What a conflict says when no route foresaw it; the constraint's name is appended where Postgres gave one. */
const CONFLICTS: Readonly<Record<string, string>> = {
  [UNIQUE_VIOLATION]: "A record with the same key already exists",
  [EXCLUSION_VIOLATION]: "A record overlapping this one already exists",
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
 * The problem a shared write statement's refusal answers (Issue #109 part B):
 * a 409 with the sentence, or — for a value the body carried that will not
 * do — the 400 `invalidRequest` answers, one error at the field the value
 * came in, so a client reads the same shape whether a route or a statement
 * both processes run noticed. The statements throw `Refused` and never a
 * `ProblemError`, since the worker runs them too and has no response to put
 * one in.
 */
export function refusedProblem(error: Refused): ProblemError {
  return error.status === 400 ? invalidRequest("body", [{ path: error.path ?? "", message: error.message }]) : problem(error.status, { detail: error.message })
}

const refusedResponse = (error: Refused): Response => refusedProblem(error).getResponse()

/**
 * Hono's error handler: the mapping in the header. `log` receives what became
 * a 500, as the projection above; console.error unless the composition root
 * or a test says otherwise.
 */
export function errorHandler(log: (error: unknown) => void = console.error): ErrorHandler {
  return (error) => {
    if (error instanceof ProblemError) return error.getResponse()
    if (error instanceof Refused) return refusedResponse(error)
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
type PathSegment = PropertyKey | { readonly key: PropertyKey }
type Issue = { readonly message: string; readonly path?: ReadonlyArray<PathSegment> | undefined }
type Validation = ({ readonly success: true } | { readonly success: false; readonly error: readonly Issue[] }) & { readonly target: string }

/**
 * zod's issue for a key a strict object does not know: the one issue the hook
 * rewrites (Issue #74). zod hands the validator its own issues, which carry
 * `code` and, for this one, the `keys` — one issue per object, however many
 * keys it did not know — so a hook that reads them needs no import from zod
 * and takes the shape by its two members.
 */
type UnrecognizedKeys = Issue & { readonly code: "unrecognized_keys"; readonly keys: readonly string[] }

const isUnrecognizedKeys = (issue: Issue): issue is UnrecognizedKeys => {
  const { code, keys } = issue as { code?: unknown; keys?: unknown }
  return code === "unrecognized_keys" && Array.isArray(keys) && keys.every((key) => typeof key === "string")
}

// A zod 4 schema, by the little of it this reads: every schema exposes its
// definition as `def` (the public face of the same object its `_zod`
// internals hold, so a zod minor that moves the internals cannot quietly
// turn every one of these 400s into the bare sentence), `def.type` says the
// kind, and the kinds that hold another schema name it under a field of
// their own. Spelled structurally so the walk is typed against what it
// touches and nothing else.
type Node = { readonly def: Def }
type Def = {
  readonly type: string
  readonly shape?: Readonly<Record<string, Node>>
  readonly innerType?: Node
  readonly element?: Node
  readonly items?: readonly Node[]
  readonly keyType?: Node
  readonly valueType?: Node
  readonly in?: Node
  readonly getter?: () => Node
  readonly entries?: Readonly<Record<string, string | number>>
  readonly values?: readonly unknown[]
}

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as { def?: { type?: unknown } }).def?.type === "string"

/** The kinds that wrap one schema and validate what it validates: an optional strict object is still that object. */
const WRAPPERS: ReadonlySet<string> = new Set(["optional", "nullable", "default", "prefault", "nonoptional", "catch", "readonly"])

/** Through the wrappers to the schema that decides the shape; a pipe's input side, since that is what a body is validated against. */
function unwrap(node: Node | undefined): Node | undefined {
  let current = node
  for (let depth = 0; current !== undefined && depth < 32; depth += 1) {
    const { def } = current
    if (WRAPPERS.has(def.type)) current = def.innerType
    else if (def.type === "pipe") current = def.in
    else if (def.type === "lazy") current = def.getter?.()
    else return current
  }
  return current
}

const keyOf = (segment: PathSegment): PropertyKey => (typeof segment === "object" ? segment.key : segment)

/**
 * The keys a record's key schema names, where it names a finite set: an
 * enum's values (its `entries` less a numeric enum's reverse mapping, the
 * way zod reads them) or a literal's `values`. zod refuses a key outside
 * such a set as unrecognized, exactly as an object refuses a member it does
 * not know, so the same sentence lists these. A key schema that is a
 * constraint rather than a set — `z.string()`, a regex — names no members.
 */
function recordKeys(keyType: Node | undefined): string[] | undefined {
  const def = unwrap(keyType)?.def
  if (def?.type === "enum" && def.entries !== undefined) {
    const numeric = new Set(Object.values(def.entries).filter((value) => typeof value === "number"))
    return Object.entries(def.entries)
      .filter(([key]) => !numeric.has(Number(key)))
      .map(([, value]) => String(value))
  }
  if (def?.type === "literal" && def.values !== undefined) return def.values.map(String)
  return undefined
}

/**
 * The members the object at `path` inside `schema` accepts, in the order the
 * schema spells them — or the keys a record there names, where its key schema
 * is a finite set; undefined where the path leads to neither — a scalar, a
 * member that is not there, a union, or something that is not a zod schema at
 * all — so the caller falls back to saying less rather than throwing. Walks
 * an object by member, an array by element, a tuple by index, a record by
 * value, and through the wrappers above at every step. An object with no
 * members answers an empty list, which is an answer: it accepts nothing.
 */
export function membersAt(schema: unknown, path: ReadonlyArray<PathSegment>): string[] | undefined {
  let node = isNode(schema) ? unwrap(schema) : undefined
  for (const segment of path) {
    if (node === undefined) return undefined
    const { def } = node
    const key = keyOf(segment)
    let next: Node | undefined
    if (def.type === "object") next = typeof key === "string" ? def.shape?.[key] : undefined
    else if (def.type === "array") next = def.element
    else if (def.type === "tuple") next = def.items?.[Number(key)]
    else if (def.type === "record") next = def.valueType
    node = unwrap(next)
  }
  if (node?.def.type === "object" && node.def.shape !== undefined) return Object.keys(node.def.shape)
  if (node?.def.type === "record") return recordKeys(node.def.keyType)
  return undefined
}

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

const dotted = (path: ReadonlyArray<PathSegment>): string => path.map((segment) => String(keyOf(segment))).join(".")

/**
 * The errors of one unrecognized-keys issue: one per key the object did not
 * know, each at the key's own path (`colour`, `parties.0.colour`), each naming
 * the key and the members that object does accept, in schema order — read
 * off the schema at the issue's path, since every write body is a strict
 * object and a client fixing a typo is helped most by the list. Whose members
 * they are is said by the path, or by the target where the path is empty
 * ("the body's members are …", "the query's members are …"); an object with
 * no members "accepts no members", since a list with nothing after it says
 * less than that. Where the path leads to no object, which it always should,
 * the sentence stops at the key.
 */
function unrecognizedKeyErrors(issue: UnrecognizedKeys, target: string, schema: unknown): ProblemFieldError[] {
  const path = issue.path ?? []
  const members = membersAt(schema, path)
  const subject = path.length === 0 ? `the ${TARGET_LABELS[target] ?? target}` : dotted(path)
  const accepts =
    members === undefined ? ""
    : members.length === 0 ? `; ${subject} accepts no members`
    : path.length === 0 ? `; ${subject}'s members are ${members.join(", ")}`
    : `; the members of ${subject} are ${members.join(", ")}`
  return issue.keys.map((key) => ({ path: dotted([...path, key]), message: `Unrecognized key ${JSON.stringify(key)}${accepts}` }))
}

/**
 * Turns a failed validation into a 400 problem listing every issue by path,
 * in issue order, an unrecognized-keys issue expanded as above; lets a passed
 * one through. `schema` is the one the validation ran against, which is where
 * the members an object accepts are read from.
 */
export function validationHook(result: Validation, schema: unknown): void {
  if (result.success) return
  throw invalidRequest(
    result.target,
    result.error.flatMap((issue) =>
      isUnrecognizedKeys(issue) ? unrecognizedKeyErrors(issue, result.target, schema) : [{ path: dotted(issue.path ?? []), message: issue.message }],
    ),
  )
}

type ValidationTarget = Parameters<typeof validator>[0]
type ValidationSchema = Parameters<typeof validator>[1]

/**
 * hono-openapi's validator with the 400 above in force. Routes validate
 * through this and nothing else; `c.req.valid(target)` in the handler is
 * typed by the schema as with the bare validator. The hook is given the
 * schema, which the validator itself does not pass on, so it can name what a
 * strict object accepts.
 */
export function validate<Schema extends ValidationSchema, Target extends ValidationTarget>(target: Target, schema: Schema) {
  return validator(target, schema, (result) => validationHook(result, schema))
}
