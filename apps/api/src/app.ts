// The Hono application, built once per process. Each route is described where
// it is defined (hono-openapi), and GET /openapi.json is generated from those
// descriptions at request time, so a described route is always in the
// published contract (the generator's static-file heuristic is switched off
// below; a described OPTIONS handler is the one thing it leaves out). Every
// error on the wire is a Problem Details document (problem.ts): the error
// handler and the not-found hook are installed here, so a thrown problem, a
// unique violation, an unknown path and an unexpected error all answer in the
// one shape.
//
// Two probes: /healthz is liveness (the process answers, with its clock and
// the build it runs, build-info.ts) and /readyz is readiness (the database
// answers, within the probe's bound). Both answer Cache-Control: no-store,
// since the Pilot's release reads them to prove a deployment live (Issue
// #152) and a cached answer would prove nothing.
// Two pools come in from the composition root and the app connects on
// neither by itself: the probe pool, the probe's own (@waste/db/probe says
// why), and the request pool, on which every authenticated request runs as one
// fenced transaction (auth/principal.ts). A test hands a route that asks
// nothing of the database pools that go nowhere.
//
// Authentication is per route, never a wildcard: each route module declares
// its operations (operation.ts), each put behind its guard, so the probes and
// the document need no token and an unknown path is a 404, not a 401. The
// modules are mounted from one list (route-modules.ts), each handed the app's
// deps (deps.ts). The verifier is injected: server.ts builds it over the
// project's remote key set, a test over a local one, and the app never reads
// SUPABASE_URL or anything else of the environment itself.
import { HealthResponse, PROBE_HEADERS, ReadinessResponse, ReadyResponse, UnavailableResponse } from "@waste/contracts/health"
import { checkDatabase } from "@waste/db/probe"
import { NO_ACTIVE_ACCOUNT } from "@waste/domain/access/accounts"
import { CHANGE_REASON_HEADER } from "@waste/domain/audit/vocabulary"
import { PARAGRAPH_MAX } from "@waste/domain/text"
import { CHECK_TIMEOUT_MS } from "@waste/process/readiness"
import { Hono } from "hono"
import { describeRoute, openAPIRouteHandler, resolver } from "hono-openapi"

import manifest from "../package.json" with { type: "json" }
import { BEARER_AUTH, BEARER_SECURITY_SCHEME } from "./auth/principal"
import { routeDeps, type AppOptions } from "./deps"
import { errorHandler, notFound } from "./problem"
import { ROUTE_MODULES } from "./route-modules"

export function createApp(options: AppOptions) {
  const { probe, databaseTimeoutMs = CHECK_TIMEOUT_MS, build = null } = options
  const deps = routeDeps(options)
  const { now } = deps
  const app = new Hono()
  app.onError(errorHandler(deps.log))
  app.notFound(notFound)

  app.get(
    "/healthz",
    describeRoute({
      operationId: "getHealth",
      summary: "Is the API up?",
      description:
        "Liveness: the process answers, this is its clock, and this is the build it runs — the commit its image was built from, or null where it runs from a checkout. Says nothing about the database; that is GET /readyz. Never cached (Cache-Control: no-store).",
      responses: {
        200: {
          description: "The API is up, this is its clock, and this is its build.",
          content: { "application/json": { schema: resolver(HealthResponse) } },
        },
      },
    }),
    (c) => {
      const body: HealthResponse = { status: "ok", time: now().toISOString(), build }
      return c.json(body, 200, PROBE_HEADERS)
    },
  )

  app.get(
    "/readyz",
    describeRoute({
      operationId: "getReadiness",
      summary: "Can the API serve a request right now?",
      description: `Readiness: the database answers a probe within ${databaseTimeoutMs} ms. A balancer takes the instance out of rotation on 503 and back in on 200; the process itself stays up. Never cached (Cache-Control: no-store).`,
      responses: {
        200: {
          description: "Every check passed: the database answers.",
          content: { "application/json": { schema: resolver(ReadyResponse) } },
        },
        503: {
          description: "The database did not answer within the bound. Take this instance out of rotation and probe again.",
          content: { "application/json": { schema: resolver(UnavailableResponse) } },
        },
      },
    }),
    async (c) => {
      const database = await checkDatabase(probe.sql, { timeoutMs: databaseTimeoutMs })
      if (database === "ok") {
        const body: ReadinessResponse = { status: "ok", checks: { database } }
        return c.json(body, 200, PROBE_HEADERS)
      }
      const body: ReadinessResponse = { status: "unavailable", checks: { database } }
      return c.json(body, 503, PROBE_HEADERS)
    },
  )

  for (const routes of ROUTE_MODULES) app.route("/", routes(deps).app)

  app.get(
    "/openapi.json",
    openAPIRouteHandler(app, {
      documentation: {
        info: {
          title: "Waste API",
          version: manifest.version,
          description: `The only web boundary to domain data (ADR-0001). Every route but the probes and this document takes a Supabase access token as a bearer token; every error is an RFC 9457 problem. Every problem's type is \`about:blank\` but one: a 403 of type \`${NO_ACTIVE_ACCOUNT.type}\` refuses the account and not the request — the token names no company, or no active account in its company is bound to its login — and a client ends its session on it, while a 403 of \`about:blank\`, a role's grant refused, leaves the session alone. A 400 lists the fields it refused by path; every write body is strict, so a member it does not know is refused by name, and the error names the members it does accept. A create answers 201 with \`Location\`, the path of the resource's own GET, root-relative: the API is served at its origin's root and mounts under no prefix. Every write is kept in the audit log (\`GET /audit-events\`) under the account the token names; any request may give its reason in the \`${CHANGE_REASON_HEADER}\` header, percent-encoded as \`encodeURIComponent\` spells it and at most ${PARAGRAPH_MAX} characters decoded (400 naming the header otherwise), which the log keeps beside what changed.`,
        },
        components: {
          securitySchemes: { [BEARER_AUTH]: BEARER_SECURITY_SCHEME },
        },
      },
      // The API serves no static files: a path whose last segment has a dot
      // (`/routes/export.csv`) is a route like any other and belongs in the
      // document.
      excludeStaticFile: false,
      // The generator would otherwise publish its own 400 envelope for every
      // route with a validator(). The 400 is a problem (problem.ts), described
      // by the route that validates.
      defaultValidationErrorResponse: false,
    }),
  )

  return app
}
