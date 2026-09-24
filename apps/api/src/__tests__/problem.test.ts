import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { PageRequest } from "@waste/contracts/pagination"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import * as z from "zod"

import { errorHandler, notFound, problem, ProblemError, problemResponse, validate } from "../problem"
import { readProblem } from "./read-problem"

/** A log that remembers what it was given. */
const recorder = () => {
  const entries: unknown[] = []
  return { entries, log: (error: unknown) => void entries.push(error) }
}

describe("problem", () => {
  test("is a throwable carrying the status, the reason phrase as title, and the detail", async () => {
    const raised = problem(404, { detail: "No project here" })
    assert.ok(raised instanceof ProblemError)
    assert.ok(raised instanceof HTTPException, "Hono's own default handler would still answer it with its status")
    assert.equal(raised.status, 404)
    assert.deepEqual(raised.body, { type: "about:blank", title: "Not Found", status: 404, detail: "No project here" })
    const body = await readProblem(raised.getResponse())
    assert.deepEqual(body, raised.body)
  })

  test("says nothing about a 500 beyond its status", async () => {
    assert.deepEqual(problem(500).body, { type: "about:blank", title: "Internal Server Error", status: 500 })
    assert.deepEqual((await readProblem(problem(500).getResponse())).detail, undefined)
  })

  test("carries the field errors of a 400 and the headers a 401 needs", async () => {
    const invalid = problem(400, { detail: "The request body is invalid", errors: [{ path: "name", message: "Required" }] })
    assert.deepEqual(invalid.body.errors, [{ path: "name", message: "Required" }])
    const unauthorized = problem(401, { detail: "No token", headers: { "www-authenticate": "Bearer" } })
    const response = unauthorized.getResponse()
    assert.equal(response.headers.get("www-authenticate"), "Bearer")
    assert.equal((await readProblem(response)).title, "Unauthorized")
  })

  test("spells every title as the status's reason phrase", () => {
    assert.equal(problem(403).body.title, "Forbidden")
    assert.equal(problem(409).body.title, "Conflict")
    assert.equal(problem(413).body.title, "Payload Too Large")
    assert.equal(problem(503).body.title, "Service Unavailable")
  })

  test("problemResponse is the same body as a Response, for a place that answers instead of throwing", async () => {
    const response = problemResponse(404, { detail: "No such route" })
    assert.equal(response.status, 404)
    assert.deepEqual(await readProblem(response), { type: "about:blank", title: "Not Found", status: 404, detail: "No such route" })
  })
})

describe("errorHandler", () => {
  const app = (log: (error: unknown) => void) => {
    const hono = new Hono().onError(errorHandler(log))
    hono.get("/problem", () => {
      throw problem(409, { detail: "A project with this name exists" })
    })
    hono.get("/hono", () => {
      throw new HTTPException(413, { message: "Body too large" })
    })
    hono.get("/hono-silent", () => {
      throw new HTTPException(429)
    })
    hono.get("/duplicate", () => {
      const cause = Object.assign(new Error('duplicate key value violates unique constraint "project_name_key"'), {
        code: "23505",
        constraint_name: "project_name_key",
      })
      throw new Error("Failed query: insert into ...", { cause })
    })
    hono.get("/duplicate-bare", () => {
      throw Object.assign(new Error("duplicate key value"), { code: "23505" })
    })
    hono.get("/other-sqlstate", () => {
      throw new Error("Failed query", { cause: Object.assign(new Error("fk"), { code: "23503" }) })
    })
    hono.get("/boom", () => {
      throw new Error("the database ate my query: postgresql://wms_api:secret@host/db")
    })
    // What a failed `POST /users` looks like when the database refuses it for
    // a reason that is nobody's business on the wire: Drizzle's wrapper over
    // a postgres.js error, which carries the statement and everything the
    // route bound into it.
    hono.get("/with-parameters", () => {
      const cause = Object.assign(new Error("insert or update on table violates foreign key constraint"), {
        code: "23503",
        constraint_name: "user_account_role_id_fk",
        query: "insert into wms.user_account (id, company_id, email, full_name) values ($1, $2, $3, $4)",
        parameters: ["01a0d3a5-e5e0-7000-8000-000000000001", "01a0d3a5-e5e0-7000-8000-000000000002", "invitee@example.com", "Invited Person"],
      })
      throw new Error("Failed query: insert into wms.user_account ...", { cause })
    })
    return hono
  }

  test("answers a thrown problem with its own response", async () => {
    const { entries, log } = recorder()
    const response = await app(log).request("/problem")
    assert.equal(response.status, 409)
    assert.deepEqual(await readProblem(response), { type: "about:blank", title: "Conflict", status: 409, detail: "A project with this name exists" })
    assert.deepEqual(entries, [], "a problem the code raised on purpose is not logged")
  })

  test("turns one of Hono's own exceptions into a problem of its status, the message as detail when there is one", async () => {
    const { log } = recorder()
    const large = await app(log).request("/hono")
    assert.equal(large.status, 413)
    assert.deepEqual(await readProblem(large), { type: "about:blank", title: "Payload Too Large", status: 413, detail: "Body too large" })
    const silent = await app(log).request("/hono-silent")
    assert.deepEqual(await readProblem(silent), { type: "about:blank", title: "Too Many Requests", status: 429 })
  })

  test("maps a unique violation (SQLSTATE 23505) to 409, through Drizzle's wrapper or bare, naming the constraint when Postgres does", async () => {
    const { entries, log } = recorder()
    const wrapped = await app(log).request("/duplicate")
    assert.equal(wrapped.status, 409)
    const body = await readProblem(wrapped)
    assert.equal(body.title, "Conflict")
    assert.match(body.detail ?? "", /project_name_key/)
    const bare = await app(log).request("/duplicate-bare")
    assert.equal(bare.status, 409)
    assert.equal((await readProblem(bare)).detail?.includes("project_name_key"), false)
    assert.deepEqual(entries, [], "a conflict is the client's news, not the operator's")
  })

  test("answers 500 with no detail for anything else, and logs the error once", async () => {
    const { entries, log } = recorder()
    const response = await app(log).request("/boom")
    assert.equal(response.status, 500)
    const body = await readProblem(response)
    assert.deepEqual(body, { type: "about:blank", title: "Internal Server Error", status: 500 })
    assert.equal(JSON.stringify(body).includes("secret"), false, "what the error said stays in the log")
    assert.equal(entries.length, 1)
    const logged = entries[0] as Record<string, unknown>
    assert.equal(logged.name, "Error")
    assert.match(String(logged.message), /ate my query/)
    assert.match(String(logged.stack), /ate my query/)
    const other = await app(log).request("/other-sqlstate")
    assert.equal(other.status, 500, "only 23505 has a meaning on the wire so far")
    assert.equal(entries.length, 2)
  })

  test("logs a projection of a database error: its name, message, SQLSTATE, constraint and stack, never the statement or its parameters", async () => {
    const { entries, log } = recorder()
    const response = await app(log).request("/with-parameters")
    assert.equal(response.status, 500)
    assert.deepEqual(await readProblem(response), { type: "about:blank", title: "Internal Server Error", status: 500 })
    assert.equal(entries.length, 1)
    const logged = entries[0] as Record<string, unknown>
    assert.deepEqual(Object.keys(logged).sort(), ["cause", "message", "name", "stack"])
    const cause = logged.cause as Record<string, unknown>
    assert.deepEqual(Object.keys(cause).sort(), ["code", "constraint_name", "message", "name", "stack"])
    assert.equal(cause.code, "23503")
    assert.equal(cause.constraint_name, "user_account_role_id_fk")
    const printed = JSON.stringify(entries)
    assert.equal(printed.includes("invitee@example.com"), false, "an invitee's address is not the operator's to keep")
    assert.equal(printed.includes("Invited Person"), false)
    assert.equal(printed.includes("values ($1"), false, "nor is the statement the route sent")
  })
})

describe("notFound", () => {
  test("answers an unknown path with a problem naming the method and path", async () => {
    const hono = new Hono().notFound(notFound)
    const response = await hono.request("/nowhere/at/all", { method: "DELETE" })
    assert.equal(response.status, 404)
    assert.deepEqual(await readProblem(response), { type: "about:blank", title: "Not Found", status: 404, detail: "No route DELETE /nowhere/at/all" })
  })
})

describe("validate", () => {
  const Body = z.object({
    name: z.string().min(1),
    projectIds: z.array(z.uuidv7()),
    contact: z.object({ email: z.email() }).optional(),
  })
  const hono = new Hono().onError(errorHandler(() => assert.fail("nothing here is a 500")))
  hono.post("/things", validate("json", Body), (c) => c.json(c.req.valid("json"), 201))
  hono.get("/things", validate("query", PageRequest), (c) => c.json(c.req.valid("query")))

  const post = (body: unknown) =>
    hono.request("/things", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } })

  test("lets a valid body through, parsed", async () => {
    const response = await post({ name: "Copenhagen Central", projectIds: ["0192b3d4-5e6f-7a8b-9c0d-1e2f3a4b5c6d"], extra: "dropped" })
    assert.equal(response.status, 201)
    assert.deepEqual(await response.json(), { name: "Copenhagen Central", projectIds: ["0192b3d4-5e6f-7a8b-9c0d-1e2f3a4b5c6d"] })
  })

  test("answers 400 with one error per field, each with its dotted path and zod's message", async () => {
    const response = await post({ name: "", projectIds: ["0192b3d4-5e6f-7a8b-9c0d-1e2f3a4b5c6d", "not-an-id"], contact: { email: "nope" } })
    assert.equal(response.status, 400)
    const body = await readProblem(response)
    assert.equal(body.detail, "The request body is invalid")
    assert.deepEqual(
      body.errors?.map((error) => error.path),
      ["name", "projectIds.1", "contact.email"],
    )
    for (const error of body.errors ?? []) assert.ok(error.message.length > 0)
  })

  test("names the target as a whole with an empty path when the body is not even the right kind of thing", async () => {
    const response = await post("just a string")
    assert.equal(response.status, 400)
    const body = await readProblem(response)
    assert.deepEqual(body.errors?.map((error) => error.path), [""])
  })

  test("validates a query the same way, with its own wording", async () => {
    const ok = await hono.request("/things?limit=25")
    assert.deepEqual(await ok.json(), { limit: 25 })
    const bad = await hono.request("/things?limit=abc")
    assert.equal(bad.status, 400)
    const body = await readProblem(bad)
    assert.equal(body.detail, "The request query is invalid")
    assert.deepEqual(body.errors?.map((error) => error.path), ["limit"])
  })
})
