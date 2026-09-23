// The Hono application, built once per process. Each route is described where
// it is defined (hono-openapi), and GET /openapi.json is generated from those
// descriptions at request time, so a described route is always in the
// published contract (the generator's static-file heuristic is switched off
// below; a described OPTIONS handler is the one thing it leaves out). Hono's
// defaults stand for anything else, including the text 404 for an unknown
// path: the error shape on the wire is decided with the first real endpoint,
// not by the scaffold, and not by the generator either.
//
// Two probes: /healthz is liveness (the process answers, with its clock) and
// /readyz is readiness (the database answers, within readiness.ts's bound).
// The pool the probe runs on comes in from the composition root (readiness.ts
// says why it is the probe's own); the app never connects on its own, so
// building it costs nothing and a test hands a route that asks nothing of the
// database a pool that goes nowhere. A request pool joins when the first
// domain route needs one.
import { HealthResponse, ReadinessResponse, ReadyResponse, UnavailableResponse } from "@waste/contracts/health"
import type { Database } from "@waste/db/client"
import { Hono } from "hono"
import { describeRoute, openAPIRouteHandler, resolver } from "hono-openapi"

import manifest from "../package.json" with { type: "json" }
import { checkDatabase, DATABASE_CHECK_TIMEOUT_MS } from "./readiness"

export type AppOptions = {
  /** The pool /readyz probes, as the API role: server.ts builds it from probePoolOptions; a test hands whatever it wants probed. */
  probe: Database
  /** The server's clock; injected so a test can pin it. */
  now?: () => Date
  /** How long /readyz waits for the database before answering 503. */
  databaseTimeoutMs?: number
}

export function createApp({ probe, now = () => new Date(), databaseTimeoutMs = DATABASE_CHECK_TIMEOUT_MS }: AppOptions) {
  const app = new Hono()

  app.get(
    "/healthz",
    describeRoute({
      operationId: "getHealth",
      summary: "Is the API up?",
      description: "Liveness: the process answers, and this is its clock. Says nothing about the database; that is GET /readyz.",
      responses: {
        200: {
          description: "The API is up, and this is its clock.",
          content: { "application/json": { schema: resolver(HealthResponse) } },
        },
      },
    }),
    (c) => {
      const body: HealthResponse = { status: "ok", time: now().toISOString() }
      return c.json(body)
    },
  )

  app.get(
    "/readyz",
    describeRoute({
      operationId: "getReadiness",
      summary: "Can the API serve a request right now?",
      description: `Readiness: the database answers a probe within ${databaseTimeoutMs} ms. A balancer takes the instance out of rotation on 503 and back in on 200; the process itself stays up.`,
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
        return c.json(body, 200)
      }
      const body: ReadinessResponse = { status: "unavailable", checks: { database } }
      return c.json(body, 503)
    },
  )

  app.get(
    "/openapi.json",
    openAPIRouteHandler(app, {
      documentation: {
        info: {
          title: "WasteHero API",
          version: manifest.version,
          description: "The only web boundary to domain data (ADR-0001).",
        },
      },
      // The API serves no static files: a path whose last segment has a dot
      // (`/routes/export.csv`) is a route like any other and belongs in the
      // document.
      excludeStaticFile: false,
      // The generator would otherwise publish its own 400 envelope for every
      // route with a validator(). The 400 shape is ours to decide, together
      // with the validator hook, when the first validated route lands.
      defaultValidationErrorResponse: false,
    }),
  )

  return app
}
