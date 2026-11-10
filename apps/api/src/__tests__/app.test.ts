import assert from "node:assert/strict"
import { after, describe, test } from "node:test"

import { Validator } from "@seriousme/openapi-schema-validator"
import { HealthResponse, ReadinessResponse } from "@waste/contracts/health"
import { createDb } from "@waste/db/client"
import { probePoolOptions } from "@waste/db/probe"
import { DRIVER_COMMAND_KINDS } from "@waste/domain/execution/vocabulary"
import { REPORT_WINDOW_MAX_DAYS } from "@waste/domain/insight/reports"
import { REFUSED_URL } from "@waste/tooling/unreachable"

import manifest from "../../package.json" with { type: "json" }
import { createApp } from "../app"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { neverVerifies } from "./tokens"

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

/** The order an operation's lines take under one path. */
const METHODS = ["get", "post", "put", "patch", "delete"]

// `t.assert.snapshot`, stable since Node 22.13 (the root `engines`), which the installed @types/node (22.0) does not declare yet.
declare module "node:test" {
  interface TestContext {
    readonly assert: { snapshot(value: unknown, options?: { serializers?: ((value: unknown) => unknown)[] }): void }
  }
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

  test("documents the operations the snapshot lists, each with its security and its answers, and no other", async (t) => {
    // One line per operation, sorted, so two branches that each add a route
    // add a line each and merge: the method and path, the operationId, the
    // bearer requirement or none (the probes and the public door's reads),
    // and every status it answers, a 201 marked where it declares Location —
    // a create says where the row is now read; an append to a ledger, a
    // command or a set replacement does not. A route added, removed or
    // re-described is a change here: run this file with
    // `--test-update-snapshots` and read the diff.
    const document = await spec()
    const lines: { path: string; method: string; line: string }[] = []
    for (const [path, operations] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        const security = operation.security === undefined ? "open" : JSON.stringify(operation.security) === JSON.stringify([{ bearerAuth: [] }]) ? "bearer" : JSON.stringify(operation.security)
        const answers = Object.entries(operation.responses).map(([status, response]) => (response.headers?.Location === undefined ? status : `${status}+Location`))
        lines.push({ path, method, line: `${method.toUpperCase()} ${path} ${operation.operationId} ${security} ${answers.join(" ")}` })
      }
    }
    const byPath = lines.sort((a, b) => (a.path === b.path ? METHODS.indexOf(a.method) - METHODS.indexOf(b.method) : a.path < b.path ? -1 : 1))
    t.assert.snapshot(byPath.map(({ line }) => line).join("\n"), { serializers: [String] })
  })

  test("declares Location on a 201 alone, saying what it names, and only a POST answers one", async () => {
    const document = await spec()
    for (const [path, operations] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        for (const [status, response] of Object.entries(operation.responses)) {
          const location = response.headers?.Location
          const where = `${method.toUpperCase()} ${path} ${status}`
          if (status === "201") assert.equal(method, "post", `${where}: only a POST creates or appends`)
          if (location === undefined) continue
          assert.equal(status, "201", `${where} declares no Location`)
          assert.equal(location.schema?.type, "string", where)
          assert.match(location.description ?? "", /\S/, `${where}: Location says what it names`)
        }
      }
    }
  })

  test("registers a static segment before a parameter that would catch it: `/routes/live` before `/routes/:id`", () => {
    // Hono runs a path's handlers in registration order, so `/routes/:id`
    // registered first would answer `/routes/live` with its 400.
    const registered = [...new Map(app.routes.filter((route) => route.method !== "ALL").map((route) => [`${route.method} ${route.path}`, route])).values()]
    for (const [index, later] of registered.entries()) {
      const segments = later.path.split("/")
      for (const earlier of registered.slice(0, index)) {
        if (earlier.method !== later.method || earlier.path === later.path) continue
        const pattern = earlier.path.split("/")
        const catches = pattern.length === segments.length && pattern.every((segment, at) => segment === segments[at] || segment.startsWith(":"))
        assert.equal(catches, false, `${later.method} ${later.path} is registered after ${earlier.path}, which answers it first`)
      }
    }
  })

  test("documents /healthz's body: the status, the clock and the build", async () => {
    const document = await spec()
    const health = schemaOf(document, "/healthz", "200")
    assert.deepEqual(health.required, ["status", "time", "build"])
    assert.deepEqual(health.properties?.status, { type: "string", const: "ok" })
    assert.equal(health.properties?.time.format, "date-time")
  })

  test("documents /readyz with one body per outcome: 200 ready, 503 unavailable, each naming its check", async () => {
    const document = await spec()
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

  test("documents each alert route with its verbs, its problems and the rules a client must know (Issue #109)", async () => {
    const document = await spec()
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
      "query:outboundLoadId",
      "query:projectId",
      "query:routeId",
      "query:rule",
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
    assert.match(raise, /The raise writes `alert-raised` to the outbox with the alert as answered/)
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
    const refuseClosed = ["assign", "start", "wait", "hold", "complete", "reject"]
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
      "query:overdue",
      "query:pickupId",
      "query:priority",
      "query:projectId",
      "query:propertyId",
      "query:routeId",
      "query:source",
      "query:status",
      "query:teamId",
      "query:ticketTypeId",
      "query:to",
      "query:unassigned",
    ])
    assert.deepEqual(byName(document.paths["/tickets/{id}/events"].get).sort(), ["path:id", "query:cursor", "query:kind", "query:limit", "query:visibility"])
    assert.deepEqual(byName(document.paths["/tickets/{id}/start"].post), ["path:id"])

    // A write takes the strict body the contracts spell: what must be given, and nothing the server owns.
    const required = (path: string, method: "post" | "patch" = "post") => document.paths[path][method].requestBody?.content["application/json"].schema.required
    assert.deepEqual(required("/tickets"), ["projectId", "subject", "description"], "priority and source have defaults, and a type or a kind is a rule (#545 of #544)")
    assert.equal(required("/tickets/{id}", "patch"), undefined, "a patch names no member as required: at least one is a rule, not a member")
    assert.deepEqual(required("/tickets/{id}/assign"), ["assigneeUserAccountId"])
    assert.equal(required("/tickets/{id}/start"), undefined)
    assert.deepEqual(required("/tickets/{id}/wait"), ["note"])
    assert.deepEqual(required("/tickets/{id}/hold"), ["note"])
    assert.deepEqual(required("/tickets/{id}/complete"), ["resolution", "note"])
    assert.deepEqual(required("/tickets/{id}/reject"), ["reason"])
    assert.deepEqual(required("/tickets/{id}/reopen"), ["note"])
    assert.deepEqual(required("/tickets/{id}/comments"), ["body"])
    assert.equal(required("/tickets/{id}/reply-with-evidence"), undefined, "the reply's words are the record's; the note and the completion are optional")

    // The rules a client must know are in the prose, not only in the code.
    const list = document.paths["/tickets"].get.description ?? ""
    assert.match(list, /for a Service Provider's account, which works in none, the tickets about a route its provider runs/)
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

  test("documents the four reports with their strict windows, their filters and their grants (#292)", async () => {
    const document = await spec()
    const byName = (operation: Operation) => (operation.parameters ?? []).map((parameter) => `${parameter.in}:${parameter.name}`)
    const window = ["query:from", "query:interval", "query:projectId", "query:to"]
    assert.deepEqual(byName(document.paths["/reports/service"].get).sort(), [...window, "query:routeSchemeId", "query:wasteFractionId"].sort())
    assert.deepEqual(byName(document.paths["/reports/tickets"].get).sort(), window)
    assert.deepEqual(byName(document.paths["/reports/revenue"].get).sort(), window)
    assert.deepEqual(byName(document.paths["/reports/tonnage"].get).sort(), [...window, "query:unloadingStationId", "query:wasteFractionId"].sort())

    // Two grants each: the Improve module it is read in, and the module whose rows it counts.
    for (const [path, improve, rows] of [
      ["/reports/service", "improve.performance", "route-studio.routes"],
      ["/reports/tickets", "improve.performance", "operate.tickets"],
      ["/reports/revenue", "improve.analytics", "commercial.invoices"],
      ["/reports/tonnage", "improve.analytics", "route-studio.weights"],
    ] as const) {
      const operation = document.paths[path].get
      assert.ok((operation.responses["403"].description ?? "").includes(`\`view\` on \`${improve}\` and \`view\` on \`${rows}\``), path)
      assert.ok((operation.description ?? "").includes(`at most ${REPORT_WINDOW_MAX_DAYS} days`), path)
      assert.match(operation.description ?? "", /a parameter this report does not read is refused by name/, path)
    }
  })

  test("documents the driver door with its verbs, its problems and the rules a device must know (Issue #104, slice 4)", async () => {
    const document = await spec()
    for (const [status, operation] of Object.entries(document.paths["/driver/commands"].post.responses)) {
      assert.deepEqual(Object.keys(operation.content), [status === "200" ? "application/json" : "application/problem+json"], `POST /driver/commands ${status}`)
    }

    const byName = (operation: Operation) => (operation.parameters ?? []).map((parameter) => `${parameter.in}:${parameter.name}`)
    assert.deepEqual(byName(document.paths["/driver/routes"].get).sort(), ["query:cursor", "query:limit", "query:status"])
    assert.deepEqual(byName(document.paths["/driver/commands"].get).sort(), ["query:cursor", "query:limit", "query:routeId"])
    assert.deepEqual(byName(document.paths["/driver/routes/{id}"].get), ["path:id"])
    assert.deepEqual(byName(document.paths["/driver/routes/{id}/identify"].get).sort(), ["path:id", "query:code"])

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
    assert.match(document.paths["/driver/routes/{id}"].get.description ?? "", /the container's `label` \(null on an address-only stop the office added, which names no container\) and the waste fraction's `name`/)
    const door = document.paths["/driver/commands"].post.description ?? ""
    // The kinds it counts are the vocabulary's, every one of them named.
    assert.match(door, new RegExp(`The ${DRIVER_COMMAND_KINDS.length} kinds and their bodies`))
    for (const kind of DRIVER_COMMAND_KINDS) assert.match(door, new RegExp(`\`${kind}\``), kind)
    assert.match(door, /applied in body order, each in its own savepoint/)
    assert.match(door, /`replayed` with the first outcome for an id this driver's devices already sent \(nothing written/)
    assert.match(door, /An id that another device's command already holds .* is refused \(409, `That command id belongs to another device's command`\) and never replayed/)
    assert.match(door, /two of the driver's routes started at once, each batch under its own route's lock, meet on the one-live-session-per-driver index/)
    assert.match(door, /a route-level `report-problem`'s `route-problem-reported` the route with its problem proof as `proofs`/)
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
    for (const [path, method] of [["/projects/{id}", "patch"], ["/service-providers/{id}", "get"]] as const) {
      for (const [status, operation] of Object.entries(document.paths[path][method].responses)) {
        const media = Object.keys(operation.content)
        assert.deepEqual(media, [status === "200" ? "application/json" : "application/problem+json"], `${method} ${path} ${status}`)
      }
    }

    const page = document.paths["/projects"].get.responses["200"].content["application/json"].schema
    assert.deepEqual(page.required, ["items", "nextCursor"])
    assert.equal(page.properties?.items.type, "array")

    const byName = (operation: Operation) => (operation.parameters ?? []).map((parameter) => `${parameter.in}:${parameter.name}`)
    assert.deepEqual(byName(document.paths["/projects/{id}"].get), ["path:id"])
    assert.deepEqual(byName(document.paths["/projects"].get).sort(), ["query:cursor", "query:limit"])

    // A write takes a JSON body, and it is the strict one the contracts spell.
    const body = document.paths["/projects"].post.requestBody?.content["application/json"].schema
    assert.deepEqual(body?.required, ["name", "kind", "language", "currency", "timezone"])
  })

  test("documents each access route with its verbs, its problems and its page of items", async () => {
    const document = await spec()
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
    // A system role's scope and matrix are the platform's, which every seed restores (#291).
    assert.match(document.paths["/roles/{id}"].patch.description ?? "", /another scope on a system role is refused \(409\)/)
    assert.match(document.paths["/roles/{id}/grants"].put.description ?? "", /A system role's matrix is the platform's, which every seed restores to the charter, so replacing it is refused \(409\)/)
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
    assert.match(document.paths["/collection-calendars"].post.description ?? "", /A calendar carries no holidays: a project's are the days of the company's holiday list it names/)
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
    for (const [path, set] of [
      ["/properties/{id}/parties", "parties"],
      ["/property-groups/{id}/members", "members"],
      ["/shared-collection-points/{id}/members", "members"],
    ] as const) {
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
    assert.match(document.paths["/properties/{id}/parties"].put.description ?? "", /Replaces the list in force today/)
    assert.match(document.paths["/property-groups/{id}/members"].put.description ?? "", /a property of the group's own project/)
    assert.match(document.paths["/shared-collection-points"].post.description ?? "", /the place is the record/)

    // A write takes a JSON body, and it is the strict one the contracts spell.
    const required = (path: string) => document.paths[path].post.requestBody?.content["application/json"].schema.required
    assert.deepEqual(required("/waste-fractions"), ["key", "name"])
    assert.deepEqual(required("/container-types"), ["name"])
    assert.deepEqual(required("/service-frequencies"), ["projectId", "name"])
    assert.deepEqual(required("/products"), ["projectId", "name", "kind", "unit"])
    assert.deepEqual(required("/customers"), ["kind", "name"])
    // The address is typed or the register's (#291 C13): the body names one of the two, which the schema's refinement holds.
    assert.deepEqual(required("/properties"), ["projectId", "name", "kind"])
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
    assert.deepEqual(byName(document.paths["/containers"].get).sort(), ["query:assetStatus", "query:containerTypeId", "query:cursor", "query:identifier", "query:limit", "query:projectId", "query:warehouseId"])
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
    assert.deepEqual(required("/containers/{id}/placements"), ["wasteFractionId", "validFrom"], "a subscription or a public placement's point, exactly one (M12 of #293)")

    for (const path of ["/agreements", "/agreements/{id}/subscriptions", "/containers", "/placements"]) {
      const page = document.paths[path].get.responses["200"].content["application/json"].schema
      assert.deepEqual(page.required, ["items", "nextCursor"], path)
      assert.equal(page.properties?.items.type, "array", path)
    }
  })

  test("documents each route of the container ledger with its verbs, its problems and the rules a client must know (Issue #101, slice 5)", async () => {
    const document = await spec()
    for (const verb of ["receive", "return", "transfer", "decommission", "adjust"]) {
      for (const [status, operation] of Object.entries(document.paths[`/containers/{id}/${verb}`].post.responses)) {
        assert.deepEqual(Object.keys(operation.content), [status === "201" ? "application/json" : "application/problem+json"], `${verb} ${status}`)
      }
    }

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
    assert.deepEqual(required("/containers/{id}/decommission"), ["decommissionReasonId"])
    assert.deepEqual(required("/containers/{id}/adjust"), ["toKind", "reason"])
    assert.deepEqual(required("/containers/{id}/placements"), ["wasteFractionId", "validFrom"], "a subscription or a public placement's point, exactly one (M12 of #293)")
    assert.ok(Object.keys(document.paths["/containers/{id}/placements"].post.requestBody?.content["application/json"].schema.properties ?? {}).includes("occurredAt"))

    for (const path of ["/containers/{id}/movements", "/stock-movements"]) {
      const page = document.paths[path].get.responses["200"].content["application/json"].schema
      assert.deepEqual(page.required, ["items", "nextCursor"], path)
      assert.equal(page.properties?.items.type, "array", path)
    }
  })

  test("documents each planning route of slice 4 with its verbs, its problems and the rules a client must know", async () => {
    const document = await spec()
    const byName = (operation: Operation) => (operation.parameters ?? []).map((parameter) => `${parameter.in}:${parameter.name}`)
    assert.deepEqual(byName(document.paths["/route-schemes"].get).sort(), [
      "query:archived",
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
    const generate = document.paths["/route-schemes/{id}/generate"].post
    assert.deepEqual(generate.requestBody?.content["application/json"].schema.required, ["from", "to"])

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
    for (const [path, set] of [
      ["/vehicle-types/{id}/container-types", "containerTypeIds"],
      ["/unloading-stations/{id}/fractions", "wasteFractionIds"],
    ] as const) {
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

  test("documents absences and unavailability (O6 of #290) with their verbs, the one removal answering 204, and the commands that refuse a crew away", async () => {
    const document = await spec()
    for (const path of ["/driver-absences", "/vehicle-unavailability"]) {
      assert.match(document.paths[path].post.description ?? "", /Never refused for the work already planned on its days/, path)
      assert.match(document.paths[path].post.description ?? "", /`validTo` the first day back/, path)
    }
    const required = (path: string) => document.paths[path].post.requestBody?.content["application/json"].schema.required
    assert.deepEqual(required("/driver-absences"), ["driverId", "reason", "validFrom"])
    assert.deepEqual(required("/vehicle-unavailability"), ["vehicleId", "reason", "validFrom"])

    // The commands that name a crew afresh say they refuse one away, in the prose a client reads.
    assert.match(document.paths["/routes"].post.description ?? "", /a vehicle out of use or a driver absent on the operating date \(O6 of #290\)/)
    assert.match(document.paths["/routes/{id}/assign"].post.description ?? "", /A vehicle or trailer out of use, or a driver absent, on the operating date/)
    assert.match(document.paths["/routes/{id}/dispatch"].post.description ?? "", /A planned driver absent, or a planned vehicle or trailer out of use, on the operating date/)
    assert.match(document.paths["/routes/{id}/reschedule"].post.description ?? "", /on the new day \(O6 of #290\)/)
    assert.match(document.paths["/vehicle-allocations"].post.description ?? "", /whether each is there over the window's days on the project's clock/)
    for (const [path, method] of [["/route-schemes", "post"], ["/route-schemes/{id}/collection-groups", "post"], ["/collection-groups/{id}", "patch"]] as const) {
      assert.match(document.paths[path][method].description ?? "", /a group recurs, so a period on a later day refuses nothing/, path)
    }
  })

  test("documents each fleet route with its verbs, its problems and the rules a client must know", async () => {
    const document = await spec()
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
    assert.match(document.paths["/vehicles"].get.description ?? "", /for a Service Provider's account, which works in none, the vehicles its provider owns, wherever they are based/)
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
