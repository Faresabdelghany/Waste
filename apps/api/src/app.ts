// The Hono application, built once per process. Each route is described where
// it is defined (hono-openapi), and GET /openapi.json is generated from those
// descriptions at request time, so a described route is always in the
// published contract (the generator's static-file heuristic is switched off
// below; a described OPTIONS handler is the one thing it leaves out). Hono's
// defaults stand for anything else, including the text 404 for an unknown
// path: the error shape on the wire is decided with the first real endpoint,
// not by the scaffold, and not by the generator either.
import { HealthResponse } from "@waste/contracts/health"
import { Hono } from "hono"
import { describeRoute, openAPIRouteHandler, resolver } from "hono-openapi"

import manifest from "../package.json" with { type: "json" }

export type AppOptions = {
  /** The server's clock; injected so a test can pin it. */
  now?: () => Date
}

export function createApp({ now = () => new Date() }: AppOptions = {}) {
  const app = new Hono()

  app.get(
    "/healthz",
    describeRoute({
      operationId: "getHealth",
      summary: "Is the API up?",
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
