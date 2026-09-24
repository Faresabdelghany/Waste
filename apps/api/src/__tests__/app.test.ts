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
  responses: Record<string, { content: Record<string, { schema: JsonSchema }> }>
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
    assert.equal(document.info.title, "WasteHero API")
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

  test("documents the probes and every route of the organisation and access context, and no other path", async () => {
    const document = await spec()
    assert.deepEqual(Object.keys(document.paths).sort(), [
      "/company",
      "/healthz",
      "/me",
      "/projects",
      "/projects/{id}",
      "/readyz",
      "/roles",
      "/roles/{id}",
      "/roles/{id}/grants",
      "/service-providers",
      "/service-providers/{id}",
      "/users",
      "/users/{id}",
      "/users/{id}/deactivate",
      "/users/{id}/reactivate",
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
    assert.equal(secured, 22, "/me, the ten organisation routes and the eleven access routes")
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
    assert.deepEqual(operations("/roles"), { get: "listRoles", post: "createRole" })
    assert.deepEqual(operations("/roles/{id}"), { get: "getRole", patch: "patchRole" })
    assert.deepEqual(operations("/roles/{id}/grants"), { put: "putRoleGrants" })

    // What a caller can earn on each of them, and in what shape.
    assert.deepEqual(Object.keys(document.paths["/users"].get.responses), ["200", "400", "401", "403"])
    assert.deepEqual(Object.keys(document.paths["/users"].post.responses), ["201", "400", "401", "403", "409"])
    assert.deepEqual(Object.keys(document.paths["/users/{id}"].patch.responses), ["200", "400", "401", "403", "404", "409"])
    assert.deepEqual(Object.keys(document.paths["/users/{id}/deactivate"].post.responses), ["200", "400", "401", "403", "404", "409"])
    assert.deepEqual(Object.keys(document.paths["/users/{id}/reactivate"].post.responses), ["200", "400", "401", "403", "404"])
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
