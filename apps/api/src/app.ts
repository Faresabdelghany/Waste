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
import { CHANGE_REASON_HEADER } from "@waste/contracts/audit"
import { type BuildInfo, HealthResponse, PROBE_HEADERS, ReadinessResponse, ReadyResponse, UnavailableResponse } from "@waste/contracts/health"
import { NO_ACTIVE_ACCOUNT } from "@waste/contracts/problem"
import { PARAGRAPH_MAX } from "@waste/contracts/text"
import type { Database } from "@waste/db/client"
import { createJobSender, type JobSender } from "@waste/db/jobs"
import type { ProofStorage } from "@waste/db/storage"
import { Hono, type Context } from "hono"
import { describeRoute, openAPIRouteHandler, resolver } from "hono-openapi"

import manifest from "../package.json" with { type: "json" }
import { authenticate, BEARER_AUTH, BEARER_SECURITY_SCHEME, identify } from "./auth/principal"
import { Allowance, FEED_ADDRESSES_PER_CLIENT, FEED_REQUESTS_PER_ADDRESS, FeedAllowance, PUBLIC_REQUESTS_PER_MINUTE, publicDoor } from "./auth/public-door"
import type { Verifier } from "./auth/verify"
import { errorHandler, notFound } from "./problem"
import { checkDatabase, DATABASE_CHECK_TIMEOUT_MS } from "./readiness"
import { agreementRoutes } from "./routes/agreements"
import { subscriptionPauseRoutes } from "./routes/subscription-pauses"
import { alertRoutes } from "./routes/alerts"
import { auditEventRoutes } from "./routes/audit-events"
import { billableEventRoutes } from "./routes/billable-events"
import { billingRunRoutes } from "./routes/billing-runs"
import { catalogueRoutes } from "./routes/catalogue"
import { contaminantCodeRoutes } from "./routes/contaminant-codes"
import { decommissionReasonRoutes } from "./routes/decommission-reasons"
import { collectionCalendarRoutes } from "./routes/collection-calendars"
import { collectionGroupRoutes } from "./routes/collection-groups"
import { companyRoutes } from "./routes/company"
import { containerRoutes } from "./routes/containers"
import { customerContactRoutes } from "./routes/customer-contacts"
import { customerRoutes } from "./routes/customers"
import { messageTemplateRoutes } from "./routes/message-templates"
import { messageRoutes } from "./routes/messages"
import { depotRoutes } from "./routes/depots"
import { applicationRoutes } from "./routes/applications"
import { dropOffPointRoutes } from "./routes/drop-off-points"
import { emissionReportRoutes } from "./routes/emissions"
import { fuelEmissionFactorRoutes } from "./routes/fuel-emission-factors"
import { driverDoorRoutes } from "./routes/driver"
import { availabilityRoutes } from "./routes/availability"
import { preTripRoutes } from "./routes/pre-trip-checks"
import { driverRoutes } from "./routes/drivers"
import { generationRoutes } from "./routes/generation"
import { importRoutes } from "./routes/imports"
import { integrationRoutes } from "./routes/integrations"
import { invoiceRoutes } from "./routes/invoices"
import { lifecycleRoutes } from "./routes/lifecycle"
import { accessCredentialRoutes } from "./routes/access-credentials"
import { accountingRoutes } from "./routes/accounting"
import { paymentRoutes } from "./routes/payments"
import { FakeProvider } from "@waste/routing/fake"
import type { RoutingIdentity } from "@waste/routing/provider"
import { QuotaEngine, STANDARD_PLAN } from "@waste/routing/quota"
import { providerNameFromEnv } from "@waste/routing/select"

import type { AddressRegister } from "./address-register/register"
import { liveRoutes } from "./routes/live"
import { positionRoutes } from "./routes/positions"
import { meRoutes } from "./routes/me"
import { pickupRoutes } from "./routes/pickups"
import { stopMoveRoutes } from "./routes/stop-moves"
import { routeBalanceRoutes } from "./routes/route-balance"
import { planningAreaRoutes } from "./routes/planning-areas"
import { priceListRoutes } from "./routes/price-lists"
import { productRoutes } from "./routes/products"
import { projectRoutes } from "./routes/projects"
import { reportRoutes } from "./routes/reports"
import { addressLookup, addressRoutes } from "./routes/addresses"
import { propertyRoutes } from "./routes/properties"
import { propertyGroupRoutes } from "./routes/property-groups"
import { publicRoutes } from "./routes/public"
import { roleRoutes } from "./routes/roles"
import { routeSchemeRoutes } from "./routes/route-schemes"
import { schemeLifecycleRoutes } from "./routes/scheme-lifecycle"
import { serviceProviderActivityRoutes } from "./routes/service-provider-activities"
import { planRoutes } from "./routes/plans"
import { routeRoutes } from "./routes/routes"
import { proofObjectRoutes } from "./routes/proof-objects"
import { PREVIEW_CALLS_PER_MINUTE, routingPreviewRoutes } from "./routes/routing-preview"
import { routingQuotaRoutes } from "./routes/routing-quota"
import { serviceAreaRoutes } from "./routes/service-areas"
import { serviceProviderPriceRoutes } from "./routes/service-provider-prices"
import { serviceProviderRoutes } from "./routes/service-providers"
import { settlementRoutes } from "./routes/settlements"
import { sharedCollectionPointRoutes } from "./routes/shared-collection-points"
import { siteVisitRoutes } from "./routes/site-visits"
import { pickupExceptionRoutes } from "./routes/pickup-exceptions"
import { bulkyBookingRoutes } from "./routes/bulky-bookings"
import { bulkyScheduleRoutes } from "./routes/bulky-schedules"
import { sortingGuideRoutes } from "./routes/sorting-guide"
import { sustainabilityRoutes } from "./routes/sustainability"
import { ticketChargeRoutes } from "./routes/ticket-charges"
import { workOrderProductRoutes } from "./routes/work-order-charges"
import { ticketSlaRoutes } from "./routes/ticket-sla"
import { ticketTeamRoutes } from "./routes/ticket-teams"
import { ticketRoutes } from "./routes/tickets"
import { unloadRoutes } from "./routes/unloads"
import { unloadingStationRoutes } from "./routes/unloading-stations"
import { userRoutes } from "./routes/users"
import { vehicleAllocationRoutes } from "./routes/vehicle-allocations"
import { vehicleTypeRoutes } from "./routes/vehicle-types"
import { visitRuleRoutes } from "./routes/visit-rules"
import { vehicleRoutes } from "./routes/vehicles"
import { stockBalanceRoutes } from "./routes/stock-balances"
import { warehouseRoutes } from "./routes/warehouses"
import { wasteFractionEmissionFactorRoutes } from "./routes/waste-fraction-emission-factors"
import { weighbridgeRoutes } from "./routes/weighbridge"
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
  /** The routing provider (#170, #131): its name keys every Plan fingerprint, and no Plan route ever calls it (#124 §4). The fake unless ROUTING_PROVIDER says otherwise; a test injects its own. */
  routing?: RoutingIdentity
  /**
   * The provider behind the quota engine the guided setup's preview asks
   * through (#173), the one route that calls it, interactive class and never
   * waiting inside a request (`waits: false`). server.ts builds it from the
   * environment, with the key; absent, the fake with the Standard plan's
   * knobs; a test injects one over a scripted fake.
   */
  routingEngine?: QuotaEngine
  /** Each public client's requests a minute on the public door (ADR-0010); a test injects one with a small allowance or a pinned clock. */
  publicAllowance?: Allowance
  /** An address's calendar feed's own allowance, per client and address and per client across addresses; a test injects small bounds or a pinned clock. */
  feedAllowance?: FeedAllowance
  /** Each company's weighbridge batches a minute (O27 of #290); a test injects a small allowance or a pinned clock. */
  weighbridgeAllowance?: Allowance
  /** A weighbridge batch's bytes before the token is read; a test injects a small bound. */
  weighbridgeMaxBodyBytes?: number
  /** The socket's peer address, the public door's client where no trusted proxy names one: server.ts reads the Node request's; a test has none. */
  peer?: (c: Context) => string | undefined
  /** How many proxies in front of the API append to X-Forwarded-For (PUBLIC_TRUSTED_PROXIES): 0, the default, ignores the header. */
  trustedProxies?: number
  /** The address register the lookup and a property's `addressId` ask (#291 C13); null where ADDRESS_PROVIDER names none, and the lookup answers 503. server.ts builds it from the environment, with the token; a test injects the fake, scripted down where it needs the 502. */
  addressRegister?: AddressRegister | null
  /** The proofs' Storage (O1 of #290), which signs uploads and reads of photos and signatures; null where the deployment holds no service-role key, and its routes answer 503. server.ts builds it from the environment; a test injects a fake. */
  storage?: ProofStorage | null
}

export function createApp({
  probe,
  pool,
  verifier,
  now = () => new Date(),
  databaseTimeoutMs = DATABASE_CHECK_TIMEOUT_MS,
  log,
  build = null,
  jobs = createJobSender(probe),
  routing = { name: providerNameFromEnv() },
  routingEngine = new QuotaEngine(new FakeProvider(), { ...STANDARD_PLAN, callsPerMinute: PREVIEW_CALLS_PER_MINUTE, waits: false }),
  publicAllowance = new Allowance(PUBLIC_REQUESTS_PER_MINUTE, now),
  feedAllowance = new FeedAllowance(FEED_REQUESTS_PER_ADDRESS, FEED_ADDRESSES_PER_CLIENT, now),
  weighbridgeAllowance,
  weighbridgeMaxBodyBytes,
  peer = () => undefined,
  trustedProxies = 0,
  storage = null,
  addressRegister = null,
}: AppOptions) {
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
  app.route("/", auditEventRoutes(guard))
  app.route("/", catalogueRoutes(guard))
  app.route("/", wasteFractionEmissionFactorRoutes(guard))
  app.route("/", productRoutes(guard))
  app.route("/", customerRoutes(guard))
  app.route("/", customerContactRoutes(guard))
  app.route("/", messageTemplateRoutes(guard))
  app.route("/", messageRoutes(guard, { jobs }))
  // The address lookup calls the register (#291 C13), so, like the preview, its guard ends the principal's transaction; a property's write reads its `addressId` from the register before its guard opens the request's.
  const addressOptions = { register: addressRegister, log: log ?? console.error }
  app.route("/", addressRoutes(identify({ pool, verifier }), addressOptions))
  app.route("/", propertyRoutes(guard, addressLookup(identify({ pool, verifier }), addressOptions), { now }))
  app.route("/", propertyGroupRoutes(guard))
  app.route("/", sharedCollectionPointRoutes(guard))
  // A termination asks generation runs of the schemes whose planned routes stop at its containers (#291), so it takes the clock and the job sender.
  app.route("/", agreementRoutes(guard, { now, jobs }))
  // A customer's Applications and the office's Decisions (M7 of #293): a decision is stamped with the app's clock.
  app.route("/", applicationRoutes(guard, { now }))
  app.route("/", subscriptionPauseRoutes(guard, { now, jobs }))
  app.route("/", containerRoutes(guard, { now }))
  app.route("/", lifecycleRoutes(guard, { now }))
  app.route("/", planningAreaRoutes(guard, { now }))
  app.route("/", collectionCalendarRoutes(guard))
  // Planning's group rules judge a driver on "today" on the project's clock, so the two take the app's `now` as the ledger routes do.
  app.route("/", routeSchemeRoutes(guard, { now }))
  app.route("/", schemeLifecycleRoutes(guard, { now, jobs }))
  app.route("/", serviceProviderActivityRoutes(guard, { now, jobs }))
  app.route("/", collectionGroupRoutes(guard, { now }))
  app.route("/", generationRoutes(guard, { jobs }))
  app.route("/", vehicleTypeRoutes(guard))
  // The fleet's emission factors (M10 of #293), master data beside the vehicle types whose consumption they measure.
  app.route("/", fuelEmissionFactorRoutes(guard))
  app.route("/", warehouseRoutes(guard))
  app.route("/", stockBalanceRoutes(guard))
  app.route("/", depotRoutes(guard))
  app.route("/", dropOffPointRoutes(guard))
  app.route("/", unloadingStationRoutes(guard))
  app.route("/", vehicleAllocationRoutes(guard))
  app.route("/", vehicleRoutes(guard, { now }))
  app.route("/", driverRoutes(guard, { now }))
  app.route("/", availabilityRoutes(guard))
  app.route("/", preTripRoutes(guard, { now }))
  // Execution's office (Issue #104, slice 3). The live read goes on before the
  // route module: Hono runs handlers in registration order, and `/routes/live`
  // would otherwise be caught by `/routes/:id`, whose path validator refuses
  // "live" as an id. All four take the app's `now`: "today" on a project's
  // clock, the instant a command is stamped with, and the skew an office
  // unload's `occurredAt` may run ahead of it.
  app.route("/", liveRoutes(guard, { now }))
  app.route("/", positionRoutes(guard, { now }))
  app.route("/", routeRoutes(guard, { now, routing, jobs }))
  // The Plan endpoints (#170) share the routes module and its grant; the provider's name keys the fingerprints.
  app.route("/", planRoutes(guard, { routing, jobs }))
  app.route("/", routingQuotaRoutes(guard, { routing }))
  // The deployment's connections for Settings › Integrations (#487): read off what was injected, never a call to the services.
  app.route("/", integrationRoutes(guard, { routing, addressRegister, proofStorage: storage !== null }))
  // The preview calls the provider, so its guard ends the principal's transaction before the handler, which opens its own short ones around the call (#124 §4, #173).
  app.route("/", routingPreviewRoutes(identify({ pool, verifier }), { pool, engine: routingEngine, now, log: log ?? console.error }))
  app.route("/", pickupRoutes(guard, { now }))
  // Moving stops between routes, splitting and merging them (O23 of #290): commands over two routes and their stops.
  app.route("/", stopMoveRoutes(guard, { now }))
  app.route("/", routeBalanceRoutes(guard, { now, routing, jobs }))
  // Proof objects (O1 of #290) call Storage, so, like the preview, their guard ends the principal's transaction and each handler reads its fence in a short one of its own.
  app.route("/", proofObjectRoutes(identify({ pool, verifier }), { pool, storage, now, log: log ?? console.error }))
  app.route("/", unloadRoutes(guard, { now }))
  // A weighbridge's tickets (O27 of #290): the ingest bounded by its own allowance and body size, the office's queue, match and dismissal.
  app.route("/", weighbridgeRoutes(guard, { now, allowance: weighbridgeAllowance, maxBodyBytes: weighbridgeMaxBodyBytes }))
  // The driver door (Issue #104, slice 4) goes on after the office: its commands are judged against the request's clock, so it takes `now` like the ledger routes.
  app.route("/", driverDoorRoutes(guard, { now }))
  // Resolution (Issue #109): a ticket's `occurredAt` and an alert's `detectedAt` default to the request's clock and may not run ahead of it, and every command stamps and publishes with it, so both modules take `now` too.
  app.route("/", ticketRoutes(guard, { now }))
  app.route("/", sortingGuideRoutes(guard))
  app.route("/", ticketSlaRoutes(guard))
  app.route("/", ticketTeamRoutes(guard))
  // The Pickup Exceptions (M5 of #293): the company's contaminant codes, the projects' charge rules, and a place's exception history.
  app.route("/", contaminantCodeRoutes(guard))
  app.route("/", decommissionReasonRoutes(guard))
  app.route("/", pickupExceptionRoutes(guard, { now }))
  // Bulky-waste booking (O11 of #290): the areas' schedules of collection days, and the bookings that take a slot of one on the project's clock.
  app.route("/", bulkyScheduleRoutes(guard))
  app.route("/", bulkyBookingRoutes(guard, { now }))
  // Recycling-centre visits (M4 of #293): the register of plates and cards, the attendant's check-in and the ledger — a check-in's instant and a void's stamp take the app's clock — and the projects' Visit Rules.
  app.route("/", accessCredentialRoutes(guard))
  app.route("/", siteVisitRoutes(guard, { now }))
  app.route("/", visitRuleRoutes(guard))
  app.route(
    "/",
    publicRoutes(
      {
        door: publicDoor({ pool, allowance: publicAllowance, peer, trustedProxies }),
        // A feed is counted by its address too: the path's `:id`, read before it is validated, so a malformed one counts like any other.
        feedDoor: publicDoor({ pool, allowance: { take: (client, c) => feedAllowance.take(client, c.req.param("id") ?? "") }, peer, trustedProxies }),
      },
      { now },
    ),
  )
  app.route("/", alertRoutes(guard, { now }))
  // Finance & Contracting (Issue #112). The tariffs, the awards and what a provider is paid: every rule there is a period against a day the caller names, so none of the three takes the clock.
  app.route("/", priceListRoutes(guard))
  app.route("/", serviceAreaRoutes(guard))
  app.route("/", serviceProviderPriceRoutes(guard))
  // The billing half: a cancellation is stamped with the request's clock, a run and a credit note issue on "today" on the project's clock and publish with the request's instant, so all three take `now`.
  app.route("/", billableEventRoutes(guard, { now }))
  // A project's ticket charges (#291 C3): the product a completed ticket's work is charged at; nothing stamped, no clock.
  app.route("/", ticketChargeRoutes(guard))
  app.route("/", workOrderProductRoutes(guard))
  app.route("/", billingRunRoutes(guard, { now }))
  app.route("/", invoiceRoutes(guard, { now }))
  // Payments and reconciliation (#291 C6): an invoice's standing is read on its project's day, so the module takes `now`; a payment's `recordedAt` is the database's.
  app.route("/", paymentRoutes(guard, { now }))
  // The accounting export (#291 C7): a project's mapping onto the office's chart, and a period's invoices, credit notes and payments as a file.
  app.route("/", accountingRoutes(guard, { now }))
  // The settlements and weight control: a settlement's `calculatedAt` and `closedAt` are the request's clock and `settlement-closed` is published with it, so the module takes `now`; weight control stamps nothing of its own (a review's `recordedAt` is the database's) and takes no clock.
  app.route("/", settlementRoutes(guard, { now }))
  app.route("/", weightControlRoutes(guard))
  // The reports (#292): reads that count the rows above and store nothing. The ticket report reads "open now" and "overdue" at the request's clock, so the module takes `now`.
  app.route("/", reportRoutes(guard, { now }))
  // The fleet's emissions (M10 of #293): a report of its own, read like the others.
  app.route("/", emissionReportRoutes(guard))
  // A customer's sustainability report (M13 of #293), likewise.
  app.route("/", sustainabilityRoutes(guard))
  // The CSV import (#291 slice 12): a preview, then a run written a batch at a time through the families' own writes.
  app.route("/", importRoutes(guard, { now }))

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
