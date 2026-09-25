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
  responses: Record<string, { content: Record<string, { schema: JsonSchema }>; headers?: Record<string, { description?: string; schema?: JsonSchema }> }>
}
type Spec = {
  openapi: string
  info: { title: string; version: string }
  paths: Record<string, Record<string, Operation>>
  components?: { securitySchemes?: Record<string, unknown> }
}

const spec = async () => (await (await app.request("/openapi.json")).json()) as Spec
const schemaOf = (spec: Spec, path: string, status: string) => spec.paths[path].get.responses[status].content["application/json"].schema
const spec_ = (spec: Spec) => spec.paths["/readyz"].get.description ?? ""

describe("GET /healthz", () => {
  test("answers ok with the server's clock, as JSON", async () => {
    const response = await app.request("/healthz")
    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-type") ?? "", /^application\/json/)
    assert.deepEqual(HealthResponse.parse(await response.json()), { status: "ok", time: "2026-09-17T13:41:00.000Z" })
  })
})

describe("GET /readyz", () => {
  test("answers 200 ok when the database answers", { skip: database.skip }, async () => {
    const connected = createDb(database.url, probePoolOptions())
    try {
      const response = await createApp({ ...deps, probe: connected }).request("/readyz")
      assert.equal(response.status, 200)
      assert.match(response.headers.get("content-type") ?? "", /^application\/json/)
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

  test("documents the probes and every route of the organisation, access, registry and planning contexts, and no other path", async () => {
    const document = await spec()
    assert.deepEqual(Object.keys(document.paths).sort(), [
      "/agreements",
      "/agreements/{id}",
      "/agreements/{id}/subscriptions",
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
      "/containers/{id}/placements",
      "/customers",
      "/customers/{id}",
      "/healthz",
      "/me",
      "/placements",
      "/placements/{id}",
      "/planning-area-boundaries",
      "/planning-area-boundaries/{id}",
      "/planning-areas",
      "/planning-areas/{id}",
      "/planning-areas/{id}/boundaries",
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
      "/route-schemes/{id}/occurrences",
      "/service-frequencies",
      "/service-frequencies/{id}",
      "/service-providers",
      "/service-providers/{id}",
      "/shared-collection-points",
      "/shared-collection-points/{id}",
      "/shared-collection-points/{id}/members",
      "/subscriptions/{id}",
      "/users",
      "/users/{id}",
      "/users/{id}/deactivate",
      "/users/{id}/make-primary-administrator",
      "/users/{id}/reactivate",
      "/waste-fractions",
      "/waste-fractions/{id}",
    ])
    assert.equal(document.paths["/healthz"].get.operationId, "getHealth")
    const health = schemaOf(document, "/healthz", "200")
    assert.deepEqual(health.required, ["status", "time"])
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
      99,
      "/me, the ten organisation routes, the twelve access routes, the fifty-one registry routes — waste fractions, container types, service frequencies, products and customers, four each; properties, property groups and shared collection points, five each, the four plus the route that replaces the set travelling with the record; and the two effective-dated families, eight each, agreements with their subscriptions and containers with their placements — and the twenty-five planning routes of part A: planning areas with their boundary versions, nine, collection calendars with their holidays, five, route schemes with the occurrence read, five, and collection groups with their two set replacements, six",
    )
  })

  test("declares the Location header on every 201 and Location on nothing else: a create says where the row is now read, a command or a set replacement does not", async () => {
    const document = await spec()
    let creates = 0
    for (const [path, operations] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        for (const [status, response] of Object.entries(operation.responses)) {
          const location = response.headers?.Location
          const where = `${method.toUpperCase()} ${path} ${status}`
          if (status === "201") {
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
    assert.equal(
      creates,
      21,
      "the twenty-one creates: projects, service providers, users and roles; waste fractions, container types, service frequencies, products, customers, properties, property groups, shared collection points, agreements and containers; the two nested ones, a subscription under its agreement and a placement under its container; and Planning's five — planning areas and, under an area, boundary versions, collection calendars, route schemes and, under a scheme, collection groups",
    )
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
    assert.match(document.paths["/route-schemes"].post.description ?? "", /read-only until #101's slice 6/)
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

  test("documents /me with the problem responses a token can earn", async () => {
    const document = await spec()
    const operation = document.paths["/me"].get
    assert.equal(operation.operationId, "getMe")
    assert.deepEqual(Object.keys(operation.responses), ["200", "401", "403"])
    assert.deepEqual(schemaOf(document, "/me", "200").required, ["user", "company", "role", "projects", "serviceProvider"])
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
