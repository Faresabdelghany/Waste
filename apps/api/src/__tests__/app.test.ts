import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { Validator } from "@seriousme/openapi-schema-validator"
import { HealthResponse } from "@waste/contracts/health"

import manifest from "../../package.json" with { type: "json" }
import { createApp } from "../app"

const at = new Date("2026-09-17T13:41:00Z")
const app = createApp({ now: () => at })

/** The parts of the document these tests read; the validator checks the whole. */
type Spec = {
  openapi: string
  info: { title: string; version: string }
  paths: Record<
    string,
    {
      get: {
        operationId: string
        responses: Record<
          string,
          { content: Record<string, { schema: { required: string[]; properties: Record<string, Record<string, unknown>> } }> }
        >
      }
    }
  >
}

const spec = async () => (await (await app.request("/openapi.json")).json()) as Spec

describe("GET /healthz", () => {
  test("answers ok with the server's clock, as JSON", async () => {
    const response = await app.request("/healthz")
    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-type") ?? "", /^application\/json/)
    assert.deepEqual(HealthResponse.parse(await response.json()), { status: "ok", time: "2026-09-17T13:41:00.000Z" })
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

  test("documents /healthz with the health response schema, and no other path", async () => {
    const document = await spec()
    assert.deepEqual(Object.keys(document.paths), ["/healthz"])
    const operation = document.paths["/healthz"].get
    assert.equal(operation.operationId, "getHealth")
    const schema = operation.responses["200"].content["application/json"].schema
    assert.deepEqual(schema.required, ["status", "time"])
    assert.deepEqual(schema.properties.status, { type: "string", const: "ok" })
    assert.equal(schema.properties.time.format, "date-time")
  })
})
