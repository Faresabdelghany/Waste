// GET /me: who the caller is here, as the request path resolved it. The body
// is the Principal (auth/principal.ts) in the shape @waste/contracts/me
// spells; no query of its own, since everything in it was looked up to let
// the request through. The frontend reads it once after sign-in for the
// sidebar and the permission gates, and again whenever it wants to know
// whether a grant or a project changed under it.
//
// The shape a route module takes from here on: a function of the guard that
// returns a sub-app on AuthEnv, each authenticated route spelling
// `describeRoute(...)` with the bearer requirement, then the guard, then any
// `requireGrant`, then the handler; app.ts mounts it at the root. The guard
// sits on the route and never on a wildcard, so an unknown path stays a 404.
import { Me } from "@waste/contracts/me"
import { NO_ACTIVE_ACCOUNT } from "@waste/contracts/problem"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute, resolver } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { describeProblem } from "../problem"

/** The Principal on the wire. */
export function meOf(principal: Principal): Me {
  return {
    user: { ...principal.user, status: "active" },
    company: principal.company,
    role: {
      ...principal.role,
      grants: principal.grants.map((grant) => ({ moduleKey: grant.moduleKey, actions: [...grant.actions] })),
    },
    projects: principal.projects,
    serviceProvider: principal.serviceProvider,
    driver: principal.driver,
  }
}

export function meRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>().get(
    "/me",
    describeRoute({
      operationId: "getMe",
      summary: "Who am I here?",
      description:
        "The caller as this request resolved them: the account the token is bound to, its company, its role with the grants in force, the projects it works in, its Service Provider, if any, and the active driver profile bound to it, if any — a client lands a driver on the driver's app by that and nothing else. Nothing is cached: a changed grant shows on the next call.",
      security: BEARER_SECURITY,
      responses: {
        200: {
          description: "The caller's account, company, role with grants, projects, Service Provider and driver profile.",
          content: { "application/json": { schema: resolver(Me) } },
        },
        401: describeProblem("No usable token: none sent, not one Bearer token, or a token this project did not issue (see WWW-Authenticate)."),
        403: describeProblem(
          `A valid token, but no active account in its company is bound to it, or it names no company at all: the problem's type is \`${NO_ACTIVE_ACCOUNT.type}\`, the refusal of the account rather than the request, on which a client ends its session.`,
        ),
      },
    }),
    guard,
    (c) => c.json(meOf(c.get("principal"))),
  )
}
