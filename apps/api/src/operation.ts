// A route is one declaration (#574): its method and path, what the published
// document says of it, the grant it asks, the transaction it runs in and what
// it validates, handed to `Routes`, which puts the description, the guard, the
// grant and the validators on the route in the one order every route keeps.
//
// What the document says of the token (401), of the grant (403) and of the
// refusals the path's id and the page rule make (400) is derived from the
// same arguments that enforce them, so the document and the guard cannot
// disagree. A route states the rest: its own 400 clauses (`invalid`), and any
// 401 or 403 that says more than the derived one.
//
// The guard is `authenticate` — the request's transaction, `c.get("tx")` —
// unless the route says `transaction: false`: a route that calls another
// service holds no transaction across the call (#124 §4), so its guard is
// `identify`, and it opens short ones of its own through `c.get("transact")`.
// A public route names its `door` (ADR-0010) and takes no token.
import { PageRequest } from "@waste/contracts/pagination"
import type { Action, ModuleKey } from "@waste/domain/access/modules"
import { PAGE_LIMIT_MAX } from "@waste/domain/requests"
import { Hono, type Handler, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"
import type * as z from "zod"

import { BEARER_SECURITY, type AuthEnv, type IdentifiedEnv, type Principal } from "./auth/principal"
import type { PublicEnv } from "./auth/public-door"
import { requireGrant, requireGrantOf } from "./auth/require"
import { describeProblem, validate } from "./problem"
import { IdParam } from "./routes/shared"

type Responses = NonNullable<NonNullable<Parameters<typeof describeRoute>[0]>["responses"]>

export type Operation = {
  operationId: string
  summary: string
  description: string
  /** The module whose grant the route asks, or the account's choice of two (`requireGrantOf`); absent where the guard alone admits. */
  module?: ModuleKey | ((principal: Principal) => ModuleKey)
  action?: Action
  /** A second grant the route asks after the first: a report's rows, a move's agreements. */
  also?: readonly [ModuleKey, Action]
  /** `false` where the route calls another service: `identify`'s checks, and no transaction held across the call. */
  transaction?: false
  /** A public route's door (ADR-0010): no token, no grant, read as `wms_public`. */
  door?: MiddlewareHandler<PublicEnv>
  /** Run before the guard: a body's bound, a register read before the transaction opens. */
  before?: readonly MiddlewareHandler[]
  /** Run after the grants and before the validators: an allowance, a grant of the caller's choosing. */
  use?: readonly MiddlewareHandler[]
  params?: z.ZodType
  query?: z.ZodType
  body?: z.ZodType
  /** The route's own 400 clauses, after those the path's id and the page rule make: "the body is missing a field". */
  invalid?: readonly string[]
  responses: Responses
}

type Validated<S extends Operation> = (S extends { params: infer P extends z.ZodType } ? { param: z.output<P> } : object) &
  (S extends { query: infer Q extends z.ZodType } ? { query: z.output<Q> } : object) &
  (S extends { body: infer B extends z.ZodType } ? { json: z.output<B> } : object)

type Sent<S extends Operation> = (S extends { params: infer P extends z.ZodType } ? { param: z.input<P> } : object) &
  (S extends { query: infer Q extends z.ZodType } ? { query: z.input<Q> } : object) &
  (S extends { body: infer B extends z.ZodType } ? { json: z.input<B> } : object)

/** What the handler's context carries: the request's transaction, or for `transaction: false` the means to open one, or a public door's project. */
export type EnvOf<S extends Operation> = S extends { door: MiddlewareHandler<PublicEnv> } ? PublicEnv : S extends { transaction: false } ? IdentifiedEnv : AuthEnv

export type OperationHandler<Path extends string, S extends Operation> = Handler<EnvOf<S>, Path, { in: Sent<S>; out: Validated<S> }>

/** The two guards an operation is put behind; the app builds each once. */
export type Guards = {
  authenticate: MiddlewareHandler<AuthEnv>
  identify: MiddlewareHandler<IdentifiedEnv>
}

const NO_TOKEN = "No usable token (see WWW-Authenticate)."

/** The 403 a grant earns, in the words every route has used: the account, or the role's grant of the action on the module (and of the second). */
function forbidden(module: ModuleKey, action: Action, also?: readonly [ModuleKey, Action]): string {
  const second = also === undefined ? "" : ` and \`${also[1]}\` on \`${also[0]}\``
  return `No active account here, or the caller's role does not allow \`${action}\` on \`${module}\`${second}.`
}

/** The 403 of a route the guard alone admits. */
const NO_ACCOUNT = "No active account here."

const PATH_ID = "the path does not hold an id"
const PAGE = [`the page size is outside 1..${PAGE_LIMIT_MAX}`, "the cursor is not one this API wrote"]

/** Whether a query is a page of a list: `PageRequest`'s members, through any refinement. */
function isPaged(schema: z.ZodType | undefined): boolean {
  const shape = (schema as { shape?: Record<string, unknown> } | undefined)?.shape
  return shape !== undefined && shape.cursor === PageRequest.shape.cursor && shape.limit === PageRequest.shape.limit
}

/** Clauses as one sentence: "A.", "A, or B.", "A, B, or C." */
export function refusalSentence(clauses: readonly string[]): string {
  const first = clauses[0]
  if (first === undefined) throw new Error("a sentence of no clauses")
  const capitalised = [first.charAt(0).toUpperCase() + first.slice(1), ...clauses.slice(1)]
  const last = capitalised.length > 1 ? `or ${capitalised[capitalised.length - 1]}` : capitalised[0]
  return `${[...capitalised.slice(0, -1), last].join(", ")}.`
}

/** The description the document carries: the route's own, with the 401, 403 and 400 derived where the route does not state them. */
function documented(operation: Operation): Parameters<typeof describeRoute>[0] {
  const { operationId, summary, description, module, action, also } = operation
  const responses: Responses = { ...operation.responses }
  const clauses = [...(operation.params === IdParam ? [PATH_ID] : []), ...(isPaged(operation.query) ? PAGE : []), ...(operation.invalid ?? [])]
  if (clauses.length > 0) {
    if (responses[400] !== undefined) throw new Error(`${operationId}: a 400 is stated through \`invalid\`, not beside it`)
    responses[400] = describeProblem(refusalSentence(clauses))
  }
  if (operation.door !== undefined) return { operationId, summary, description, responses }
  responses[401] ??= describeProblem(NO_TOKEN)
  if (responses[403] === undefined) {
    if (typeof module === "function") throw new Error(`${operationId}: a grant the account chooses states its own 403`)
    responses[403] = describeProblem(module === undefined || action === undefined ? NO_ACCOUNT : forbidden(module, action, also))
  }
  return { operationId, summary, description, security: BEARER_SECURITY, responses }
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

/** A route module's operations, in the order they are registered; `app` is what the app mounts at its root. */
export class Routes {
  readonly app = new Hono()

  constructor(private readonly guards: Guards) {}

  get<Path extends string, const S extends Operation>(path: Path, operation: S, handler: OperationHandler<Path, S>): this {
    return this.on("GET", path, operation, handler)
  }

  post<Path extends string, const S extends Operation>(path: Path, operation: S, handler: OperationHandler<Path, S>): this {
    return this.on("POST", path, operation, handler)
  }

  put<Path extends string, const S extends Operation>(path: Path, operation: S, handler: OperationHandler<Path, S>): this {
    return this.on("PUT", path, operation, handler)
  }

  patch<Path extends string, const S extends Operation>(path: Path, operation: S, handler: OperationHandler<Path, S>): this {
    return this.on("PATCH", path, operation, handler)
  }

  delete<Path extends string, const S extends Operation>(path: Path, operation: S, handler: OperationHandler<Path, S>): this {
    return this.on("DELETE", path, operation, handler)
  }

  private on(method: Method, path: string, operation: Operation, handler: Handler): this {
    const { module, action, also } = operation
    if ((module === undefined) !== (action === undefined)) throw new Error(`${operation.operationId}: a grant names both its module and its action`)
    if (also !== undefined && module === undefined) throw new Error(`${operation.operationId}: a second grant without a first`)
    const guard = operation.door ?? (operation.transaction === false ? this.guards.identify : this.guards.authenticate)
    const grant = module === undefined || action === undefined ? [] : [typeof module === "function" ? requireGrantOf(module, action) : requireGrant(module, action)]
    if (also !== undefined) grant.push(requireGrant(...also))
    const validators = [
      ...(operation.params === undefined ? [] : [validate("param", operation.params)]),
      ...(operation.query === undefined ? [] : [validate("query", operation.query)]),
      ...(operation.body === undefined ? [] : [validate("json", operation.body)]),
    ]
    const chain = [describeRoute(documented(operation)), ...(operation.before ?? []), guard, ...grant, ...(operation.use ?? []), ...validators, handler] as MiddlewareHandler[]
    this.app.on(method, path, ...(chain as [MiddlewareHandler]))
    return this
  }
}

/** An operation declared apart from its route, where several routes share most of it; its types kept as written, for the handler's. */
export const operation = <const S extends Operation>(declared: S): S => declared

/** A route module's builder over the app's guards. */
export const routes = (guards: Guards): Routes => new Routes(guards)
