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

  test("documents /healthz, /readyz and /me, and no other path", async () => {
    const document = await spec()
    assert.deepEqual(Object.keys(document.paths).sort(), ["/healthz", "/me", "/readyz"])
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
    assert.ok(secured >= 1, "GET /me is in the document")
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
