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
// answers, within readiness.ts's bound). Both answer Cache-Control: no-store,
// since the Pilot's release reads them to prove a deployment live (Issue
// #152) and a cached answer would prove nothing.
// Two pools come in from the composition root and the app connects on
// neither by itself: the probe pool, the probe's own (readiness.ts says why),
// and the request pool, on which every authenticated request runs as one
// fenced transaction (auth/principal.ts). A test hands a route that asks
// nothing of the database pools that go nowhere.
//
// Authentication is per route, never a wildcard: each authenticated route
// module takes the guard and puts it on its routes (routes/me.ts shows the
// shape), so the probes and the document need no token and an unknown path
// is a 404, not a 401. The verifier is injected: server.ts builds it over the
// project's remote key set, a test over a local one, and the app never reads
// SUPABASE_URL itself.
import { type BuildInfo, HealthResponse, PROBE_HEADERS, ReadinessResponse, ReadyResponse, UnavailableResponse } from "@waste/contracts/health"
import { NO_ACTIVE_ACCOUNT } from "@waste/contracts/problem"
import type { Database } from "@waste/db/client"
import { createJobSender, type JobSender } from "@waste/db/jobs"
import { Hono } from "hono"
import { describeRoute, openAPIRouteHandler, resolver } from "hono-openapi"

import manifest from "../package.json" with { type: "json" }
import { authenticate, BEARER_AUTH, BEARER_SECURITY_SCHEME } from "./auth/principal"
import type { Verifier } from "./auth/verify"
import { errorHandler, notFound } from "./problem"
import { checkDatabase, DATABASE_CHECK_TIMEOUT_MS } from "./readiness"
import { agreementRoutes } from "./routes/agreements"
import { alertRoutes } from "./routes/alerts"
import { billableEventRoutes } from "./routes/billable-events"
import { billingRunRoutes } from "./routes/billing-runs"
import { catalogueRoutes } from "./routes/catalogue"
import { collectionCalendarRoutes } from "./routes/collection-calendars"
import { collectionGroupRoutes } from "./routes/collection-groups"
import { companyRoutes } from "./routes/company"
import { containerRoutes } from "./routes/containers"
import { customerRoutes } from "./routes/customers"
import { depotRoutes } from "./routes/depots"
import { driverDoorRoutes } from "./routes/driver"
import { driverRoutes } from "./routes/drivers"
import { generationRoutes } from "./routes/generation"
import { invoiceRoutes } from "./routes/invoices"
import { lifecycleRoutes } from "./routes/lifecycle"
import { providerNameFromEnv } from "@waste/routing/select"
import type { RoutingIdentity } from "@waste/routing/provider"

import { liveRoutes } from "./routes/live"
import { meRoutes } from "./routes/me"
import { pickupRoutes } from "./routes/pickups"
import { planningAreaRoutes } from "./routes/planning-areas"
import { priceListRoutes } from "./routes/price-lists"
import { productRoutes } from "./routes/products"
import { projectRoutes } from "./routes/projects"
import { propertyRoutes } from "./routes/properties"
import { propertyGroupRoutes } from "./routes/property-groups"
import { roleRoutes } from "./routes/roles"
import { routeSchemeRoutes } from "./routes/route-schemes"
import { planRoutes } from "./routes/plans"
import { routeRoutes } from "./routes/routes"
import { routingQuotaRoutes } from "./routes/routing-quota"
import { serviceAreaRoutes } from "./routes/service-areas"
import { serviceProviderPriceRoutes } from "./routes/service-provider-prices"
import { serviceProviderRoutes } from "./routes/service-providers"
import { settlementRoutes } from "./routes/settlements"
import { sharedCollectionPointRoutes } from "./routes/shared-collection-points"
import { ticketRoutes } from "./routes/tickets"
import { unloadRoutes } from "./routes/unloads"
import { unloadingStationRoutes } from "./routes/unloading-stations"
import { userRoutes } from "./routes/users"
import { vehicleAllocationRoutes } from "./routes/vehicle-allocations"
import { vehicleTypeRoutes } from "./routes/vehicle-types"
import { vehicleRoutes } from "./routes/vehicles"
import { warehouseRoutes } from "./routes/warehouses"
import { weightControlRoutes } from "./routes/weight-control"

export type AppOptions = {
  /** The pool /readyz probes, as the API role: server.ts builds it from probePoolOptions; a test hands whatever it wants probed. */
  probe: Database
  /** The request pool, as the API role: every authenticated request is one of its transactions. */
  pool: Database
  /** Verifies a bearer token against the project's keys; a test hands one over a local key set. */
  verifier: Verifier
  /** The server's clock; injected so a test can pin it. */
  now?: () => Date
  /** How long /readyz waits for the database before answering 503. */
  databaseTimeoutMs?: number
  /** Where the cause of a 500 goes; console.error unless a test wants to look. */
  log?: (error: unknown) => void
  /** The build /healthz names: server.ts reads the image's build file (build-info.ts); null from a checkout. */
  build?: BuildInfo | null
  /**
   * pg-boss's `send` for this process, which runs no pg-boss (Issue #168):
   * the generation trigger sends the worker its job through it, inside the
   * request's transaction. Built over the probe pool when absent
   * (`createJobSender`, `@waste/db/jobs`): an instance never started, whose
   * one read is the queue's row — through the probe pool and never the
   * request pool, since a request holds its own connection while it sends,
   * and a cold cache under `max` such requests would wait for a connection
   * none of them can free.
   */
  jobs?: JobSender
  /** The routing provider (#170, #131): its name keys every Plan fingerprint, and no request ever calls it (#124 §4). The fake unless ROUTING_PROVIDER says otherwise; a test injects its own. */
  routing?: RoutingIdentity
}

export function createApp({ probe, pool, verifier, now = () => new Date(), databaseTimeoutMs = DATABASE_CHECK_TIMEOUT_MS, log, build = null, jobs = createJobSender(probe), routing = { name: providerNameFromEnv() } }: AppOptions) {
  const app = new Hono()
  app.onError(errorHandler(log))
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

  // The authenticated routes, each module given the guard to put on its routes.
  const guard = authenticate({ pool, verifier })
  app.route("/", meRoutes(guard))
  app.route("/", companyRoutes(guard))
  app.route("/", projectRoutes(guard))
  app.route("/", serviceProviderRoutes(guard))
  app.route("/", userRoutes(guard))
  app.route("/", roleRoutes(guard))
  app.route("/", catalogueRoutes(guard))
  app.route("/", productRoutes(guard))
  app.route("/", customerRoutes(guard))
  app.route("/", propertyRoutes(guard))
  app.route("/", propertyGroupRoutes(guard))
  app.route("/", sharedCollectionPointRoutes(guard))
  app.route("/", agreementRoutes(guard))
  app.route("/", containerRoutes(guard, { now }))
  app.route("/", lifecycleRoutes(guard, { now }))
  app.route("/", planningAreaRoutes(guard))
  app.route("/", collectionCalendarRoutes(guard))
  // Planning's group rules judge a driver on "today" on the project's clock, so the two take the app's `now` as the ledger routes do.
  app.route("/", routeSchemeRoutes(guard, { now }))
  app.route("/", collectionGroupRoutes(guard, { now }))
  app.route("/", generationRoutes(guard, { jobs }))
  app.route("/", vehicleTypeRoutes(guard))
  app.route("/", warehouseRoutes(guard))
  app.route("/", depotRoutes(guard))
  app.route("/", unloadingStationRoutes(guard))
  app.route("/", vehicleAllocationRoutes(guard))
  app.route("/", vehicleRoutes(guard))
  app.route("/", driverRoutes(guard))
  // Execution's office (Issue #104, slice 3). The live read goes on before the
  // route module: Hono runs handlers in registration order, and `/routes/live`
  // would otherwise be caught by `/routes/:id`, whose path validator refuses
  // "live" as an id. All four take the app's `now`: "today" on a project's
  // clock, the instant a command is stamped with, and the skew an office
  // unload's `occurredAt` may run ahead of it.
  app.route("/", liveRoutes(guard, { now }))
  app.route("/", routeRoutes(guard, { now, routing, jobs }))
  // The Plan endpoints (#170) share the routes module and its grant; the provider's name keys the fingerprints.
  app.route("/", planRoutes(guard, { routing, jobs }))
  app.route("/", routingQuotaRoutes(guard, { routing }))
  app.route("/", pickupRoutes(guard, { now }))
  app.route("/", unloadRoutes(guard, { now }))
  // The driver door (Issue #104, slice 4) goes on after the office: its commands are judged against the request's clock, so it takes `now` like the ledger routes.
  app.route("/", driverDoorRoutes(guard, { now }))
  // Resolution (Issue #109): a ticket's `occurredAt` and an alert's `detectedAt` default to the request's clock and may not run ahead of it, and every command stamps and publishes with it, so both modules take `now` too.
  app.route("/", ticketRoutes(guard, { now }))
  app.route("/", alertRoutes(guard, { now }))
  // Finance & Contracting (Issue #112). The tariffs, the awards and what a provider is paid: every rule there is a period against a day the caller names, so none of the three takes the clock.
  app.route("/", priceListRoutes(guard))
  app.route("/", serviceAreaRoutes(guard))
  app.route("/", serviceProviderPriceRoutes(guard))
  // The billing half: a cancellation is stamped with the request's clock, a run and a credit note issue on "today" on the project's clock and publish with the request's instant, so all three take `now`.
  app.route("/", billableEventRoutes(guard, { now }))
  app.route("/", billingRunRoutes(guard, { now }))
  app.route("/", invoiceRoutes(guard, { now }))
  // The settlements and weight control: a settlement's `calculatedAt` and `closedAt` are the request's clock and `settlement-closed` is published with it, so the module takes `now`; weight control stamps nothing of its own (a review's `recordedAt` is the database's) and takes no clock.
  app.route("/", settlementRoutes(guard, { now }))
  app.route("/", weightControlRoutes(guard))

  app.get(
    "/openapi.json",
    openAPIRouteHandler(app, {
      documentation: {
        info: {
          title: "Waste API",
          version: manifest.version,
          description: `The only web boundary to domain data (ADR-0001). Every route but the probes and this document takes a Supabase access token as a bearer token; every error is an RFC 9457 problem. Every problem's type is \`about:blank\` but one: a 403 of type \`${NO_ACTIVE_ACCOUNT.type}\` refuses the account and not the request — the token names no company, or no active account in its company is bound to its login — and a client ends its session on it, while a 403 of \`about:blank\`, a role's grant refused, leaves the session alone. A 400 lists the fields it refused by path; every write body is strict, so a member it does not know is refused by name, and the error names the members it does accept. A create answers 201 with \`Location\`, the path of the resource's own GET, root-relative: the API is served at its origin's root and mounts under no prefix.`,
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
