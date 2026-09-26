import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { PageRequest } from "@waste/contracts/pagination"
import { refused, RefusedField } from "@waste/db/commands/shared"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import * as z from "zod"

import { checkConstraintOf, errorHandler, exclusionConstraintOf, membersAt, notFound, problem, ProblemError, problemResponse, uniqueConstraintOf, validate } from "../problem"
import { refuseCheck, refuseDuplicate, refuseOverlap } from "../routes/shared"
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
    hono.get("/refused", () => {
      throw refused(409, "This alert is linked to ticket T-8831; an alert links to one ticket")
    })
    hono.get("/refused-field", () => {
      throw new RefusedField("alertId", "Not an alert of this project")
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
    hono.get("/overlap", () => {
      const cause = Object.assign(new Error('conflicting key value violates exclusion constraint "subscription_no_overlap"'), {
        code: "23P01",
        constraint_name: "subscription_no_overlap",
      })
      throw new Error("Failed query: insert into ...", { cause })
    })
    hono.get("/overlap-bare", () => {
      throw Object.assign(new Error("conflicting key value"), { code: "23P01" })
    })
    hono.get("/other-sqlstate", () => {
      throw new Error("Failed query", { cause: Object.assign(new Error("fk"), { code: "23503" }) })
    })
    hono.get("/check", () => {
      const cause = Object.assign(new Error('new row for relation "planning_area_boundary" violates check constraint "planning_area_boundary_boundary_valid"'), {
        code: "23514",
        constraint_name: "planning_area_boundary_boundary_valid",
      })
      throw new Error("Failed query: insert into ...", { cause })
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

  test("answers a shared write statement's refusal (Issue #109 part B) as the problem of its status: a 409 with the sentence, a RefusedField the validator's 400 at the field", async () => {
    const { entries, log } = recorder()
    const conflict = await app(log).request("/refused")
    assert.equal(conflict.status, 409)
    assert.deepEqual(await readProblem(conflict), { type: "about:blank", title: "Conflict", status: 409, detail: "This alert is linked to ticket T-8831; an alert links to one ticket" })
    const field = await app(log).request("/refused-field")
    assert.equal(field.status, 400)
    assert.deepEqual(await readProblem(field), { type: "about:blank", title: "Bad Request", status: 400, detail: "The request body is invalid", errors: [{ path: "alertId", message: "Not an alert of this project" }] })
    assert.deepEqual(entries, [], "a refusal a statement raised on purpose is not logged")
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

  test("maps an exclusion violation (SQLSTATE 23P01) to 409 too: a period that overlaps one already there", async () => {
    const { entries, log } = recorder()
    const wrapped = await app(log).request("/overlap")
    assert.equal(wrapped.status, 409)
    const body = await readProblem(wrapped)
    assert.equal(body.title, "Conflict")
    assert.match(body.detail ?? "", /overlap/i)
    assert.match(body.detail ?? "", /subscription_no_overlap/)
    const bare = await app(log).request("/overlap-bare")
    assert.equal(bare.status, 409)
    assert.equal((await readProblem(bare)).detail?.includes("subscription_no_overlap"), false)
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

  test("answers 500 for a check violation (SQLSTATE 23514) no route foresaw, logging the constraint: the signal that a sentence is missing", async () => {
    const { entries, log } = recorder()
    const response = await app(log).request("/check")
    assert.equal(response.status, 500, "a check the API should have run, or named through refuseCheck, is the server's fault and not the client's news")
    assert.deepEqual(await readProblem(response), { type: "about:blank", title: "Internal Server Error", status: 500 })
    assert.equal(entries.length, 1)
    const cause = (entries[0] as { cause: Record<string, unknown> }).cause
    assert.equal(cause.code, "23514")
    assert.equal(cause.constraint_name, "planning_area_boundary_boundary_valid")
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

describe("the constraint a failed write names", () => {
  const failure = (code: string, constraint?: string) =>
    new Error("Failed query", { cause: Object.assign(new Error("refused"), { code, ...(constraint === undefined ? {} : { constraint_name: constraint }) }) })

  test("is read from a unique violation and an exclusion violation, each by its own SQLSTATE", () => {
    assert.equal(uniqueConstraintOf(failure("23505", "product_project_id_name_key")), "product_project_id_name_key")
    assert.equal(exclusionConstraintOf(failure("23P01", "subscription_no_overlap")), "subscription_no_overlap")
  })

  test("is read from a check violation by its own SQLSTATE too, and from nothing else", () => {
    assert.equal(checkConstraintOf(failure("23514", "planning_area_boundary_boundary_valid")), "planning_area_boundary_boundary_valid")
    assert.equal(checkConstraintOf(failure("23514")), undefined, "a check Postgres did not name is nobody's to answer")
    assert.equal(checkConstraintOf(failure("23505", "product_project_id_name_key")), undefined)
    assert.equal(checkConstraintOf(failure("23P01", "subscription_no_overlap")), undefined)
    assert.equal(checkConstraintOf(new Error("nothing to do with the database")), undefined)
    assert.equal(uniqueConstraintOf(failure("23514", "planning_area_boundary_boundary_valid")), undefined)
    assert.equal(exclusionConstraintOf(failure("23514", "planning_area_boundary_boundary_valid")), undefined)
  })

  test("is undefined for the other's SQLSTATE, for another error, and where Postgres named none", () => {
    assert.equal(uniqueConstraintOf(failure("23P01", "subscription_no_overlap")), undefined)
    assert.equal(exclusionConstraintOf(failure("23505", "product_project_id_name_key")), undefined)
    assert.equal(exclusionConstraintOf(failure("23503", "product_company_id_fk")), undefined)
    assert.equal(exclusionConstraintOf(failure("23P01")), undefined)
    assert.equal(exclusionConstraintOf(new Error("nothing to do with the database")), undefined)
  })
})

describe("refuseOverlap", () => {
  const overlap = (constraint: string) =>
    new Error("Failed query", { cause: Object.assign(new Error("conflicting key value"), { code: "23P01", constraint_name: constraint }) })
  const sentences = { subscription_no_overlap: "This product is already subscribed to at that place over those dates" }

  test("hands back what the write answered when it succeeded", async () => {
    assert.equal(await refuseOverlap(sentences, async () => "written"), "written")
  })

  test("turns an overlap the route foresaw into a 409 with its sentence", async () => {
    const raised = await refuseOverlap(sentences, async () => {
      throw overlap("subscription_no_overlap")
    }).then(
      () => assert.fail("the write was expected to be refused"),
      (error: unknown) => error,
    )
    assert.ok(raised instanceof ProblemError)
    assert.equal(raised.status, 409)
    assert.equal(raised.body.detail, sentences.subscription_no_overlap)
  })

  test("leaves an overlap it did not foresee, and a duplicate, to the error handler", async () => {
    for (const error of [overlap("container_service_placement_no_overlap"), new Error("something else")]) {
      const raised = await refuseOverlap(sentences, async () => {
        throw error
      }).then(
        () => assert.fail("the write was expected to be refused"),
        (thrown: unknown) => thrown,
      )
      assert.equal(raised, error)
    }
  })

  test("is the exclusion violation's own door: refuseDuplicate does not answer one, and neither answers the other's", async () => {
    const duplicate = new Error("Failed query", {
      cause: Object.assign(new Error("duplicate key"), { code: "23505", constraint_name: "subscription_no_overlap" }),
    })
    const left = await refuseDuplicate(sentences, async () => {
      throw overlap("subscription_no_overlap")
    }).then(
      () => assert.fail("the write was expected to be refused"),
      (thrown: unknown) => thrown,
    )
    assert.ok(!(left instanceof ProblemError), "an exclusion violation is not refuseDuplicate's to answer")
    const answered = await refuseDuplicate(sentences, async () => {
      throw duplicate
    }).then(
      () => assert.fail("the write was expected to be refused"),
      (thrown: unknown) => thrown,
    )
    assert.ok(answered instanceof ProblemError)
    assert.equal(answered.status, 409)
  })
})

describe("refuseCheck", () => {
  const check = (constraint?: string) =>
    new Error("Failed query", { cause: Object.assign(new Error("violates check constraint"), { code: "23514", ...(constraint === undefined ? {} : { constraint_name: constraint }) }) })
  const sentences = { planning_area_boundary_boundary_valid: { path: "boundary", message: "Not a valid polygon: the ring crosses itself" } }

  test("hands back what the write answered when it succeeded", async () => {
    assert.equal(await refuseCheck(sentences, async () => "written"), "written")
  })

  test("turns a check the route foresaw into a 400 on the field with its sentence, in the validator's own shape", async () => {
    const raised = await refuseCheck(sentences, async () => {
      throw check("planning_area_boundary_boundary_valid")
    }).then(
      () => assert.fail("the write was expected to be refused"),
      (error: unknown) => error,
    )
    assert.ok(raised instanceof ProblemError)
    assert.equal(raised.status, 400, "the value will not do: a 400, as the schema would have answered had it been able to see")
    assert.equal(raised.body.detail, "The request body is invalid")
    assert.deepEqual(raised.body.errors, [{ path: "boundary", message: "Not a valid polygon: the ring crosses itself" }])
  })

  test("leaves a check it did not foresee, one Postgres did not name, and another error to the error handler", async () => {
    for (const error of [check("route_scheme_service_days_non_empty"), check(), new Error("something else")]) {
      const raised = await refuseCheck(sentences, async () => {
        throw error
      }).then(
        () => assert.fail("the write was expected to be refused"),
        (thrown: unknown) => thrown,
      )
      assert.equal(raised, error)
    }
  })

  test("is the check violation's own door: neither of the 409 doors answers one, and it answers neither of theirs", async () => {
    const conflicts = { planning_area_boundary_boundary_valid: "not this door's sentence" }
    for (const door of [refuseDuplicate, refuseOverlap]) {
      const left = await door(conflicts, async () => {
        throw check("planning_area_boundary_boundary_valid")
      }).then(
        () => assert.fail("the write was expected to be refused"),
        (thrown: unknown) => thrown,
      )
      assert.ok(!(left instanceof ProblemError), "a check violation is not a 409 door's to answer")
    }
    for (const code of ["23505", "23P01"]) {
      const error = new Error("Failed query", { cause: Object.assign(new Error("key"), { code, constraint_name: "planning_area_boundary_boundary_valid" }) })
      const left = await refuseCheck(sentences, async () => {
        throw error
      }).then(
        () => assert.fail("the write was expected to be refused"),
        (thrown: unknown) => thrown,
      )
      assert.equal(left, error)
    }
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
  // The shape of every write body: strict, so a member it does not know is
  // refused by name (Issue #74), with a strict object nested in a list the
  // way a Property's parties are, and `.refine`d the way UserInvite and
  // SubscriptionCreate are, since a refined strict object is still an object
  // in zod 4 and its members must still be read.
  const Party = z.strictObject({ customerId: z.string(), role: z.string() })
  const Strict = z
    .strictObject({
      name: z.string().min(1),
      status: z.string().optional(),
      contactEmail: z.email().optional(),
      parties: z.array(Party).optional(),
    })
    .refine(() => true)
  const StrictQuery = z.strictObject({ limit: z.string().optional(), cursor: z.string().optional() })
  // A strict object with no members, and a record whose keys are a finite
  // set: zod refuses a key outside either as unrecognized, and the sentence
  // must say what each accepts — nothing, and the set.
  const Empty = z.strictObject({})
  const Keyed = z.strictObject({ byDay: z.record(z.enum(["mon", "tue"]), z.string()) })
  // An issue that says "unrecognized keys" at a path that leads to no object:
  // zod never emits one, so a check pushes it, to show the hook falls back to
  // the plain sentence rather than throwing.
  const Unresolvable = z.object({ nowhere: z.string() }).check((ctx) => {
    ctx.issues.push({ code: "unrecognized_keys", keys: ["ghost"], input: ctx.value, path: ["nowhere", "deep"] })
  })
  const hono = new Hono().onError(errorHandler(() => assert.fail("nothing here is a 500")))
  hono.post("/things", validate("json", Body), (c) => c.json(c.req.valid("json"), 201))
  hono.get("/things", validate("query", PageRequest), (c) => c.json(c.req.valid("query")))
  hono.post("/strict", validate("json", Strict), (c) => c.json(c.req.valid("json"), 201))
  hono.get("/strict", validate("query", StrictQuery), (c) => c.json(c.req.valid("query")))
  hono.post("/unresolvable", validate("json", Unresolvable), (c) => c.json(c.req.valid("json"), 201))
  hono.post("/empty", validate("json", Empty), (c) => c.json(c.req.valid("json"), 201))
  hono.post("/keyed", validate("json", Keyed), (c) => c.json(c.req.valid("json"), 201))

  const post = (body: unknown, path = "/things") =>
    hono.request(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } })

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

  test("refuses a member a strict body does not know by name, and names the members it does know, in schema order", async () => {
    const response = await post({ name: "Kystbyen", colour: "red" }, "/strict")
    assert.equal(response.status, 400)
    const body = await readProblem(response)
    assert.equal(body.detail, "The request body is invalid")
    assert.deepEqual(body.errors, [
      { path: "colour", message: 'Unrecognized key "colour"; the body\'s members are name, status, contactEmail, parties' },
    ])
  })

  test("answers two unknown keys with two errors, each at the key's own path", async () => {
    const response = await post({ name: "Kystbyen", colour: "red", shape: "round" }, "/strict")
    assert.equal(response.status, 400)
    const { errors } = await readProblem(response)
    assert.deepEqual(errors?.map((error) => error.path), ["colour", "shape"])
    for (const error of errors ?? []) assert.match(error.message, /the body's members are name, status, contactEmail, parties$/)
    assert.match(errors?.[0].message ?? "", /^Unrecognized key "colour"/)
    assert.match(errors?.[1].message ?? "", /^Unrecognized key "shape"/)
  })

  test("names the members of a nested strict object by its path, beside the other issues in issue order", async () => {
    const response = await post({ name: "", parties: [{ customerId: "c", role: "owner", colour: "red" }] }, "/strict")
    assert.equal(response.status, 400)
    const { errors } = await readProblem(response)
    assert.deepEqual(errors?.map((error) => error.path), ["name", "parties.0.colour"])
    assert.equal(errors?.[1].message, 'Unrecognized key "colour"; the members of parties.0 are customerId, role')
  })

  test("says whose members they are by the target: a strict query names the query's", async () => {
    const response = await hono.request("/strict?limit=5&size=5")
    assert.equal(response.status, 400)
    const body = await readProblem(response)
    assert.equal(body.detail, "The request query is invalid")
    assert.deepEqual(body.errors, [{ path: "size", message: 'Unrecognized key "size"; the query\'s members are limit, cursor' }])
  })

  test("falls back to the plain sentence where the path leads to no object, rather than throwing", async () => {
    const response = await post({ nowhere: "here" }, "/unresolvable")
    assert.equal(response.status, 400)
    const { errors } = await readProblem(response)
    assert.deepEqual(errors, [{ path: "nowhere.deep.ghost", message: 'Unrecognized key "ghost"' }])
  })

  test("says an object with no members accepts none, rather than ending on a list with nothing in it", async () => {
    const response = await post({ colour: "red" }, "/empty")
    assert.equal(response.status, 400)
    const { errors } = await readProblem(response)
    assert.deepEqual(errors, [{ path: "colour", message: 'Unrecognized key "colour"; the body accepts no members' }])
  })

  test("lists the keys a record over a finite key set accepts, since zod refuses a key outside it the same way", async () => {
    // Such a record is exhaustive too — a key it names and the body leaves out is its own issue — so the body carries both.
    const response = await post({ byDay: { mon: "collect", tue: "collect", wed: "collect" } }, "/keyed")
    assert.equal(response.status, 400)
    const { errors } = await readProblem(response)
    assert.deepEqual(errors, [{ path: "byDay.wed", message: 'Unrecognized key "wed"; the members of byDay are mon, tue' }])
  })
})

describe("membersAt", () => {
  const Inner = z.strictObject({ customerId: z.string(), role: z.string() })
  const Outer = z
    .strictObject({
      name: z.string(),
      parties: z.array(Inner).optional(),
      contact: Inner.nullable().default(null),
      byKey: z.record(z.string(), Inner),
      pair: z.tuple([z.string(), Inner]),
      piped: Inner.transform((party) => party.role),
      later: z.lazy(() => Inner),
    })
    .refine(() => true)

  test("reads an object's members at the root and through optional, nullable, default, array, record, tuple, pipe and lazy", () => {
    assert.deepEqual(membersAt(Outer, []), ["name", "parties", "contact", "byKey", "pair", "piped", "later"])
    assert.deepEqual(membersAt(Outer, ["parties", 0]), ["customerId", "role"])
    assert.deepEqual(membersAt(Outer, ["parties", { key: 3 }]), ["customerId", "role"], "a Standard Schema path segment may be wrapped")
    assert.deepEqual(membersAt(Outer, ["contact"]), ["customerId", "role"])
    assert.deepEqual(membersAt(Outer, ["byKey", "anything"]), ["customerId", "role"])
    assert.deepEqual(membersAt(Outer, ["pair", 1]), ["customerId", "role"])
    assert.deepEqual(membersAt(Outer, ["piped"]), ["customerId", "role"], "a body is validated against the input side of a pipe")
    assert.deepEqual(membersAt(Outer, ["later"]), ["customerId", "role"])
  })

  test("is undefined where the path leads to no object: a scalar, a tuple index off the end, a member that is not there, or no schema at all", () => {
    assert.equal(membersAt(Outer, ["name"]), undefined)
    assert.equal(membersAt(Outer, ["pair", 0]), undefined)
    assert.equal(membersAt(Outer, ["pair", 2]), undefined)
    assert.equal(membersAt(Outer, ["missing"]), undefined)
    assert.equal(membersAt(Outer, ["name", "deeper"]), undefined)
    assert.equal(membersAt(z.string(), []), undefined)
    assert.equal(membersAt(undefined, []), undefined)
    assert.equal(membersAt({ not: "a schema" }, []), undefined)
  })

  test("answers an empty list for an object with no members: it accepts nothing, which is an answer", () => {
    assert.deepEqual(membersAt(z.strictObject({}), []), [])
    assert.deepEqual(membersAt(z.strictObject({ inner: z.strictObject({}) }), ["inner"]), [])
  })

  test("reads a record's keys where its key schema is a finite set, and nothing where it is a constraint", () => {
    enum Weekday {
      Mon = "mon",
      Tue = "tue",
    }
    enum Ordinal {
      First = 1,
      Second = 2,
    }
    assert.deepEqual(membersAt(z.record(z.enum(["mon", "tue"]), z.string()), []), ["mon", "tue"])
    assert.deepEqual(membersAt(z.record(z.enum(Weekday), z.string()), []), ["mon", "tue"], "a native enum's values")
    assert.deepEqual(membersAt(z.record(z.enum(Ordinal), z.string()), []), ["1", "2"], "a numeric enum's values, its reverse mapping left out")
    assert.deepEqual(membersAt(z.record(z.literal(["a", "b"]), z.string()), []), ["a", "b"])
    assert.deepEqual(membersAt(z.strictObject({ byDay: z.record(z.enum(["mon", "tue"]), z.string()).optional() }), ["byDay"]), ["mon", "tue"])
    assert.equal(membersAt(z.record(z.string(), z.string()), []), undefined, "a key that is any string names no members")
    assert.equal(membersAt(Outer, ["byKey"]), undefined)
  })
})
