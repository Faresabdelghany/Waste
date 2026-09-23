import assert from "node:assert/strict"
import { after, describe, test } from "node:test"

import { Validator } from "@seriousme/openapi-schema-validator"
import { HealthResponse, ReadinessResponse } from "@waste/contracts/health"
import { createDb } from "@waste/db/client"

import manifest from "../../package.json" with { type: "json" }
import { createApp } from "../app"
import { probePoolOptions } from "../readiness"
import { databaseUnderTest } from "./database"
import { REFUSED_URL } from "./unreachable"

const at = new Date("2026-09-17T13:41:00Z")
const database = databaseUnderTest()

/** A pool nothing connects to: /healthz and /openapi.json ask nothing of the database. */
const idle = createDb(REFUSED_URL, { max: 1 })
after(() => idle.close())
const app = createApp({ now: () => at, probe: idle })

/** The parts of the document these tests read; the validator checks the whole. */
type JsonSchema = {
  type?: string
  const?: unknown
  format?: string
  required?: string[]
  properties?: Record<string, JsonSchema>
}
type Spec = {
  openapi: string
  info: { title: string; version: string }
  paths: Record<
    string,
    {
      get: {
        operationId: string
        description?: string
        responses: Record<string, { content: Record<string, { schema: JsonSchema }> }>
      }
    }
  >
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
      const response = await createApp({ probe: connected }).request("/readyz")
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
      const response = await createApp({ probe: refused }).request("/readyz")
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
      const down = createApp({ probe: refused })
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

  test("documents /healthz and /readyz, and no other path", async () => {
    const document = await spec()
    assert.deepEqual(Object.keys(document.paths), ["/healthz", "/readyz"])
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
    const shorter = createApp({ probe: idle, databaseTimeoutMs: 500 })
    const document = (await (await shorter.request("/openapi.json")).json()) as Spec
    assert.match(spec_(document), /within 500 ms/)
  })
})
