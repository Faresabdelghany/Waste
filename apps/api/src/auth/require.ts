// May they? A route that reads or changes a module's records puts
// `requireGrant(moduleKey, action)` after `authenticate` and before its
// handler: the principal's grant set, already normalised when it was resolved
// (edit, create and delete imply view, @waste/domain/access/grants), must list
// that action for that module, or the request is refused with a 403 naming
// both. Nothing here reads the database: the grants were looked up once for
// the request, and a revoked grant is gone from the next request's set.
//
// The vocabulary is the domain's: a route can only name a module key and an
// action that exist, so a typo in a route is a compile error and not a route
// nobody can reach.
import type { Grant } from "@waste/domain/access/grants"
import type { Action, ModuleKey } from "@waste/domain/access/modules"
import type { MiddlewareHandler } from "hono"

import { problem } from "../problem"
import type { IdentifiedEnv } from "./principal"

/** Whether a normalised grant set lists the action for the module. */
export function allows(grants: readonly Grant[], moduleKey: ModuleKey, action: Action): boolean {
  return grants.some((grant) => grant.moduleKey === moduleKey && grant.actions.includes(action))
}

/** The 403 when the grant set does not list the action for the module; what the guard throws, and what a handler asks where the body decides a second action (#205: a scheme's patch that adds a group asks `create` too). */
export function requireAllowed(grants: readonly Grant[], moduleKey: ModuleKey, action: Action): void {
  if (!allows(grants, moduleKey, action)) throw problem(403, { detail: `This account's role does not allow ${action} on ${moduleKey}` })
}

/** The guard after `authenticate` or `identify`: passes when the caller's role grants the action on the module, else 403. */
export function requireGrant(moduleKey: ModuleKey, action: Action): MiddlewareHandler<IdentifiedEnv> {
  return async (c, next) => {
    requireAllowed(c.get("principal").grants, moduleKey, action)
    await next()
  }
}
