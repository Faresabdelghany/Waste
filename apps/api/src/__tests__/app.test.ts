import assert from "node:assert/strict"
import { after, describe, test } from "node:test"

import { Validator } from "@seriousme/openapi-schema-validator"
import { HealthResponse, ReadinessResponse } from "@waste/contracts/health"
import { createDb } from "@waste/db/client"

import manifest from "../../package.json" with { type: "json" }
import { createApp } from "../app"
import { probePoolOptions } from "../readiness"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { neverVerifies } from "./tokens"
import { REFUSED_URL } from "./unreachable"

const at = new Date("2026-09-17T13:41:00Z")
const database = databaseUnderTest()

/** A pool nothing connects to: /healthz and /openapi.json ask nothing of the database, and no route here presents a token. */
const idle = createDb(REFUSED_URL, { max: 1 })
after(() => idle.close())
const deps = { probe: idle, pool: idle, verifier: neverVerifies }
const app = createApp({ ...deps, now: () => at })

/** The parts of the document these tests read; the validator checks the whole. */
type JsonSchema = {
  type?: string
  const?: unknown
  format?: string
  required?: string[]
  properties?: Record<string, JsonSchema>
}
type Operation = {
  operationId: string
  description?: string
  security?: unknown[]
  parameters?: { name: string; in: string; required?: boolean; schema?: JsonSchema }[]
  requestBody?: { content: Record<string, { schema: JsonSchema }> }
  responses: Record<string, { description?: string; content: Record<string, { schema: JsonSchema }>; headers?: Record<string, { description?: string; schema?: JsonSchema }> }>
}
type Spec = {
  openapi: string
  info: { title: string; version: string; description?: string }
  paths: Record<string, Record<string, Operation>>
  components?: { securitySchemes?: Record<string, unknown> }
}

const spec = async () => (await (await app.request("/openapi.json")).json()) as Spec
const schemaOf = (spec: Spec, path: string, status: string) => spec.paths[path].get.responses[status].content["application/json"].schema
const spec_ = (spec: Spec) => spec.paths["/readyz"].get.description ?? ""

describe("GET /healthz", () => {
  test("answers ok with the server's clock and no build, as JSON nobody may cache", async () => {
    const response = await app.request("/healthz")
    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-type") ?? "", /^application\/json/)
    assert.equal(response.headers.get("cache-control"), "no-store")
    assert.deepEqual(HealthResponse.parse(await response.json()), { status: "ok", time: "2026-09-17T13:41:00.000Z", build: null })
  })

  test("names the build it was given, the commit a release proves live (Issue #152)", async () => {
    const commit = "21e7e2c0c8f1b4d9a3e5f6a7b8c9d0e1f2a3b4c5"
    const response = await createApp({ ...deps, now: () => at, build: { commit } }).request("/healthz")
    assert.deepEqual(HealthResponse.parse(await response.json()), { status: "ok", time: "2026-09-17T13:41:00.000Z", build: { commit } })
  })
})

describe("GET /readyz", () => {
  test("answers 200 ok when the database answers", { skip: database.skip }, async () => {
    const connected = createDb(database.url, probePoolOptions())
    try {
      const response = await createApp({ ...deps, probe: connected }).request("/readyz")
      assert.equal(response.status, 200)
      assert.match(response.headers.get("content-type") ?? "", /^application\/json/)
      assert.equal(response.headers.get("cache-control"), "no-store")
      assert.deepEqual(ReadinessResponse.parse(await response.json()), { status: "ok", checks: { database: "ok" } })
    } finally {
      await connected.close()
    }
  })

  test("answers 503 unavailable when the database is unreachable", async () => {
    const refused = createDb(REFUSED_URL, probePoolOptions())
    try {
      const response = await createApp({ ...deps, probe: refused }).request("/readyz")
      assert.equal(response.status, 503)
      assert.match(response.headers.get("content-type") ?? "", /^application\/json/)
      assert.equal(response.headers.get("cache-control"), "no-store")
      assert.deepEqual(ReadinessResponse.parse(await response.json()), { status: "unavailable", checks: { database: "unreachable" } })
    } finally {
      await refused.close()
    }
  })

  test("leaves /healthz answering while the database is down: liveness is not readiness", async () => {
    const refused = createDb(REFUSED_URL, probePoolOptions())
    try {
      const down = createApp({ ...deps, probe: refused })
      assert.equal((await down.request("/readyz")).status, 503)
      assert.equal((await down.request("/healthz")).status, 200)
    } finally {
      await refused.close()
    }
  })
})

describe("GET /openapi.json", () => {
  test("serves a valid OpenAPI 3.1 document naming the API and its version", async () => {
    const response = await app.request("/openapi.json")
    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-type") ?? "", /^application\/json/)
    const document = (await response.json()) as Spec
    assert.equal(document.openapi, "3.1.0")
    assert.equal(document.info.title, "Waste API")
    assert.equal(document.info.version, manifest.version)
    const result = await new Validator().validate(document)
    assert.equal(result.valid, true, JSON.stringify(result.errors))
  })

  test("documents every route the app answers: a route added without describeRoute fails here", async () => {
    // Hono's own route table is the truth about what the app answers. Each
    // route registers one entry per handler on it (describeRoute is a
    // middleware, so a described route appears twice), hence the set; a
    // wildcard or an `ALL` entry would be middleware and is not an operation.
    const registered = new Set<string>()
    for (const route of app.routes) {
      if (route.method === "ALL" || route.path.includes("*")) continue
      // The document is not an operation of its own document.
      if (route.path === "/openapi.json") continue
      registered.add(`${route.method.toLowerCase()} ${route.path.replace(/:([^/]+)/g, "{$1}")}`)
    }
    const document = await spec()
    const documented = new Set<string>()
    for (const [path, operations] of Object.entries(document.paths)) {
      for (const method of Object.keys(operations)) documented.add(`${method} ${path}`)
    }
    assert.deepEqual([...documented].sort(), [...registered].sort())
  })

  test("documents the probes and every route of the organisation, access, registry, planning, resources, execution, resolution and finance contexts and the driver door, and no other path", async () => {
    const document = await spec()
    assert.deepEqual(Object.keys(document.paths).sort(), [
      "/agreements",
      "/agreements/{id}",
      "/agreements/{id}/subscriptions",
      "/alerts",
      "/alerts/{id}",
      "/alerts/{id}/acknowledge",
      "/alerts/{id}/link-ticket",
      "/alerts/{id}/resolve",
      "/billable-events",
      "/billable-events/{id}",
      "/billable-events/{id}/cancel",
      "/billable-events/{id}/reprice",
      "/billing-runs",
      "/billing-runs/preview",
      "/billing-runs/{id}",
      "/collection-calendars",
      "/collection-calendars/{id}",
      "/collection-calendars/{id}/holidays",
      "/collection-groups/{id}",
      "/collection-groups/{id}/containers",
      "/collection-groups/{id}/stop-matching-rule",
      "/company",
      "/container-types",
      "/container-types/{id}",
      "/containers",
      "/containers/{id}",
      "/containers/{id}/adjust",
      "/containers/{id}/decommission",
      "/containers/{id}/movements",
      "/containers/{id}/placements",
      "/containers/{id}/receive",
      "/containers/{id}/return",
      "/containers/{id}/transfer",
      "/customers",
      "/customers/{id}",
      "/depots",
      "/depots/{id}",
      "/driver/commands",
      "/driver/me",
      "/driver/routes",
      "/driver/routes/{id}",
      "/drivers",
      "/drivers/{id}",
      "/generation-runs/{id}",
      "/healthz",
      "/invoices",
      "/invoices/{id}",
      "/invoices/{id}/credit-notes",
      "/me",
      "/pickups",
      "/pickups/{id}",
      "/pickups/{id}/correct-outcome",
      "/pickups/{id}/remove",
      "/placements",
      "/placements/{id}",
      "/planning-area-boundaries",
      "/planning-area-boundaries/{id}",
      "/planning-areas",
      "/planning-areas/{id}",
      "/planning-areas/{id}/boundaries",
      "/plans/{id}",
      "/price-list-rows/{id}",
      "/price-lists",
      "/price-lists/{id}",
      "/price-lists/{id}/resolve",
      "/price-lists/{id}/rows",
      "/products",
      "/products/{id}",
      "/projects",
      "/projects/{id}",
      "/properties",
      "/properties/{id}",
      "/properties/{id}/parties",
      "/property-groups",
      "/property-groups/{id}",
      "/property-groups/{id}/members",
      "/readyz",
      "/roles",
      "/roles/{id}",
      "/roles/{id}/grants",
      "/route-schemes",
      "/route-schemes/{id}",
      "/route-schemes/{id}/collection-groups",
      "/route-schemes/{id}/generate",
      "/route-schemes/{id}/generation-runs",
      "/route-schemes/{id}/occurrences",
      "/routes",
      "/routes/live",
      "/routes/{id}",
      "/routes/{id}/assign",
      "/routes/{id}/cancel",
      "/routes/{id}/commands",
      "/routes/{id}/dispatch",
      "/routes/{id}/optimise",
      "/routes/{id}/pickup-order",
      "/routes/{id}/plans",
      "/routes/{id}/reschedule",
      "/routes/{id}/unloads",
      "/routing/preview",
      "/routing/quota",
      "/service-area-assignments",
      "/service-area-assignments/{id}",
      "/service-areas",
      "/service-areas/{id}",
      "/service-areas/{id}/assignments",
      "/service-areas/{id}/planning-areas",
      "/service-areas/{id}/waste-fractions",
      "/service-frequencies",
      "/service-frequencies/{id}",
      "/service-provider-prices",
      "/service-provider-prices/{id}",
      "/service-provider-prices/{id}/index",
      "/service-providers",
      "/service-providers/{id}",
      "/sessions",
      "/sessions/{id}",
      "/settlements",
      "/settlements/{id}",
      "/settlements/{id}/calculate",
      "/settlements/{id}/close",
      "/settlements/{id}/events",
      "/settlements/{id}/reopen",
      "/shared-collection-points",
      "/shared-collection-points/{id}",
      "/shared-collection-points/{id}/members",
      "/stock-movements",
      "/subscriptions",
      "/subscriptions/{id}",
      "/tickets",
      "/tickets/{id}",
      "/tickets/{id}/assign",
      "/tickets/{id}/comments",
      "/tickets/{id}/complete",
      "/tickets/{id}/events",
      "/tickets/{id}/hold",
      "/tickets/{id}/reject",
      "/tickets/{id}/reopen",
      "/tickets/{id}/start",
      "/tickets/{id}/wait",
      "/unloading-stations",
      "/unloading-stations/{id}",
      "/unloading-stations/{id}/fractions",
      "/unloads",
      "/unloads/{id}",
      "/unloads/{id}/approve",
      "/unloads/{id}/correct",
      "/unloads/{id}/reject",
      "/unloads/{id}/reviews",
      "/users",
      "/users/{id}",
      "/users/{id}/deactivate",
      "/users/{id}/make-primary-administrator",
      "/users/{id}/reactivate",
      "/vehicle-allocations",
      "/vehicle-allocations/{id}",
      "/vehicle-allocations/{id}/change",
      "/vehicle-allocations/{id}/confirm",
      "/vehicle-allocations/{id}/events",
      "/vehicle-allocations/{id}/release",
      "/vehicle-types",
      "/vehicle-types/{id}",
      "/vehicle-types/{id}/container-types",
      "/vehicles",
      "/vehicles/{id}",
      "/vehicles/{id}/compartments",
      "/warehouses",
      "/warehouses/{id}",
      "/waste-fractions",
      "/waste-fractions/{id}",
    ])
    assert.equal(document.paths["/healthz"].get.operationId, "getHealth")
    const health = schemaOf(document, "/healthz", "200")
    assert.deepEqual(health.required, ["status", "time", "build"])
    assert.deepEqual(health.properties?.status, { type: "string", const: "ok" })
    assert.equal(health.properties?.time.format, "date-time")
  })

  test("documents /readyz with one body per outcome: 200 ready, 503 unavailable, each naming its check", async () => {
    const document = await spec()
    const operation = document.paths["/readyz"].get
    assert.equal(operation.operationId, "getReadiness")
    assert.deepEqual(Object.keys(operation.responses), ["200", "503"])
    const ready = schemaOf(document, "/readyz", "200")
    assert.deepEqual(ready.required, ["status", "checks"])
    assert.deepEqual(ready.properties?.status, { type: "string", const: "ok" })
    assert.deepEqual(ready.properties?.checks.properties?.database, { type: "string", const: "ok" })
    const unavailable = schemaOf(document, "/readyz", "503")
    assert.deepEqual(unavailable.required, ["status", "checks"])
    assert.deepEqual(unavailable.properties?.status, { type: "string", const: "unavailable" })
    assert.deepEqual(unavailable.properties?.checks.properties?.database, { type: "string", const: "unreachable" })
  })

  test("states the bound in force in /readyz's description, whatever it was set to", async () => {
    assert.match(spec_(await spec()), /within 2000 ms/)
    const shorter = createApp({ ...deps, databaseTimeoutMs: 500 })
    const document = (await (await shorter.request("/openapi.json")).json()) as Spec
    assert.match(spec_(document), /within 500 ms/)
  })

  test("declares the bearer token as its one security scheme", async () => {
    const document = await spec()
    assert.deepEqual(document.components?.securitySchemes, { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } })
  })

  test("names the account's problem type where a client learns what ends its session: the document's description and /me's 403 (Issue #150)", async () => {
    const document = await spec()
    assert.match(document.info.description ?? "", /`urn:waste:problem:no-active-account`/)
    assert.match(document.paths["/me"].get.responses["403"].description ?? "", /`urn:waste:problem:no-active-account`/)
  })

  test("requires the bearer token on every operation but the two probes and the document itself", async () => {
    const document = await spec()
    const open = new Set(["/healthz", "/readyz", "/openapi.json"])
    let secured = 0
    for (const [path, operations] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        if (open.has(path)) {
          assert.equal(operation.security, undefined, `${method.toUpperCase()} ${path} needs no token`)
        } else {
          assert.deepEqual(operation.security, [{ bearerAuth: [] }], `${method.toUpperCase()} ${path} must declare bearerAuth`)
          secured += 1
        }
      }
    }
    assert.equal(
      secured,
      239,
      "/me, the ten organisation routes, the twelve access routes, the fifty-two registry routes — waste fractions, container types, service frequencies, products and customers, four each; properties, property groups and shared collection points, five each, the four plus the route that replaces the set travelling with the record; and the two effective-dated families, agreements with their subscriptions, nine with the subscriptions listed across agreements (Issue #183), and containers with their placements, eight —the twenty-five planning routes of part A: planning areas with their boundary versions, nine, collection calendars with their holidays, five, route schemes with the occurrence read, five, and collection groups with their two set replacements, six — and the three of part B, the generate command and the two run reads — and the eighteen resources routes of slice 3: vehicle types with their container types, five, warehouses and depots, four each, and unloading stations with their fractions, five — and the seven of the container ledger (Issue #101, slice 5): the five commands receive, return, transfer, decommission and adjust, one container's movements, and the ledger across containers — and Resources' seven vehicle allocation routes (#101, slice 6): the list, the allocate command, the read, the three commands change, confirm and release, and the history — and the nine fleet routes of Resources' slice 4: vehicles with the compartments set, five, and drivers, four — and the eighteen office routes of Execution's slice 3 (Issue #104): routes, eight (the list, the read, assign, dispatch, reschedule, cancel, the pickup order and the command log), pickups, four (the list, the read, remove and correct-outcome), live, three (the live read, the sessions list and one session), and weights, three (the unloads list, one unload and the office's capture on a route) — and the five of the driver door (Issue #104, slice 4): the driver's start screen, their routes, one route, the command batch and the receipts — and Resolution's nineteen (Issue #109): the thirteen ticket routes, the list and the create, the read and the patch, the seven commands assign, start, wait, hold, complete, reject and reopen, the history and the comment, and the six alert routes, the list, the raise, the read, and the three commands acknowledge, resolve and link-ticket — and Finance's forty-eight (Issue #112): price lists, nine (the list, the create, the read and the patch, a list's rows and the row added under it, one row and its patch, and the resolve read), service areas, eleven (the list, the create, the read and the patch, the two set replacements, an area's assignments and the assignment added under it, the assignments across the caller's reach, one assignment and its patch), and service provider prices, five (the list, the create, the read, the patch and the index command, which writes the next row of the chain), billable events, five (the list, the manual create, the read, and the two commands reprice and cancel), billing runs, four (the list, the run, the preview and the read), and invoices, three (the list, the read and the credit note), settlements, seven (the list, the create, the read, the three commands calculate, close and reopen, and the history), and weight control's four (the three decisions approve, reject and correct on an unload, and its reviews) — and Routing's five (#170, #171, #173): a route's Plans, one Plan with its legs, the optimise command, the quota read, and the guided setup's preview",
    )
  })

  test("declares the Location header on every 201 and Location on nothing else: a create says where the row is now read, a command or a set replacement does not", async () => {
    const document = await spec()
    // The ledger's five commands (Issue #101) answer 201 as well — a Stock
    // Movement is appended — and declare no Location: a movement is read on
    // its container's ledger (`GET /containers/{id}/movements`) and on the
    // ledger across containers, never at an address of its own, so there is
    // nothing for the header to name. They were the one exception, counted;
    // a ticket's comment (Issue #109, §7.22) joined them: a history row is
    // read on `GET /tickets/{id}/events`, a list, and has no address of its
    // own either. Weight control's three decisions (Issue #112, §5) are the
    // same: a review is read on `GET /unloads/{id}/reviews`.
    const ledgerCommands = new Set(["receive", "return", "transfer", "decommission", "adjust"].map((verb) => `POST /containers/{id}/${verb}`))
    const reviewCommands = new Set(["approve", "reject", "correct"].map((verb) => `POST /unloads/{id}/${verb}`))
    const appendsWithoutAddress = new Set([...ledgerCommands, "POST /tickets/{id}/comments", ...reviewCommands])
    let creates = 0
    let appends = 0
    for (const [path, operations] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        for (const [status, response] of Object.entries(operation.responses)) {
          const location = response.headers?.Location
          const where = `${method.toUpperCase()} ${path} ${status}`
          if (status === "201" && appendsWithoutAddress.has(`${method.toUpperCase()} ${path}`)) {
            appends += 1
            assert.equal(location, undefined, `${where}: an appended row has no address of its own to name`)
          } else if (status === "201") {
            creates += 1
            assert.equal(method, "post", `${where}: only a POST creates`)
            assert.equal(location?.schema?.type, "string", `${where} must declare Location`)
            assert.match(location?.description ?? "", /\S/, `${where}: Location says what it names`)
          } else {
            // Only Location is this test's: a 401 will one day declare
            // WWW-Authenticate, which the API already sends (RFC 6750).
            assert.equal(location, undefined, `${where} declares no Location`)
          }
        }
      }
    }
    assert.equal(appends, 9, "the ledger's five commands: receive, return, transfer, decommission and adjust — a ticket's comment — and weight control's three decisions, approve, reject and correct")
    assert.equal(
      creates,
      41,
      "the forty-one creates: projects, service providers, users and roles; waste fractions, container types, service frequencies, products, customers, properties, property groups, shared collection points, agreements and containers; the two nested ones, a subscription under its agreement and a placement under its container; and Planning's five — planning areas and, under an area, boundary versions, collection calendars, route schemes and, under a scheme, collection groups; and Resources' seven (Issue #101) — vehicle types, warehouses, depots, unloading stations, vehicles, drivers and vehicle allocations; and Execution's one (Issue #104, slice 3) — the office's unload capture under its route, read at `/unloads/{id}`; and Resolution's two (Issue #109) — the ticket and the alert; and Finance's ten (Issue #112) — a price list and, under a list, a row read at `/price-list-rows/{id}`, a service area and, under an area, an assignment read at `/service-area-assignments/{id}`, a service provider price, and the index command on one, which makes the next row of the chain and so answers 201 with its address; the manual billable event, the billing run, and the credit note under its invoice, read at `/invoices/{id}`; and the settlement",
    )
  })

  test("documents each alert route with its verbs, its problems and the rules a client must know (Issue #109)", async () => {
    const document = await spec()
    const operations = (path: string) =>
      Object.fromEntries(Object.entries(document.paths[path]).map(([method, operation]) => [method, operation.operationId]))

    assert.deepEqual(operations("/alerts"), { get: "listAlerts", post: "raiseAlert" })
    assert.deepEqual(operations("/alerts/{id}"), { get: "getAlert" })
    assert.deepEqual(operations("/alerts/{id}/acknowledge"), { post: "acknowledgeAlert" })
    assert.deepEqual(operations("/alerts/{id}/resolve"), { post: "resolveAlert" })
    assert.deepEqual(operations("/alerts/{id}/link-ticket"), { post: "linkAlertTicket" })

    // The raise collides with nothing (no key, no period), so it has no 409; a resolved alert refuses acknowledge and the link, and resolve is idempotent and refuses nothing but a bad body.
    assert.deepEqual(Object.keys(document.paths["/alerts"].get.responses), ["200", "400", "401", "403"])
    assert.deepEqual(Object.keys(document.paths["/alerts"].post.responses), ["201", "400", "401", "403"])
    assert.deepEqual(Object.keys(document.paths["/alerts/{id}"].get.responses), ["200", "400", "401", "403", "404"])
    assert.deepEqual(Object.keys(document.paths["/alerts/{id}/acknowledge"].post.responses), ["200", "400", "401", "403", "404", "409"])
    assert.deepEqual(Object.keys(document.paths["/alerts/{id}/resolve"].post.responses), ["200", "400", "401", "403", "404"])
    assert.deepEqual(Object.keys(document.paths["/alerts/{id}/link-ticket"].post.responses), ["200", "400", "401", "403", "404", "409"])
    for (const [status, operation] of Object.entries(document.paths["/alerts/{id}/link-ticket"].post.responses)) {
      assert.deepEqual(Object.keys(operation.content), [status === "200" ? "application/json" : "application/problem+json"], `link-ticket ${status}`)
    }

    // The list is project-scoped and takes the board's filters beside the page.
    const byName = (operation: Operation) => (operation.parameters ?? []).map((parameter) => `${parameter.in}:${parameter.name}`)
    assert.deepEqual(byName(document.paths["/alerts"].get).sort(), [
      "query:containerId",
      "query:cursor",
      "query:driverId",
      "query:kind",
      "query:limit",
      "query:projectId",
      "query:routeId",
      "query:severity",
      "query:status",
      "query:ticketId",
      "query:vehicleId",
    ])
    assert.deepEqual(byName(document.paths["/alerts/{id}/acknowledge"].post), ["path:id"])

    // The rules a client must know are in the prose, not only in the code.
    assert.match(document.paths["/alerts"].get.description ?? "", /an account that works in none[^.]*reads an empty page/)
    assert.match(document.paths["/alerts"].get.description ?? "", /`ticketId` not null and no status/)
    const raise = document.paths["/alerts"].post.description ?? ""
    assert.match(raise, /`source` is `manual`, `status` is `new`, `raisedBy` is the caller's account/)
    assert.match(raise, /at least one of `routeId`, `vehicleId`, `driverId` and `containerId` \(400 at `routeId` otherwise/)
    assert.match(raise, /the vehicle one of its vehicles of any kind, a trailer included/)
    assert.match(raise, /There is no status gate on any of them/)
    assert.match(raise, /at most five minutes ahead of the request's clock \(400, `Recorded after it happened`\) and has no lower bound/)
    assert.match(raise, /Nothing here writes the outbox/)
    assert.match(document.paths["/alerts/{id}/acknowledge"].post.description ?? "", /already acknowledged answers 200 as it stands, without a write; a resolved one is refused \(409, `This alert is resolved and does not change`\)/)
    assert.match(document.paths["/alerts/{id}/resolve"].post.description ?? "", /resolved without being acknowledged first/)
    assert.match(document.paths["/alerts/{id}/resolve"].post.description ?? "", /already resolved answers 200 as it stands, without a write/)
    const link = document.paths["/alerts/{id}/link-ticket"].post.description ?? ""
    assert.match(link, /the same ticket again answers 200 as it stands, without a write/)
    assert.match(link, /\(409, `This alert is linked to ticket T-8831; an alert links to one ticket`/)
    assert.match(link, /a resolved alert is refused \(409, `This alert is resolved and does not change`\)/)
    assert.match(link, /The same rule `POST \/tickets` runs/)

    // A write takes the strict body the contracts spell; the acknowledge's is empty.
    const required = (path: string) => document.paths[path].post.requestBody?.content["application/json"].schema.required
    assert.deepEqual(required("/alerts"), ["projectId", "title", "details", "kind", "severity"])
    assert.equal(required("/alerts/{id}/acknowledge"), undefined)
    assert.equal(required("/alerts/{id}/resolve"), undefined)
    assert.deepEqual(required("/alerts/{id}/link-ticket"), ["ticketId"])

    const page = document.paths["/alerts"].get.responses["200"].content["application/json"].schema
    assert.deepEqual(page.required, ["items", "nextCursor"])
    assert.equal(page.properties?.items.type, "array")
  })

  test("documents each ticket route with its verbs, its problems and the rules a client must know (Issue #109)", async () => {
    const document = await spec()
    const operations = (path: string) =>
      Object.fromEntries(Object.entries(document.paths[path]).map(([method, operation]) => [method, operation.operationId]))

    assert.deepEqual(operations("/tickets"), { get: "listTickets", post: "createTicket" })
    assert.deepEqual(operations("/tickets/{id}"), { get: "getTicket", patch: "patchTicket" })
    assert.deepEqual(operations("/tickets/{id}/assign"), { post: "assignTicket" })
    assert.deepEqual(operations("/tickets/{id}/start"), { post: "startTicket" })
    assert.deepEqual(operations("/tickets/{id}/wait"), { post: "waitTicket" })
    assert.deepEqual(operations("/tickets/{id}/hold"), { post: "holdTicket" })
    assert.deepEqual(operations("/tickets/{id}/complete"), { post: "completeTicket" })
    assert.deepEqual(operations("/tickets/{id}/reject"), { post: "rejectTicket" })
    assert.deepEqual(operations("/tickets/{id}/reopen"), { post: "reopenTicket" })
    assert.deepEqual(operations("/tickets/{id}/events"), { get: "listTicketEvents" })
    assert.deepEqual(operations("/tickets/{id}/comments"), { post: "commentTicket" })

    // The create's 409 is the alert's (resolved, or linked to another ticket); the patch and six of the commands refuse a closed ticket; reopen is the one command a closed ticket takes and has no 409; the reads, the history and the comment collide with nothing.
    const responses = (path: string, method: "get" | "post" | "patch") => Object.keys(document.paths[path][method].responses)
    assert.deepEqual(responses("/tickets", "get"), ["200", "400", "401", "403"])
    assert.deepEqual(responses("/tickets", "post"), ["201", "400", "401", "403", "409"])
    assert.deepEqual(responses("/tickets/{id}", "get"), ["200", "400", "401", "403", "404"])
    assert.deepEqual(responses("/tickets/{id}", "patch"), ["200", "400", "401", "403", "404", "409"])
    const refuseClosed = ["assign", "start", "wait", "hold", "complete", "reject"]
    for (const command of refuseClosed) assert.deepEqual(responses(`/tickets/{id}/${command}`, "post"), ["200", "400", "401", "403", "404", "409"], command)
    assert.deepEqual(responses("/tickets/{id}/reopen", "post"), ["200", "400", "401", "403", "404"], "reopen has no 409: a closed ticket is what it takes, and an open one answers 200 as it stands")
    assert.deepEqual(responses("/tickets/{id}/events", "get"), ["200", "400", "401", "403", "404"])
    assert.deepEqual(responses("/tickets/{id}/comments", "post"), ["201", "400", "401", "403", "404"])
    for (const [status, operation] of Object.entries(document.paths["/tickets/{id}/complete"].post.responses)) {
      assert.deepEqual(Object.keys(operation.content), [status === "200" ? "application/json" : "application/problem+json"], `complete ${status}`)
    }

    // The list is project-scoped and takes the board's and the portal's filters beside the page; the history takes its two.
    const byName = (operation: Operation) => (operation.parameters ?? []).map((parameter) => `${parameter.in}:${parameter.name}`)
    assert.deepEqual(byName(document.paths["/tickets"].get).sort(), [
      "query:assigneeUserAccountId",
      "query:containerId",
      "query:cursor",
      "query:customerId",
      "query:driverId",
      "query:from",
      "query:kind",
      "query:limit",
      "query:open",
      "query:pickupId",
      "query:priority",
      "query:projectId",
      "query:propertyId",
      "query:routeId",
      "query:source",
      "query:status",
      "query:to",
    ])
    assert.deepEqual(byName(document.paths["/tickets/{id}/events"].get).sort(), ["path:id", "query:cursor", "query:kind", "query:limit", "query:visibility"])
    assert.deepEqual(byName(document.paths["/tickets/{id}/start"].post), ["path:id"])

    // A write takes the strict body the contracts spell: what must be given, and nothing the server owns.
    const required = (path: string, method: "post" | "patch" = "post") => document.paths[path][method].requestBody?.content["application/json"].schema.required
    assert.deepEqual(required("/tickets"), ["projectId", "subject", "description", "kind"], "priority and source have defaults")
    assert.equal(required("/tickets/{id}", "patch"), undefined, "a patch names no member as required: at least one is a rule, not a member")
    assert.deepEqual(required("/tickets/{id}/assign"), ["assigneeUserAccountId"])
    assert.equal(required("/tickets/{id}/start"), undefined)
    assert.deepEqual(required("/tickets/{id}/wait"), ["note"])
    assert.deepEqual(required("/tickets/{id}/hold"), ["note"])
    assert.deepEqual(required("/tickets/{id}/complete"), ["resolution", "note"])
    assert.deepEqual(required("/tickets/{id}/reject"), ["reason"])
    assert.deepEqual(required("/tickets/{id}/reopen"), ["note"])
    assert.deepEqual(required("/tickets/{id}/comments"), ["body"])

    // The two 201s: the create names where the ticket is now read, the comment names nothing, like the ledger's commands.
    assert.equal(document.paths["/tickets"].post.responses["201"].headers?.Location?.schema?.type, "string")
    assert.equal(document.paths["/tickets/{id}/comments"].post.responses["201"].headers, undefined)

    // The rules a client must know are in the prose, not only in the code.
    const list = document.paths["/tickets"].get.description ?? ""
    assert.match(list, /an account that works in none[^.]*reads an empty page/)
    assert.match(list, /both ends inclusive, on the UTC calendar day, so `to=2026-10-05` takes the whole of the 5th/)
    assert.match(list, /`customerId` is the citizen portal's read model/)
    const create = document.paths["/tickets"].post.description ?? ""
    assert.match(create, /`T-<n>`, never renumbered/)
    assert.match(create, /a pickup is named with its route, 400 at `links\.pickupId`/)
    assert.match(create, /no status gates a link/)
    assert.match(create, /at most five minutes ahead of it \(400\) — with no lower bound/)
    assert.match(create, /not resolved \(409, `This alert is resolved and does not change`\) and not linked to another ticket \(409, `This alert is linked to ticket T-8831; an alert links to one ticket`\)/)
    assert.match(create, /The `ticket-opened` event is written in the same transaction/)
    const closed = /A completed or rejected ticket is refused \(409, `Ticket T-8831 is completed; reopen it first`\)/
    for (const operation of [document.paths["/tickets/{id}"].patch, ...refuseClosed.map((command) => document.paths[`/tickets/{id}/${command}`].post)]) {
      assert.match(operation.description ?? "", closed, `${operation.operationId} states the closed ticket's sentence`)
    }
    const reopen = document.paths["/tickets/{id}/reopen"].post.description ?? ""
    assert.doesNotMatch(reopen, closed, "reopen is what a closed ticket takes")
    assert.match(reopen, /`completed` or `rejected` becomes `open`/)
    assert.match(reopen, /open in any of the four open statuses answers 200 as it stands, without a write or an event/)
    const patch = document.paths["/tickets/{id}"].patch.description ?? ""
    assert.match(patch, /a body clearing the route under a pickup is refused at `links\.pickupId`/)
    assert.match(patch, /no history row is appended/)
    assert.match(document.paths["/tickets/{id}/assign"].post.description ?? "", /The account already assigned answers 200 as the ticket stands, without a write or an event/)
    const complete = document.paths["/tickets/{id}/complete"].post.description ?? ""
    assert.match(complete, /With `recollected`, and only then \(400 at `recollectionRouteId` otherwise\)/)
    assert.match(complete, /\(409, `Route RC-1042 is completed; a re-collection rides on a route that has not ended`\)/)
    assert.match(complete, /Not idempotent: a second completion is a change a person meant/)
    assert.match(document.paths["/tickets/{id}/reject"].post.description ?? "", /Not idempotent: a second rejection is a change a person meant/)
    assert.match(document.paths["/tickets/{id}/events"].get.description ?? "", /`visibility=customer` is the thread the portal reads, and leaves every internal row out/)
    const comment = document.paths["/tickets/{id}/comments"].post.description ?? ""
    assert.match(comment, /`<companyId>\/<ticketId>\/<objectId>\.<jpg\|jpeg\|png\|webp\|pdf>` in the bucket `ticket-attachments`/)
    assert.match(comment, /400 at `objectKey`, `The attachment key names another company or another ticket`/)
    assert.match(comment, /Taken on a closed ticket too/)
    assert.match(comment, /read under the ticket's row lock/)
    assert.match(comment, /Answers 201 with the event and no `Location`, like the ledger's commands/)

    for (const path of ["/tickets", "/tickets/{id}/events"]) {
      const page = document.paths[path].get.responses["200"].content["application/json"].schema
      assert.deepEqual(page.required, ["items", "nextCursor"], path)
      assert.equal(page.properties?.items.type, "array", path)
    }
  })

  test("documents the driver door with its verbs, its problems and the rules a device must know (Issue #104, slice 4)", async () => {
    const document = await spec()
    const operations = (path: string) =>
      Object.fromEntries(Object.entries(document.paths[path]).map(([method, operation]) => [method, operation.operationId]))

    assert.deepEqual(operations("/driver/me"), { get: "getDriverMe" })
    assert.deepEqual(operations("/driver/routes"), { get: "listDriverRoutes" })
    assert.deepEqual(operations("/driver/routes/{id}"), { get: "getDriverRoute" })
    assert.deepEqual(operations("/driver/commands"), { get: "listDriverCommands", post: "applyDriverCommands" })

    // The door answers 200 whenever the envelopes parse: a rejection is a per-command outcome, never the batch's status.
    assert.deepEqual(Object.keys(document.paths["/driver/commands"].post.responses), ["200", "400", "401", "403"])
    assert.deepEqual(Object.keys(document.paths["/driver/me"].get.responses), ["200", "401", "403"])
    assert.deepEqual(Object.keys(document.paths["/driver/routes"].get.responses), ["200", "400", "401", "403"])
    assert.deepEqual(Object.keys(document.paths["/driver/routes/{id}"].get.responses), ["200", "400", "401", "403", "404"])
    assert.deepEqual(Object.keys(document.paths["/driver/commands"].get.responses), ["200", "400", "401", "403"])
    for (const [status, operation] of Object.entries(document.paths["/driver/commands"].post.responses)) {
      assert.deepEqual(Object.keys(operation.content), [status === "200" ? "application/json" : "application/problem+json"], `POST /driver/commands ${status}`)
    }

    const byName = (operation: Operation) => (operation.parameters ?? []).map((parameter) => `${parameter.in}:${parameter.name}`)
    assert.deepEqual(byName(document.paths["/driver/routes"].get).sort(), ["query:cursor", "query:limit", "query:status"])
    assert.deepEqual(byName(document.paths["/driver/commands"].get).sort(), ["query:cursor", "query:limit", "query:routeId"])
    assert.deepEqual(byName(document.paths["/driver/routes/{id}"].get), ["path:id"])

    // The batch is the strict body the contracts spell, and the outcome one row per command.
    const batch = document.paths["/driver/commands"].post.requestBody?.content["application/json"].schema
    assert.deepEqual(batch?.required, ["commands"])
    assert.equal(batch?.properties?.commands.type, "array")
    const outcome = document.paths["/driver/commands"].post.responses["200"].content["application/json"].schema
    assert.deepEqual(outcome.required, ["outcomes"])
    assert.equal(outcome.properties?.outcomes.type, "array")

    // The rules a device must know are in the prose, not only in the code: the fence, the replay, the clock, the sentences.
    assert.match(document.paths["/driver/me"].get.description ?? "", /the assignment, never Project Access/)
    assert.match(document.paths["/driver/routes"].get.description ?? "", /never by Project Access/)
    assert.match(document.paths["/driver/routes/{id}"].get.description ?? "", /No route <id> assigned to this driver/)
    // The driver's route read is the joined one: the places travel with the pickups.
    assert.match(document.paths["/driver/routes/{id}"].get.description ?? "", /each with its place joined — the `address` and `location`/)
    assert.match(document.paths["/driver/routes/{id}"].get.description ?? "", /the container's `label` and the waste fraction's `name`/)
    const door = document.paths["/driver/commands"].post.description ?? ""
    assert.match(door, /applied in body order, each in its own savepoint/)
    assert.match(door, /`replayed` with the first outcome for an id this driver's devices already sent \(nothing written/)
    assert.match(door, /An id that another device's command already holds .* is refused \(409, `That command id belongs to another device's command`\) and never replayed/)
    assert.match(door, /two of the driver's routes started at once, each batch under its own route's lock, meet on the one-live-session-per-driver index/)
    assert.match(door, /a route-level `report-problem`'s `pickup-problem-reported` the route with its problem proof as `proofs`/)
    assert.match(door, /assigned to another driver names that route — which `GET \/driver\/routes\/:id` still answers 404 for — and no session and no pickup/)
    assert.match(door, /A body that fails its kind's schema is one command's rejection, never the batch's/)
    assert.match(door, /at most five minutes ahead of the request's clock \(400, `Recorded after it happened`\)/)
    assert.match(door, /at most forty-eight hours behind it \(400, `Recorded more than 48 hours after it happened`\)/)
    assert.match(door, /Route RC-1042 is not dispatched; a driver starts a ready route/)
    assert.match(door, /Mads Jensen is already on route RC-1039; end it first/)
    assert.match(door, /Pickup 12 is already completed/)
    assert.match(door, /The object key names another route or another command/)
    assert.match(door, /a rejection for a route of another project, another company or none is recorded without a route, in the driver's project, the claimed route id kept beside the body/)
    // The receipts page states the receipt's `routeId` rule the same way: named for a route of the driver's project, another driver's included, null otherwise.
    const receipts = document.paths["/driver/commands"].get.description ?? ""
    assert.match(receipts, /oldest first/)
    assert.match(receipts, /`routeId` names the route the command claimed when that route is of this driver's project — one assigned to another driver included, which `GET \/driver\/routes\/:id` still answers 404 for, so a receipt may name a route the device cannot read/)
    assert.match(receipts, /is null for a route of another project, another company or none, the claimed id then kept in the body as `\{ routeId, body \}`/)

    for (const path of ["/driver/routes", "/driver/commands"]) {
      const page = document.paths[path].get.responses["200"].content["application/json"].schema
      assert.deepEqual(page.required, ["items", "nextCursor"], path)
      assert.equal(page.properties?.items.type, "array", path)
    }
  })

  test("documents each organisation route with its verbs, its problems and its page of items", async () => {
    const document = await spec()
    const operations = (path: string) =>
      Object.fromEntries(Object.entries(document.paths[path]).map(([method, operation]) => [method, operation.operationId]))

    assert.deepEqual(operations("/company"), { get: "getCompany", patch: "patchCompany" })
    assert.deepEqual(operations("/projects"), { get: "listProjects", post: "createProject" })
    assert.deepEqual(operations("/projects/{id}"), { get: "getProject", patch: "patchProject" })
    assert.deepEqual(operations("/service-providers"), { get: "listServiceProviders", post: "createServiceProvider" })
    assert.deepEqual(operations("/service-providers/{id}"), { get: "getServiceProvider", patch: "patchServiceProvider" })

    // What a caller can earn on each of them, and in what shape.
    // Both company handlers can answer 404 (the row the token was resolved
    // against, gone between that join and the statement), so both describe it.
    assert.deepEqual(Object.keys(document.paths["/company"].get.responses), ["200", "401", "403", "404"])
    assert.deepEqual(Object.keys(document.paths["/company"].patch.responses), ["200", "400", "401", "403", "404", "409"])
    assert.deepEqual(Object.keys(document.paths["/projects"].post.responses), ["201", "400", "401", "403", "409"])
    assert.deepEqual(Object.keys(document.paths["/projects/{id}"].patch.responses), ["200", "400", "401", "403", "404", "409"])
    for (const [path, method] of [["/projects/{id}", "patch"], ["/service-providers/{id}", "get"]] as const) {
      for (const [status, operation] of Object.entries(document.paths[path][method].responses)) {
        const media = Object.keys(operation.content)
        assert.deepEqual(media, [status === "200" ? "application/json" : "application/problem+json"], `${method} ${path} ${status}`)
      }
    }

    const page = document.paths["/projects"].get.responses["200"].content["application/json"].schema
    assert.deepEqual(page.required, ["items", "nextCursor"])
    assert.equal(page.properties?.items.type, "array")

    // The path id and the page's query, as parameters a client can read.
    const byName = (operation: Operation) => (operation.parameters ?? []).map((parameter) => `${parameter.in}:${parameter.name}`)
    assert.deepEqual(byName(document.paths["/projects/{id}"].get), ["path:id"])
    assert.deepEqual(byName(document.paths["/projects"].get).sort(), ["query:cursor", "query:limit"])

    // A write takes a JSON body, and it is the strict one the contracts spell.
    const body = document.paths["/projects"].post.requestBody?.content["application/json"].schema
    assert.deepEqual(body?.required, ["name", "kind", "language", "currency", "timezone"])
  })

  test("documents each access route with its verbs, its problems and its page of items", async () => {
    const document = await spec()
    const operations = (path: string) =>
      Object.fromEntries(Object.entries(document.paths[path]).map(([method, operation]) => [method, operation.operationId]))

    assert.deepEqual(operations("/users"), { get: "listUsers", post: "inviteUser" })
    assert.deepEqual(operations("/users/{id}"), { get: "getUser", patch: "patchUser" })
    assert.deepEqual(operations("/users/{id}/deactivate"), { post: "deactivateUser" })
    assert.deepEqual(operations("/users/{id}/reactivate"), { post: "reactivateUser" })
    assert.deepEqual(operations("/users/{id}/make-primary-administrator"), { post: "makePrimaryAdministrator" })
    assert.deepEqual(operations("/roles"), { get: "listRoles", post: "createRole" })
    assert.deepEqual(operations("/roles/{id}"), { get: "getRole", patch: "patchRole" })
    assert.deepEqual(operations("/roles/{id}/grants"), { put: "putRoleGrants" })

    // What a caller can earn on each of them, and in what shape.
    assert.deepEqual(Object.keys(document.paths["/users"].get.responses), ["200", "400", "401", "403"])
    assert.deepEqual(Object.keys(document.paths["/users"].post.responses), ["201", "400", "401", "403", "409"])
    assert.deepEqual(Object.keys(document.paths["/users/{id}"].patch.responses), ["200", "400", "401", "403", "404", "409"])
    assert.deepEqual(Object.keys(document.paths["/users/{id}/deactivate"].post.responses), ["200", "400", "401", "403", "404", "409"])
    assert.deepEqual(Object.keys(document.paths["/users/{id}/reactivate"].post.responses), ["200", "400", "401", "403", "404"])
    assert.deepEqual(Object.keys(document.paths["/users/{id}/make-primary-administrator"].post.responses), ["200", "400", "401", "403", "404", "409"])
    assert.deepEqual(Object.keys(document.paths["/roles/{id}/grants"].put.responses), ["200", "400", "401", "403", "404"])
    for (const [path, method] of [["/users/{id}", "patch"], ["/roles/{id}/grants", "put"]] as const) {
      for (const [status, operation] of Object.entries(document.paths[path][method].responses)) {
        const media = Object.keys(operation.content)
        assert.deepEqual(media, [status === "200" ? "application/json" : "application/problem+json"], `${method} ${path} ${status}`)
      }
    }

    // The rules a client must know are in the prose, not only in the code.
    assert.match(document.paths["/users"].post.description ?? "", /exactly one of `allProjects: true`, `projectIds` or `serviceProviderId`/)
    assert.match(document.paths["/users/{id}"].patch.description ?? "", /primary administrator cannot be moved to another role or narrowed \(409\)/)
    assert.match(document.paths["/users/{id}/deactivate"].post.description ?? "", /primary administrator cannot be deactivated \(409\)/)
    const transfer = document.paths["/users/{id}/make-primary-administrator"].post.description ?? ""
    assert.match(transfer, /service provider's account, or one given some projects only, is refused \(409\)/)
    assert.match(transfer, /already is the primary administrator answers 200 unchanged/)
    assert.match(transfer, /`edit` on `configure.access` rather than the primary administrator's alone/, "the grant is a choice, and the document says which")
    assert.match(document.paths["/roles/{id}/grants"].put.description ?? "", /imply `view`/)

    for (const path of ["/users", "/roles"]) {
      const page = document.paths[path].get.responses["200"].content["application/json"].schema
      assert.deepEqual(page.required, ["items", "nextCursor"], path)
      assert.equal(page.properties?.items.type, "array", path)
    }

    const byName = (operation: Operation) => (operation.parameters ?? []).map((parameter) => `${parameter.in}:${parameter.name}`)
    assert.deepEqual(byName(document.paths["/users/{id}/deactivate"].post), ["path:id"])
    assert.deepEqual(byName(document.paths["/roles"].get).sort(), ["query:cursor", "query:limit"])

    // A write takes a JSON body, and it is the strict one the contracts spell.
    assert.deepEqual(document.paths["/users"].post.requestBody?.content["application/json"].schema.required, ["email", "fullName", "roleId"])
    assert.deepEqual(document.paths["/roles"].post.requestBody?.content["application/json"].schema.required, ["name", "scope", "description"])
    assert.deepEqual(document.paths["/roles/{id}/grants"].put.requestBody?.content["application/json"].schema.required, ["grants"])
    assert.equal(document.paths["/users/{id}/deactivate"].post.requestBody, undefined, "a command takes no body")
    assert.equal(document.paths["/users/{id}/make-primary-administrator"].post.requestBody, undefined, "so does the transfer: the path names the account")
  })

  test("documents each planning route with its verbs, its problems and the rules a client must know", async () => {
    const document = await spec()
    const operations = (path: string) =>
      Object.fromEntries(Object.entries(document.paths[path]).map(([method, operation]) => [method, operation.operationId]))

    assert.deepEqual(operations("/planning-areas"), { get: "listPlanningAreas", post: "createPlanningArea" })
    assert.deepEqual(operations("/planning-areas/{id}"), { get: "getPlanningArea", patch: "patchPlanningArea" })
    assert.deepEqual(operations("/planning-areas/{id}/boundaries"), { get: "listPlanningAreaBoundaries", post: "createPlanningAreaBoundary" })
    assert.deepEqual(operations("/planning-area-boundaries"), { get: "listPlanningAreaBoundariesAcrossAreas" })
    assert.deepEqual(operations("/planning-area-boundaries/{id}"), { get: "getPlanningAreaBoundary", patch: "patchPlanningAreaBoundary" })
    assert.deepEqual(operations("/collection-calendars"), { get: "listCollectionCalendars", post: "createCollectionCalendar" })
    assert.deepEqual(operations("/collection-calendars/{id}"), { get: "getCollectionCalendar", patch: "patchCollectionCalendar" })
    assert.deepEqual(operations("/collection-calendars/{id}/holidays"), { put: "putCollectionCalendarHolidays" })

    // What a caller can earn on each of them, and in what shape.
    for (const path of ["/planning-areas", "/collection-calendars"]) {
      assert.deepEqual(Object.keys(document.paths[path].get.responses), ["200", "400", "401", "403"], path)
      assert.deepEqual(Object.keys(document.paths[path].post.responses), ["201", "400", "401", "403", "409"], path)
      assert.deepEqual(Object.keys(document.paths[`${path}/{id}`].get.responses), ["200", "400", "401", "403", "404"], path)
      assert.deepEqual(Object.keys(document.paths[`${path}/{id}`].patch.responses), ["200", "400", "401", "403", "404", "409"], path)
    }
    // A version hangs off its area: the nested list and create answer the area's 404, the create the overlap's 409.
    assert.deepEqual(Object.keys(document.paths["/planning-areas/{id}/boundaries"].get.responses), ["200", "400", "401", "403", "404"])
    assert.deepEqual(Object.keys(document.paths["/planning-areas/{id}/boundaries"].post.responses), ["201", "400", "401", "403", "404", "409"])
    assert.deepEqual(Object.keys(document.paths["/planning-area-boundaries"].get.responses), ["200", "400", "401", "403"])
    assert.deepEqual(Object.keys(document.paths["/planning-area-boundaries/{id}"].get.responses), ["200", "400", "401", "403", "404"])
    assert.deepEqual(Object.keys(document.paths["/planning-area-boundaries/{id}"].patch.responses), ["200", "400", "401", "403", "404", "409"])
    // A set is replaced whole, and nothing there can collide: a repeated day is the body's own 400 and never the key's 409.
    assert.deepEqual(Object.keys(document.paths["/collection-calendars/{id}/holidays"].put.responses), ["200", "400", "401", "403", "404"])
    assert.deepEqual(document.paths["/collection-calendars/{id}/holidays"].put.requestBody?.content["application/json"].schema.required, ["holidays"])
    for (const [status, operation] of Object.entries(document.paths["/planning-area-boundaries/{id}"].patch.responses)) {
      const media = Object.keys(operation.content)
      assert.deepEqual(media, [status === "200" ? "application/json" : "application/problem+json"], status)
    }

    // Every list is project-scoped and takes the project filter beside the page; each adds its own.
    const byName = (operation: Operation) => (operation.parameters ?? []).map((parameter) => `${parameter.in}:${parameter.name}`)
    assert.deepEqual(byName(document.paths["/planning-areas"].get).sort(), ["query:cursor", "query:limit", "query:projectId", "query:purpose"])
    assert.deepEqual(byName(document.paths["/planning-area-boundaries"].get).sort(), ["query:cursor", "query:limit", "query:planningAreaId", "query:projectId", "query:validOn"])
    assert.deepEqual(byName(document.paths["/planning-areas/{id}/boundaries"].get).sort(), ["path:id", "query:cursor", "query:limit", "query:validOn"])
    assert.deepEqual(byName(document.paths["/collection-calendars"].get).sort(), ["query:cursor", "query:limit", "query:projectId", "query:validOn"])
    assert.deepEqual(byName(document.paths["/collection-calendars/{id}/holidays"].put), ["path:id"])

    // The rules a client must know are in the prose, not only in the code.
    assert.match(document.paths["/planning-areas"].post.description ?? "", /code is the stable reference[^.]*set once/)
    assert.match(document.paths["/planning-areas"].post.description ?? "", /the ring and the globe are the contracts'/)
    assert.match(document.paths["/planning-areas"].post.description ?? "", /valid polygon is PostGIS's[^.]*400 on `boundary\.boundary`, "Not a valid polygon"/)
    assert.match(document.paths["/planning-areas"].post.description ?? "", /answered beside the area \(null when none was drawn\)/)
    assert.ok(
      document.paths["/planning-areas"].post.responses["201"].content["application/json"].schema.required?.includes("boundary"),
      "the 201 always says whether a version was written",
    )
    assert.match(document.paths["/planning-areas/{id}"].patch.description ?? "", /The code does not change/)
    assert.match(document.paths["/planning-areas/{id}/boundaries"].get.description ?? "", /none on a day between two versions/)
    assert.match(document.paths["/planning-areas/{id}/boundaries"].post.description ?? "", /One boundary of an area is in force at a time/)
    assert.match(document.paths["/planning-areas/{id}/boundaries"].post.description ?? "", /valid polygon is PostGIS's[^.]*400 on `boundary`, "Not a valid polygon"/)
    assert.match(document.paths["/planning-area-boundaries/{id}"].patch.description ?? "", /valid polygon is PostGIS's/)
    assert.match(document.paths["/planning-area-boundaries"].get.description ?? "", /Layers control/)
    assert.match(document.paths["/planning-area-boundaries/{id}"].patch.description ?? "", /the start does not move/)
    assert.match(document.paths["/collection-calendars"].post.description ?? "", /a project has one calendar in force at a time/)
    assert.match(document.paths["/collection-calendars"].post.description ?? "", /each a day inside the period \(400 on `holidays\.N\.day` otherwise\)/)
    assert.match(document.paths["/collection-calendars/{id}"].patch.description ?? "", /a shortening that would leave one outside is refused \(409\) counting them/)
    assert.match(document.paths["/collection-calendars/{id}/holidays"].put.description ?? "", /Replaces the whole list/)
    assert.match(document.paths["/collection-calendars"].get.description ?? "", /an account that works in none[^.]*reads an empty page/)
    assert.match(document.paths["/planning-areas"].get.description ?? "", /an account that works in none[^.]*reads an empty page/)
    // The project's two new fields are stated where they are written (Issue #97).
    assert.match(document.paths["/projects/{id}"].patch.description ?? "", /`weekend` replaces the days the project rests on/)
    assert.match(document.paths["/projects/{id}"].patch.description ?? "", /`holidayList`[^.]*as null takes it away[^.]*rests on its weekend only/)
    assert.match(document.paths["/projects"].post.description ?? "", /Saturday and Sunday unless the body says otherwise/)

    // A write takes a JSON body, and it is the strict one the contracts spell.
    const required = (path: string) => document.paths[path].post.requestBody?.content["application/json"].schema.required
    assert.deepEqual(required("/planning-areas"), ["projectId", "code", "name", "purpose"])
    assert.deepEqual(required("/planning-areas/{id}/boundaries"), ["boundary", "validFrom"])
    assert.deepEqual(required("/collection-calendars"), ["projectId", "name", "validFrom"])
  })

  test("documents each registry route with its verbs, its problems and the rules a client must know", async () => {
    const document = await spec()
    const operations = (path: string) =>
      Object.fromEntries(Object.entries(document.paths[path]).map(([method, operation]) => [method, operation.operationId]))

    assert.deepEqual(operations("/waste-fractions"), { get: "listWasteFractions", post: "createWasteFraction" })
    assert.deepEqual(operations("/waste-fractions/{id}"), { get: "getWasteFraction", patch: "patchWasteFraction" })
    assert.deepEqual(operations("/container-types"), { get: "listContainerTypes", post: "createContainerType" })
    assert.deepEqual(operations("/container-types/{id}"), { get: "getContainerType", patch: "patchContainerType" })
    assert.deepEqual(operations("/service-frequencies"), { get: "listServiceFrequencies", post: "createServiceFrequency" })
    assert.deepEqual(operations("/service-frequencies/{id}"), { get: "getServiceFrequency", patch: "patchServiceFrequency" })
    assert.deepEqual(operations("/products"), { get: "listProducts", post: "createProduct" })
    assert.deepEqual(operations("/products/{id}"), { get: "getProduct", patch: "patchProduct" })
    assert.deepEqual(operations("/customers"), { get: "listCustomers", post: "createCustomer" })
    assert.deepEqual(operations("/customers/{id}"), { get: "getCustomer", patch: "patchCustomer" })
    assert.deepEqual(operations("/properties"), { get: "listProperties", post: "createProperty" })
    assert.deepEqual(operations("/properties/{id}"), { get: "getProperty", patch: "patchProperty" })
    assert.deepEqual(operations("/properties/{id}/parties"), { put: "putPropertyParties" })
    assert.deepEqual(operations("/property-groups"), { get: "listPropertyGroups", post: "createPropertyGroup" })
    assert.deepEqual(operations("/property-groups/{id}"), { get: "getPropertyGroup", patch: "patchPropertyGroup" })
    assert.deepEqual(operations("/property-groups/{id}/members"), { put: "putPropertyGroupMembers" })
    assert.deepEqual(operations("/shared-collection-points"), { get: "listSharedCollectionPoints", post: "createSharedCollectionPoint" })
    assert.deepEqual(operations("/shared-collection-points/{id}"), { get: "getSharedCollectionPoint", patch: "patchSharedCollectionPoint" })
    assert.deepEqual(operations("/shared-collection-points/{id}/members"), { put: "putSharedCollectionPointMembers" })

    // What a caller can earn on each of them, and in what shape.
    const families = ["/waste-fractions", "/container-types", "/service-frequencies", "/products", "/customers", "/properties", "/property-groups", "/shared-collection-points"]
    for (const path of families) {
      assert.deepEqual(Object.keys(document.paths[path].get.responses), ["200", "400", "401", "403"], path)
      assert.deepEqual(Object.keys(document.paths[path].post.responses), ["201", "400", "401", "403", "409"], path)
      assert.deepEqual(Object.keys(document.paths[`${path}/{id}`].get.responses), ["200", "400", "401", "403", "404"], path)
      assert.deepEqual(Object.keys(document.paths[`${path}/{id}`].patch.responses), ["200", "400", "401", "403", "404", "409"], path)
    }
    // A set is replaced whole, and nothing there can collide: a repeated
    // entry is the body's own 400 and never the database's 409.
    for (const [path, set] of [
      ["/properties/{id}/parties", "parties"],
      ["/property-groups/{id}/members", "members"],
      ["/shared-collection-points/{id}/members", "members"],
    ] as const) {
      assert.deepEqual(Object.keys(document.paths[path].put.responses), ["200", "400", "401", "403", "404"], path)
      assert.deepEqual(document.paths[path].put.requestBody?.content["application/json"].schema.required, [set], path)
    }
    for (const [status, operation] of Object.entries(document.paths["/products/{id}"].patch.responses)) {
      const media = Object.keys(operation.content)
      assert.deepEqual(media, [status === "200" ? "application/json" : "application/problem+json"], status)
    }

    // A project-scoped list takes the project filter beside the page; a company-wide one does not.
    const byName = (operation: Operation) => (operation.parameters ?? []).map((parameter) => `${parameter.in}:${parameter.name}`)
    for (const path of ["/service-frequencies", "/products", "/property-groups", "/shared-collection-points"]) {
      assert.deepEqual(byName(document.paths[path].get).sort(), ["query:cursor", "query:limit", "query:projectId"], path)
    }
    for (const path of ["/waste-fractions", "/container-types", "/customers"]) {
      assert.deepEqual(byName(document.paths[path].get).sort(), ["query:cursor", "query:limit"], path)
    }
    assert.deepEqual(byName(document.paths["/customers/{id}"].patch), ["path:id"])
    // The portal's read model is a filter of its own beside the project's.
    assert.deepEqual(byName(document.paths["/properties"].get).sort(), ["query:cursor", "query:customerId", "query:limit", "query:projectId"])
    assert.deepEqual(byName(document.paths["/properties/{id}/parties"].put), ["path:id"])

    // The rules a client must know are in the prose, not only in the code.
    assert.match(document.paths["/waste-fractions/{id}"].patch.description ?? "", /key is not patchable/)
    assert.match(document.paths["/service-frequencies"].post.description ?? "", /an interval needs a rate to belong to/)
    assert.match(document.paths["/service-frequencies/{id}"].patch.description ?? "", /held against the stored row/)
    assert.match(document.paths["/products"].post.description ?? "", /service frequency must be one of the named project's/)
    assert.match(document.paths["/products"].get.description ?? "", /an account that works in none[^.]*reads an empty page/)
    assert.match(document.paths["/customers"].post.description ?? "", /e-mail is stored lowercase/)
    assert.match(document.paths["/properties"].get.description ?? "", /citizen portal's read model/)
    assert.match(document.paths["/properties"].post.description ?? "", /a location outside the WGS 84 range is refused before the database sees it/)
    assert.match(document.paths["/properties/{id}/parties"].put.description ?? "", /Replaces the whole list/)
    assert.match(document.paths["/property-groups/{id}/members"].put.description ?? "", /a property of the group's own project/)
    assert.match(document.paths["/shared-collection-points"].post.description ?? "", /the place is the record/)

    // A write takes a JSON body, and it is the strict one the contracts spell.
    const required = (path: string) => document.paths[path].post.requestBody?.content["application/json"].schema.required
    assert.deepEqual(required("/waste-fractions"), ["key", "name"])
    assert.deepEqual(required("/container-types"), ["name"])
    assert.deepEqual(required("/service-frequencies"), ["projectId", "name"])
    assert.deepEqual(required("/products"), ["projectId", "name", "kind", "unit"])
    assert.deepEqual(required("/customers"), ["kind", "name"])
    assert.deepEqual(required("/properties"), ["projectId", "name", "address", "kind"])
    assert.deepEqual(required("/property-groups"), ["projectId", "name", "purpose"])
    assert.deepEqual(required("/shared-collection-points"), [
      "projectId",
      "name",
      "kind",
      "address",
      "location",
      "operatingModel",
      "accessMode",
      "billingMode",
    ])

    for (const path of ["/waste-fractions", "/products", "/customers", "/properties", "/property-groups", "/shared-collection-points"]) {
      const page = document.paths[path].get.responses["200"].content["application/json"].schema
      assert.deepEqual(page.required, ["items", "nextCursor"], path)
      assert.equal(page.properties?.items.type, "array", path)
    }
  })

  test("documents each effective-dated route with its verbs, its problems and the rules a client must know", async () => {
    const document = await spec()
    const operations = (path: string) =>
      Object.fromEntries(Object.entries(document.paths[path]).map(([method, operation]) => [method, operation.operationId]))

    assert.deepEqual(operations("/agreements"), { get: "listAgreements", post: "createAgreement" })
    assert.deepEqual(operations("/agreements/{id}"), { get: "getAgreement", patch: "patchAgreement" })
    assert.deepEqual(operations("/agreements/{id}/subscriptions"), { get: "listAgreementSubscriptions", post: "createSubscription" })
    assert.deepEqual(operations("/subscriptions/{id}"), { get: "getSubscription", patch: "patchSubscription" })
    // The flat list across agreements (Issue #183), as placements are listed across containers.
    assert.deepEqual(operations("/subscriptions"), { get: "listSubscriptions" })
    assert.deepEqual(operations("/containers"), { get: "listContainers", post: "createContainer" })
    assert.deepEqual(operations("/containers/{id}"), { get: "getContainer", patch: "patchContainer" })
    assert.deepEqual(operations("/containers/{id}/placements"), { post: "createPlacement" })
    assert.deepEqual(operations("/placements"), { get: "listPlacements" })
    assert.deepEqual(operations("/placements/{id}"), { get: "getPlacement", patch: "patchPlacement" })

    // A child hangs off a path, so its create can answer 404 as well as 409.
    for (const path of ["/agreements", "/containers"]) {
      assert.deepEqual(Object.keys(document.paths[path].get.responses), ["200", "400", "401", "403"], path)
      assert.deepEqual(Object.keys(document.paths[path].post.responses), ["201", "400", "401", "403", "409"], path)
      assert.deepEqual(Object.keys(document.paths[`${path}/{id}`].get.responses), ["200", "400", "401", "403", "404"], path)
      assert.deepEqual(Object.keys(document.paths[`${path}/{id}`].patch.responses), ["200", "400", "401", "403", "404", "409"], path)
    }
    assert.deepEqual(Object.keys(document.paths["/agreements/{id}/subscriptions"].get.responses), ["200", "400", "401", "403", "404"])
    assert.deepEqual(Object.keys(document.paths["/agreements/{id}/subscriptions"].post.responses), ["201", "400", "401", "403", "404", "409"])
    assert.deepEqual(Object.keys(document.paths["/containers/{id}/placements"].post.responses), ["201", "400", "401", "403", "404", "409"])
    assert.deepEqual(Object.keys(document.paths["/subscriptions/{id}"].patch.responses), ["200", "400", "401", "403", "404", "409"])
    assert.deepEqual(Object.keys(document.paths["/subscriptions"].get.responses), ["200", "400", "401", "403"])
    assert.deepEqual(Object.keys(document.paths["/placements"].get.responses), ["200", "400", "401", "403"])
    assert.deepEqual(Object.keys(document.paths["/placements/{id}"].patch.responses), ["200", "400", "401", "403", "404", "409"])

    // What is asked for by day, and what by id: the filters each list takes.
    const byName = (operation: Operation) => (operation.parameters ?? []).map((parameter) => `${parameter.in}:${parameter.name}`)
    assert.deepEqual(byName(document.paths["/agreements"].get).sort(), [
      "query:cursor",
      "query:customerId",
      "query:limit",
      "query:number",
      "query:projectId",
      "query:validOn",
    ])
    assert.deepEqual(byName(document.paths["/agreements/{id}/subscriptions"].get).sort(), ["path:id", "query:cursor", "query:limit", "query:validOn"])
    assert.deepEqual(byName(document.paths["/subscriptions"].get).sort(), ["query:agreementId", "query:cursor", "query:limit", "query:projectId", "query:validOn"])
    // The two ledger filters, answered from the projection since Resources (#101).
    assert.deepEqual(byName(document.paths["/containers"].get).sort(), ["query:assetStatus", "query:containerTypeId", "query:cursor", "query:limit", "query:projectId", "query:warehouseId"])
    assert.match(document.paths["/containers"].get.description ?? "", /standing in that warehouse/)
    assert.deepEqual(byName(document.paths["/placements"].get).sort(), [
      "query:containerId",
      "query:cursor",
      "query:limit",
      "query:projectId",
      "query:propertyId",
      "query:sharedCollectionPointId",
      "query:subscriptionId",
      "query:validOn",
    ])
    assert.deepEqual(byName(document.paths["/containers/{id}/placements"].post), ["path:id"])

    // The rules a client must know are in the prose, not only in the code.
    assert.match(document.paths["/agreements"].post.description ?? "", /a number may name a later agreement once the earlier one has ended/)
    assert.match(document.paths["/agreements"].get.description ?? "", /holds or pays for/)
    assert.match(document.paths["/agreements/{id}"].patch.description ?? "", /a shortening that would strand one is refused \(409\)/)
    assert.match(document.paths["/agreements/{id}/subscriptions"].post.description ?? "", /exactly one of `propertyId` and `sharedCollectionPointId`/)
    assert.match(document.paths["/subscriptions/{id}"].patch.description ?? "", /The product and the place do not change/)
    assert.match(document.paths["/containers"].post.description ?? "", /unique across the company, not inside a project/)
    assert.match(document.paths["/containers/{id}/placements"].post.description ?? "", /one container serves in one place at a time/)
    assert.match(document.paths["/placements"].get.description ?? "", /only answerable for a day/)
    assert.match(document.paths["/placements/{id}"].get.description ?? "", /read on every request and never stored/)

    // A write takes a JSON body, and it is the strict one the contracts spell.
    const required = (path: string) => document.paths[path].post.requestBody?.content["application/json"].schema.required
    assert.deepEqual(required("/agreements"), ["projectId", "number", "customerId", "payerCustomerId", "billingCadence", "currency", "validFrom"])
    assert.deepEqual(required("/agreements/{id}/subscriptions"), ["productId", "validFrom"])
    assert.deepEqual(required("/containers"), ["projectId", "label", "containerTypeId"])
    assert.deepEqual(required("/containers/{id}/placements"), ["subscriptionId", "wasteFractionId", "validFrom"])

    for (const path of ["/agreements", "/agreements/{id}/subscriptions", "/containers", "/placements"]) {
      const page = document.paths[path].get.responses["200"].content["application/json"].schema
      assert.deepEqual(page.required, ["items", "nextCursor"], path)
      assert.equal(page.properties?.items.type, "array", path)
    }
  })

  test("documents each route of the container ledger with its verbs, its problems and the rules a client must know (Issue #101, slice 5)", async () => {
    const document = await spec()
    const operations = (path: string) =>
      Object.fromEntries(Object.entries(document.paths[path]).map(([method, operation]) => [method, operation.operationId]))

    assert.deepEqual(operations("/containers/{id}/receive"), { post: "receiveContainer" })
    assert.deepEqual(operations("/containers/{id}/return"), { post: "returnContainer" })
    assert.deepEqual(operations("/containers/{id}/transfer"), { post: "transferContainer" })
    assert.deepEqual(operations("/containers/{id}/decommission"), { post: "decommissionContainer" })
    assert.deepEqual(operations("/containers/{id}/adjust"), { post: "adjustContainer" })
    assert.deepEqual(operations("/containers/{id}/movements"), { get: "listContainerMovements" })
    assert.deepEqual(operations("/stock-movements"), { get: "listStockMovements" })
    assert.equal(document.paths["/containers/{id}/issue"], undefined, "one action, one command: the issue is the placement create")

    // Every command hangs off a container, so it answers 404 as well as its state's 409.
    for (const verb of ["receive", "return", "transfer", "decommission", "adjust"]) {
      assert.deepEqual(Object.keys(document.paths[`/containers/{id}/${verb}`].post.responses), ["201", "400", "401", "403", "404", "409"], verb)
      for (const [status, operation] of Object.entries(document.paths[`/containers/{id}/${verb}`].post.responses)) {
        assert.deepEqual(Object.keys(operation.content), [status === "201" ? "application/json" : "application/problem+json"], `${verb} ${status}`)
      }
    }
    assert.deepEqual(Object.keys(document.paths["/containers/{id}/movements"].get.responses), ["200", "400", "401", "403", "404"])
    assert.deepEqual(Object.keys(document.paths["/stock-movements"].get.responses), ["200", "400", "401", "403"])

    const byName = (operation: Operation) => (operation.parameters ?? []).map((parameter) => `${parameter.in}:${parameter.name}`)
    assert.deepEqual(byName(document.paths["/containers/{id}/movements"].get).sort(), ["path:id", "query:cursor", "query:limit"])
    assert.deepEqual(byName(document.paths["/stock-movements"].get).sort(), [
      "query:containerId",
      "query:cursor",
      "query:from",
      "query:kind",
      "query:limit",
      "query:projectId",
      "query:to",
      "query:warehouseId",
    ])

    // The rules a client must know are in the prose, not only in the code.
    assert.match(document.paths["/containers/{id}/receive"].post.description ?? "", /Only a container with no stock record yet can be received/)
    assert.match(document.paths["/containers/{id}/return"].post.description ?? "", /Either both change or neither/)
    assert.match(document.paths["/containers/{id}/transfer"].post.description ?? "", /reads as still in the first until the second records it/)
    assert.match(document.paths["/containers/{id}/decommission"].post.description ?? "", /In service, `validTo` is required \(400\)/)
    assert.match(document.paths["/containers/{id}/adjust"].post.description ?? "", /Neither side may be service/)
    assert.match(document.paths["/containers/{id}/adjust"].post.description ?? "", /`edit` on `resources.containers`, not `create`/, "the grant is a choice, and the document says which")
    assert.match(document.paths["/containers/{id}/movements"].get.description ?? "", /oldest first/)
    assert.match(document.paths["/stock-movements"].get.description ?? "", /an account that works in none[^.]*reads an empty page/)
    assert.match(document.paths["/containers/{id}/placements"].post.description ?? "", /the `issue` command of the Stock Movement ledger and the only door into service/)
    assert.match(document.paths["/containers/{id}/placements"].post.description ?? "", /both or neither/)
    assert.match(document.paths["/placements/{id}"].patch.description ?? "", /a `validTo` on an open placement is refused \(409\)/)

    // A command takes the strict body the contracts spell; the issue's gained the movement's two fields and nothing else required.
    const required = (path: string) => document.paths[path].post.requestBody?.content["application/json"].schema.required
    assert.deepEqual(required("/containers/{id}/receive"), ["warehouseId"])
    assert.deepEqual(required("/containers/{id}/return"), ["warehouseId", "validTo"])
    assert.deepEqual(required("/containers/{id}/transfer"), ["warehouseId"])
    assert.deepEqual(required("/containers/{id}/decommission"), ["reason"])
    assert.deepEqual(required("/containers/{id}/adjust"), ["toKind", "reason"])
    assert.deepEqual(required("/containers/{id}/placements"), ["subscriptionId", "wasteFractionId", "validFrom"])
    assert.ok(Object.keys(document.paths["/containers/{id}/placements"].post.requestBody?.content["application/json"].schema.properties ?? {}).includes("occurredAt"))

    for (const path of ["/containers/{id}/movements", "/stock-movements"]) {
      const page = document.paths[path].get.responses["200"].content["application/json"].schema
      assert.deepEqual(page.required, ["items", "nextCursor"], path)
      assert.equal(page.properties?.items.type, "array", path)
    }
  })

  test("documents each planning route of slice 4 with its verbs, its problems and the rules a client must know", async () => {
    const document = await spec()
    const operations = (path: string) =>
      Object.fromEntries(Object.entries(document.paths[path]).map(([method, operation]) => [method, operation.operationId]))

    assert.deepEqual(operations("/route-schemes"), { get: "listRouteSchemes", post: "createRouteScheme" })
    assert.deepEqual(operations("/route-schemes/{id}"), { get: "getRouteScheme", patch: "patchRouteScheme" })
    assert.deepEqual(operations("/route-schemes/{id}/occurrences"), { get: "listRouteSchemeOccurrences" })
    assert.deepEqual(operations("/route-schemes/{id}/collection-groups"), { get: "listRouteSchemeCollectionGroups", post: "createCollectionGroup" })
    assert.deepEqual(operations("/collection-groups/{id}"), { get: "getCollectionGroup", patch: "patchCollectionGroup" })
    assert.deepEqual(operations("/collection-groups/{id}/stop-matching-rule"), { put: "putCollectionGroupStopMatchingRule" })
    assert.deepEqual(operations("/collection-groups/{id}/containers"), { put: "putCollectionGroupContainers" })

    // A validated scheme's structure and a scheme's period are both 409s; a group hangs off a path, so its create answers 404 too.
    assert.deepEqual(Object.keys(document.paths["/route-schemes"].get.responses), ["200", "400", "401", "403"])
    assert.deepEqual(Object.keys(document.paths["/route-schemes"].post.responses), ["201", "400", "401", "403", "409"])
    assert.deepEqual(Object.keys(document.paths["/route-schemes/{id}"].patch.responses), ["200", "400", "401", "403", "404", "409"])
    assert.deepEqual(Object.keys(document.paths["/route-schemes/{id}/occurrences"].get.responses), ["200", "400", "401", "403", "404"])
    assert.deepEqual(Object.keys(document.paths["/route-schemes/{id}/collection-groups"].post.responses), ["201", "400", "401", "403", "404", "409"])
    assert.deepEqual(Object.keys(document.paths["/collection-groups/{id}"].patch.responses), ["200", "400", "401", "403", "404", "409"])
    assert.deepEqual(Object.keys(document.paths["/collection-groups/{id}/stop-matching-rule"].put.responses), ["200", "400", "401", "403", "404", "409"])
    assert.deepEqual(Object.keys(document.paths["/collection-groups/{id}/containers"].put.responses), ["200", "400", "401", "403", "404", "409"])

    const byName = (operation: Operation) => (operation.parameters ?? []).map((parameter) => `${parameter.in}:${parameter.name}`)
    assert.deepEqual(byName(document.paths["/route-schemes"].get).sort(), [
      "query:cursor",
      "query:limit",
      "query:planAhead",
      "query:planningAreaId",
      "query:projectId",
      "query:status",
      "query:validOn",
    ])
    assert.deepEqual(byName(document.paths["/route-schemes/{id}/occurrences"].get).sort(), ["path:id", "query:from", "query:to"])
    assert.deepEqual(byName(document.paths["/route-schemes/{id}/collection-groups"].get).sort(), ["path:id", "query:cursor", "query:limit"])

    // The rules a client must know are in the prose, not only in the code.
    assert.match(document.paths["/route-schemes"].post.description ?? "", /one scheme of a name is in force at a time in a project/)
    assert.match(document.paths["/route-schemes"].post.description ?? "", /so is the depot the routes depart from, and the unloading station they empty at is one of this company's/)
    assert.match(document.paths["/route-schemes"].post.description ?? "", /holds the licence class the vehicle requires on the day the scheme's period starts or today, whichever is later/)
    assert.match(document.paths["/route-schemes/{id}/collection-groups"].post.description ?? "", /no vehicle or driver is on two groups that run on a shared day/)
    assert.match(document.paths["/collection-groups/{id}"].patch.description ?? "", /the vehicle or the driver of one collection group/)
    assert.match(document.paths["/route-schemes/{id}"].patch.description ?? "", /counting the groups, which have to be moved first/)
    assert.match(document.paths["/route-schemes/{id}"].patch.description ?? "", /shortening the period is free/)
    assert.match(document.paths["/route-schemes/{id}/occurrences"].get.description ?? "", /nothing is written, and no generation run is started/i)
    assert.match(document.paths["/route-schemes/{id}/collection-groups"].post.description ?? "", /the first rule group wins a container on a shared day/)
    assert.match(document.paths["/collection-groups/{id}"].patch.description ?? "", /The source, the rule and the picked list never move through a patch/)
    assert.match(document.paths["/collection-groups/{id}/stop-matching-rule"].put.description ?? "", /A manual group has no rule to replace/)
    assert.match(document.paths["/collection-groups/{id}/containers"].put.description ?? "", /positions are 1\.\.n in the body's order/)

    const required = (path: string, method: "post" | "put" = "post") => document.paths[path][method].requestBody?.content["application/json"].schema.required
    assert.deepEqual(required("/route-schemes"), ["projectId", "name", "serviceType", "frequency", "serviceDays", "collectionGroups", "validFrom"])
    assert.deepEqual(required("/route-schemes/{id}/collection-groups"), ["name", "days", "stopSource"])
    assert.deepEqual(required("/collection-groups/{id}/stop-matching-rule", "put"), ["wasteFractionIds", "containerTypeIds", "vehicleTypeId"])
    assert.deepEqual(required("/collection-groups/{id}/containers", "put"), ["containerIds"])

    for (const path of ["/route-schemes", "/route-schemes/{id}/collection-groups"]) {
      const page = document.paths[path].get.responses["200"].content["application/json"].schema
      assert.deepEqual(page.required, ["items", "nextCursor"], path)
      assert.equal(page.properties?.items.type, "array", path)
    }
    // The occurrence read answers rows and no cursor: a computation over a bounded window, not a table.
    assert.equal(document.paths["/route-schemes/{id}/occurrences"].get.responses["200"].content["application/json"].schema.type, "array")
  })

  test("documents the generation door of part B: the command that answers at once and the two run reads (#97, #128)", async () => {
    const document = await spec()
    const operations = (path: string) =>
      Object.fromEntries(Object.entries(document.paths[path]).map(([method, operation]) => [method, operation.operationId]))
    assert.deepEqual(operations("/route-schemes/{id}/generate"), { post: "generateRouteScheme" })
    assert.deepEqual(operations("/route-schemes/{id}/generation-runs"), { get: "listRouteSchemeGenerationRuns" })
    assert.deepEqual(operations("/generation-runs/{id}"), { get: "getGenerationRun" })

    // 202 for the run it started, 200 for the one already in flight, 409 for a draft or a held job with no run to show, 503 for a database no worker has made the queue on; no 201, since a run is not created by the caller's hand.
    const generate = document.paths["/route-schemes/{id}/generate"].post
    assert.deepEqual(Object.keys(generate.responses), ["200", "202", "400", "401", "403", "404", "409", "503"])
    assert.deepEqual(generate.requestBody?.content["application/json"].schema.required, ["from", "to"])
    assert.equal(generate.responses["202"].headers, undefined, "a run is read at /generation-runs/{id}, and the body carries its id")
    assert.deepEqual(Object.keys(document.paths["/route-schemes/{id}/generation-runs"].get.responses), ["200", "400", "401", "403", "404"])
    assert.deepEqual(Object.keys(document.paths["/generation-runs/{id}"].get.responses), ["200", "400", "401", "403", "404"])

    const byName = (operation: Operation) => (operation.parameters ?? []).map((parameter) => `${parameter.in}:${parameter.name}`)
    assert.deepEqual(byName(document.paths["/route-schemes/{id}/generation-runs"].get).sort(), ["path:id", "query:cursor", "query:limit", "query:status"])
    const page = document.paths["/route-schemes/{id}/generation-runs"].get.responses["200"].content["application/json"].schema
    assert.deepEqual(page.required, ["items", "nextCursor"])

    // The rules a client must know are in the prose: it never waits, one run at a time, a draft generates nothing.
    assert.match(generate.description ?? "", /answers at once, before generation has begun/)
    assert.match(generate.description ?? "", /Generation happens on the worker, never on the request/)
    assert.match(generate.description ?? "", /two clicks are one run/)
    assert.match(generate.description ?? "", /A draft scheme generates nothing \(409\)/)
    assert.match(generate.description ?? "", /at most 366 days/)
    assert.match(document.paths["/route-schemes/{id}/generation-runs"].get.description ?? "", /newest first/)
    assert.match(document.paths["/generation-runs/{id}"].get.description ?? "", /what the office polls/)
  })

  test("documents each resources route of slice 3 with its verbs, its problems and the rules a client must know", async () => {
    const document = await spec()
    const operations = (path: string) =>
      Object.fromEntries(Object.entries(document.paths[path]).map(([method, operation]) => [method, operation.operationId]))

    assert.deepEqual(operations("/vehicle-types"), { get: "listVehicleTypes", post: "createVehicleType" })
    assert.deepEqual(operations("/vehicle-types/{id}"), { get: "getVehicleType", patch: "patchVehicleType" })
    assert.deepEqual(operations("/vehicle-types/{id}/container-types"), { put: "putVehicleTypeContainerTypes" })
    assert.deepEqual(operations("/warehouses"), { get: "listWarehouses", post: "createWarehouse" })
    assert.deepEqual(operations("/warehouses/{id}"), { get: "getWarehouse", patch: "patchWarehouse" })
    assert.deepEqual(operations("/depots"), { get: "listDepots", post: "createDepot" })
    assert.deepEqual(operations("/depots/{id}"), { get: "getDepot", patch: "patchDepot" })
    assert.deepEqual(operations("/unloading-stations"), { get: "listUnloadingStations", post: "createUnloadingStation" })
    assert.deepEqual(operations("/unloading-stations/{id}"), { get: "getUnloadingStation", patch: "patchUnloadingStation" })
    assert.deepEqual(operations("/unloading-stations/{id}/fractions"), { put: "putUnloadingStationFractions" })

    // What a caller can earn on each of them, and in what shape.
    for (const path of ["/vehicle-types", "/warehouses", "/depots", "/unloading-stations"]) {
      assert.deepEqual(Object.keys(document.paths[path].get.responses), ["200", "400", "401", "403"], path)
      assert.deepEqual(Object.keys(document.paths[path].post.responses), ["201", "400", "401", "403", "409"], path)
      assert.deepEqual(Object.keys(document.paths[`${path}/{id}`].get.responses), ["200", "400", "401", "403", "404"], path)
      assert.deepEqual(Object.keys(document.paths[`${path}/{id}`].patch.responses), ["200", "400", "401", "403", "404", "409"], path)
    }
    // A set is replaced whole, and nothing there can collide: a repeated id is the body's own 400 and never the key's 409.
    for (const [path, set] of [
      ["/vehicle-types/{id}/container-types", "containerTypeIds"],
      ["/unloading-stations/{id}/fractions", "wasteFractionIds"],
    ] as const) {
      assert.deepEqual(Object.keys(document.paths[path].put.responses), ["200", "400", "401", "403", "404"], path)
      assert.deepEqual(document.paths[path].put.requestBody?.content["application/json"].schema.required, [set], path)
    }
    for (const [status, operation] of Object.entries(document.paths["/depots/{id}"].patch.responses)) {
      const media = Object.keys(operation.content)
      assert.deepEqual(media, [status === "200" ? "application/json" : "application/problem+json"], status)
    }

    // A project-scoped list takes the project filter beside the page and its status; the two company-wide ones do not.
    const byName = (operation: Operation) => (operation.parameters ?? []).map((parameter) => `${parameter.in}:${parameter.name}`)
    for (const path of ["/warehouses", "/depots"]) {
      assert.deepEqual(byName(document.paths[path].get).sort(), ["query:cursor", "query:limit", "query:projectId", "query:status"], path)
    }
    assert.deepEqual(byName(document.paths["/vehicle-types"].get).sort(), ["query:cursor", "query:limit"])
    assert.deepEqual(byName(document.paths["/unloading-stations"].get).sort(), ["query:cursor", "query:limit", "query:status", "query:wasteFractionId"])
    assert.deepEqual(byName(document.paths["/vehicle-types/{id}/container-types"].put), ["path:id"])

    // The rules a client must know are in the prose, not only in the code.
    assert.match(document.paths["/vehicle-types"].post.description ?? "", /`key` is the stable slug[^.]*set once/)
    assert.match(document.paths["/vehicle-types/{id}"].patch.description ?? "", /The key does not change/)
    assert.match(document.paths["/vehicle-types/{id}/container-types"].put.description ?? "", /Replaces the whole compatibility set/)
    assert.match(document.paths["/warehouses"].post.description ?? "", /must be a depot of the same project/)
    assert.match(document.paths["/warehouses"].get.description ?? "", /an account that works in none[^.]*reads an empty page/)
    assert.match(document.paths["/depots"].post.description ?? "", /The location is required/)
    assert.match(document.paths["/depots"].post.description ?? "", /both or neither \(400 on `closesAt`\)/)
    assert.match(document.paths["/depots/{id}"].patch.description ?? "", /held against the stored row/)
    assert.match(document.paths["/unloading-stations"].get.description ?? "", /an account that works in no project of the company[^.]*reads an empty page/)
    assert.match(document.paths["/unloading-stations"].post.description ?? "", /may not register one \(403\)/)
    assert.match(document.paths["/unloading-stations/{id}/fractions"].put.description ?? "", /Replaces the whole set of fractions/)

    // A write takes a JSON body, and it is the strict one the contracts spell.
    const required = (path: string) => document.paths[path].post.requestBody?.content["application/json"].schema.required
    assert.deepEqual(required("/vehicle-types"), ["key", "name"])
    assert.deepEqual(required("/warehouses"), ["projectId", "code", "name", "address"])
    assert.deepEqual(required("/depots"), ["projectId", "code", "name", "address", "location"])
    assert.deepEqual(required("/unloading-stations"), ["code", "name", "address", "location", "ownership"])

    for (const path of ["/vehicle-types", "/warehouses", "/depots", "/unloading-stations"]) {
      const page = document.paths[path].get.responses["200"].content["application/json"].schema
      assert.deepEqual(page.required, ["items", "nextCursor"], path)
      assert.equal(page.properties?.items.type, "array", path)
    }
  })

  test("documents each vehicle allocation route of #101's slice 6 with its verbs, its problems and the rules a client must know", async () => {
    const document = await spec()
    const operations = (path: string) =>
      Object.fromEntries(Object.entries(document.paths[path]).map(([method, operation]) => [method, operation.operationId]))

    assert.deepEqual(operations("/vehicle-allocations"), { get: "listVehicleAllocations", post: "allocateVehicle" })
    assert.deepEqual(operations("/vehicle-allocations/{id}"), { get: "getVehicleAllocation" })
    assert.deepEqual(operations("/vehicle-allocations/{id}/change"), { post: "changeVehicleAllocation" })
    assert.deepEqual(operations("/vehicle-allocations/{id}/confirm"), { post: "confirmVehicleAllocation" })
    assert.deepEqual(operations("/vehicle-allocations/{id}/release"), { post: "releaseVehicleAllocation" })
    assert.deepEqual(operations("/vehicle-allocations/{id}/events"), { get: "listVehicleAllocationEvents" })

    // An overlap is a 409 on the allocate and the change, a released allocation on the change and the confirm; the release is idempotent and refuses nothing but a bad body.
    assert.deepEqual(Object.keys(document.paths["/vehicle-allocations"].get.responses), ["200", "400", "401", "403"])
    assert.deepEqual(Object.keys(document.paths["/vehicle-allocations"].post.responses), ["201", "400", "401", "403", "409"])
    assert.deepEqual(Object.keys(document.paths["/vehicle-allocations/{id}"].get.responses), ["200", "400", "401", "403", "404"])
    assert.deepEqual(Object.keys(document.paths["/vehicle-allocations/{id}/change"].post.responses), ["200", "400", "401", "403", "404", "409"])
    assert.deepEqual(Object.keys(document.paths["/vehicle-allocations/{id}/confirm"].post.responses), ["200", "400", "401", "403", "404", "409"])
    assert.deepEqual(Object.keys(document.paths["/vehicle-allocations/{id}/release"].post.responses), ["200", "400", "401", "403", "404"])
    assert.deepEqual(Object.keys(document.paths["/vehicle-allocations/{id}/events"].get.responses), ["200", "400", "401", "403", "404"])

    const byName = (operation: Operation) => (operation.parameters ?? []).map((parameter) => `${parameter.in}:${parameter.name}`)
    assert.deepEqual(byName(document.paths["/vehicle-allocations"].get).sort(), [
      "query:cursor",
      "query:driverId",
      "query:limit",
      "query:overlappingFrom",
      "query:overlappingTo",
      "query:projectId",
      "query:status",
      "query:trailerId",
      "query:vehicleId",
    ])
    assert.deepEqual(byName(document.paths["/vehicle-allocations/{id}/events"].get).sort(), ["path:id", "query:cursor", "query:limit"])

    // The rules a client must know are in the prose, not only in the code.
    assert.match(document.paths["/vehicle-allocations"].get.description ?? "", /a reservation ending exactly when the window starts does not touch it/)
    assert.match(document.paths["/vehicle-allocations"].post.description ?? "", /holds the licence class the vehicle requires on the window's last day, the last instant inside it rendered in the project's timezone/)
    assert.match(document.paths["/vehicle-allocations/{id}/change"].post.description ?? "", /A status gates a new reference and never an existing one/)
    assert.match(document.paths["/vehicles/{id}"].patch.description ?? "", /nor is one a collection group of a route scheme in force today names/)
    assert.match(document.paths["/drivers/{id}"].patch.description ?? "", /`inactive` or `suspended` under a live allocation/)
    assert.match(document.paths["/route-schemes/{id}"].patch.description ?? "", /judged again on the new start, and a driver who may not take the vehicle then is refused at `validFrom`/)
    assert.match(document.paths["/vehicle-allocations"].post.description ?? "", /one live reservation of a vehicle, of a driver and of a trailer at a time/)
    assert.match(document.paths["/vehicle-allocations/{id}/change"].post.description ?? "", /A released allocation does not change \(409\)/)
    assert.match(document.paths["/vehicle-allocations/{id}/confirm"].post.description ?? "", /without a write and without an event/)
    assert.match(document.paths["/vehicle-allocations/{id}/release"].post.description ?? "", /its window is freed/)
    assert.match(document.paths["/vehicle-allocations/{id}/events"].get.description ?? "", /append-only/)

    // A write takes a JSON body, and it is the strict one the contracts spell; the confirm's is empty.
    const required = (path: string) => document.paths[path].post.requestBody?.content["application/json"].schema.required
    assert.deepEqual(required("/vehicle-allocations"), ["projectId", "vehicleId", "plannedFrom", "plannedTo"])
    assert.deepEqual(required("/vehicle-allocations/{id}/change"), ["reason"])
    assert.deepEqual(required("/vehicle-allocations/{id}/release"), ["reason"])
    assert.equal(required("/vehicle-allocations/{id}/confirm"), undefined)

    for (const path of ["/vehicle-allocations", "/vehicle-allocations/{id}/events"]) {
      const page = document.paths[path].get.responses["200"].content["application/json"].schema
      assert.deepEqual(page.required, ["items", "nextCursor"], path)
      assert.equal(page.properties?.items.type, "array", path)
    }
  })

  test("documents each fleet route with its verbs, its problems and the rules a client must know", async () => {
    const document = await spec()
    const operations = (path: string) =>
      Object.fromEntries(Object.entries(document.paths[path]).map(([method, operation]) => [method, operation.operationId]))

    assert.deepEqual(operations("/vehicles"), { get: "listVehicles", post: "createVehicle" })
    assert.deepEqual(operations("/vehicles/{id}"), { get: "getVehicle", patch: "patchVehicle" })
    assert.deepEqual(operations("/vehicles/{id}/compartments"), { put: "putVehicleCompartments" })
    assert.deepEqual(operations("/drivers"), { get: "listDrivers", post: "createDriver" })
    assert.deepEqual(operations("/drivers/{id}"), { get: "getDriver", patch: "patchDriver" })

    // What a caller can earn on each of them, and in what shape.
    for (const path of ["/vehicles", "/drivers"]) {
      assert.deepEqual(Object.keys(document.paths[path].get.responses), ["200", "400", "401", "403"], path)
      assert.deepEqual(Object.keys(document.paths[path].post.responses), ["201", "400", "401", "403", "409"], path)
      assert.deepEqual(Object.keys(document.paths[`${path}/{id}`].get.responses), ["200", "400", "401", "403", "404"], path)
      assert.deepEqual(Object.keys(document.paths[`${path}/{id}`].patch.responses), ["200", "400", "401", "403", "404", "409"], path)
    }
    // The set is replaced whole and nothing there can collide: positions are renumbered and a fraction twice is the body's own 400.
    assert.deepEqual(Object.keys(document.paths["/vehicles/{id}/compartments"].put.responses), ["200", "400", "401", "403", "404"])
    assert.deepEqual(document.paths["/vehicles/{id}/compartments"].put.requestBody?.content["application/json"].schema.required, ["compartments"])
    for (const [status, operation] of Object.entries(document.paths["/vehicles/{id}"].patch.responses)) {
      const media = Object.keys(operation.content)
      assert.deepEqual(media, [status === "200" ? "application/json" : "application/problem+json"], status)
    }

    // Both lists are project-scoped and take the project filter beside the page; each adds its own.
    const byName = (operation: Operation) => (operation.parameters ?? []).map((parameter) => `${parameter.in}:${parameter.name}`)
    assert.deepEqual(byName(document.paths["/vehicles"].get).sort(), ["query:cursor", "query:homeDepotId", "query:kind", "query:limit", "query:projectId", "query:status", "query:vehicleTypeId"])
    assert.deepEqual(byName(document.paths["/drivers"].get).sort(), ["query:cursor", "query:homeDepotId", "query:licenceClass", "query:limit", "query:projectId", "query:status"])
    assert.deepEqual(byName(document.paths["/vehicles/{id}/compartments"].put), ["path:id"])

    // The rules a client must know are in the prose, not only in the code.
    assert.match(document.paths["/vehicles"].post.description ?? "", /a powered vehicle has at least one, a trailer may have none/)
    assert.match(document.paths["/vehicles"].post.description ?? "", /unique across the company, not inside a project/)
    assert.match(document.paths["/vehicles"].post.description ?? "", /an unknown class passes nobody/)
    assert.match(document.paths["/vehicles"].get.description ?? "", /an account that works in none[^.]*reads an empty page/)
    assert.match(document.paths["/vehicles/{id}"].patch.description ?? "", /a powered vehicle does not become a trailer/)
    assert.match(document.paths["/vehicles/{id}"].patch.description ?? "", /refused \(409\) counting them — release the allocations, reassign the groups, and retire it then/)
    assert.match(document.paths["/vehicles/{id}/compartments"].put.description ?? "", /Replaces the whole list/)
    assert.match(document.paths["/vehicles/{id}/compartments"].put.description ?? "", /positions are 1\.\.n in the body's order/)
    assert.match(document.paths["/vehicles/{id}/compartments"].put.description ?? "", /the stored kind decides/)
    assert.match(document.paths["/drivers"].post.description ?? "", /one account is the login of at most one driver/)
    assert.match(document.paths["/drivers"].post.description ?? "", /null is not on record, which is eligible for nothing/)
    assert.match(document.paths["/drivers"].get.description ?? "", /exactly that class/)
    assert.match(document.paths["/drivers/{id}"].patch.description ?? "", /A licence renewal is an edit here/)

    // A write takes a JSON body, and it is the strict one the contracts spell.
    const required = (path: string) => document.paths[path].post.requestBody?.content["application/json"].schema.required
    assert.deepEqual(required("/vehicles"), ["projectId", "registration", "kind", "vehicleTypeId", "requiredLicenceClass"])
    assert.deepEqual(required("/drivers"), ["projectId", "name", "employment"])

    for (const path of ["/vehicles", "/drivers"]) {
      const page = document.paths[path].get.responses["200"].content["application/json"].schema
      assert.deepEqual(page.required, ["items", "nextCursor"], path)
      assert.equal(page.properties?.items.type, "array", path)
    }
  })

  test("documents /me with the problem responses a token can earn", async () => {
    const document = await spec()
    const operation = document.paths["/me"].get
    assert.equal(operation.operationId, "getMe")
    assert.deepEqual(Object.keys(operation.responses), ["200", "401", "403"])
    assert.deepEqual(schemaOf(document, "/me", "200").required, ["user", "company", "role", "projects", "serviceProvider", "driver"])
    for (const status of ["401", "403"]) {
      const content = operation.responses[status].content
      assert.deepEqual(Object.keys(content), ["application/problem+json"], status)
      assert.deepEqual(content["application/problem+json"].schema.required, ["type", "title", "status"], status)
    }
  })
})

describe("an unknown path", () => {
  test("answers a 404 problem, not Hono's text", async () => {
    const response = await app.request("/nope")
    assert.equal(response.status, 404)
    assert.deepEqual(await readProblem(response), { type: "about:blank", title: "Not Found", status: 404, detail: "No route GET /nope" })
  })

  test("a known path with the wrong method is unknown too", async () => {
    const response = await app.request("/healthz", { method: "POST" })
    assert.equal(response.status, 404)
    await readProblem(response)
  })
})
