// What the shared write statements agree on, without a database (Issue #109
// part B): the SQLSTATE readers over an error as postgres.js raises it and as
// Drizzle wraps it, the doors a foreseen constraint goes through — each
// refusing with the domain's `Refused`, or answering a replay — and the
// strength a patch's row lock is taken at.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { Refused } from "@waste/domain/refusal"
import { DrizzleQueryError } from "drizzle-orm/errors"

import { refuseCheck, refuseDuplicate, refuseOverlap, replayed, strengthFor } from "../commands/shared"
import { product } from "../schema/catalogue"
import { vehicle } from "../schema/fleet"
import { company } from "../schema/organisation"
import { depot } from "../schema/places"
import { checkConstraintOf, DRIZZLE_QUERY, exclusionConstraintOf, loggable, messageWithoutStatement, sqlstate, uniqueConstraintOf } from "../sqlstate"

/** An error the way postgres.js raises one: the SQLSTATE as `code`, the constraint as `constraint_name`. */
const postgresError = (code: string, constraint?: string) => Object.assign(new Error(`SQLSTATE ${code}`), { code, ...(constraint === undefined ? {} : { constraint_name: constraint }) })

/** The same as Drizzle wraps it: its own error with the database's as `cause`. */
const wrapped = (cause: Error) => Object.assign(new Error("Failed query"), { cause })

describe("sqlstate", () => {
  test("reads the code and the constraint off a postgres.js error, and through Drizzle's cause; nothing off an error that is not the database's", () => {
    assert.deepEqual(sqlstate(postgresError("23505", "ticket_source_event_id_idx")), { code: "23505", constraint: "ticket_source_event_id_idx" })
    assert.deepEqual(sqlstate(wrapped(postgresError("23P01", "agreement_no_overlap"))), { code: "23P01", constraint: "agreement_no_overlap" })
    assert.deepEqual(sqlstate(postgresError("42501")), { code: "42501" })
    assert.equal(sqlstate(new Error("no code")), undefined)
    assert.equal(sqlstate(null), undefined)
    assert.equal(sqlstate("a string"), undefined)
  })

  test("names the three states and answers each reader for its own state only", () => {
    const unique = wrapped(postgresError("23505", "ticket_event_source_event_id_idx"))
    const exclusion = postgresError("23P01", "route_scheme_no_overlap")
    const check = postgresError("23514", "ticket_origin_shape")
    assert.equal(uniqueConstraintOf(unique), "ticket_event_source_event_id_idx")
    assert.equal(uniqueConstraintOf(exclusion), undefined)
    assert.equal(exclusionConstraintOf(exclusion), "route_scheme_no_overlap")
    assert.equal(exclusionConstraintOf(check), undefined)
    assert.equal(checkConstraintOf(check), "ticket_origin_shape")
    assert.equal(checkConstraintOf(unique), undefined)
    assert.equal(uniqueConstraintOf(postgresError("23505")), undefined, "a unique violation Postgres did not name a constraint for is one nobody foresaw")
  })
})

/** What a door's write threw, for a test that expects it to throw. */
const thrownBy = async (write: Promise<unknown>): Promise<unknown> =>
  write.then(
    () => assert.fail("the write was expected to be refused"),
    (error: unknown) => error,
  )

describe("refuseDuplicate and refuseOverlap, the doors a foreseen key or period goes through", () => {
  const sentences = { subscription_no_overlap: "This product is already subscribed to at that place over those dates" }

  test("hand back what the write answered when it succeeded", async () => {
    assert.equal(await refuseOverlap(sentences, async () => "written"), "written")
    assert.equal(await refuseDuplicate(sentences, async () => "written"), "written")
  })

  test("turn an overlap the caller foresaw into a conflict with its sentence", async () => {
    const raised = await thrownBy(refuseOverlap(sentences, async () => Promise.reject(wrapped(postgresError("23P01", "subscription_no_overlap")))))
    assert.ok(raised instanceof Refused)
    assert.deepEqual(raised.refusal, { reason: "conflict", sentence: sentences.subscription_no_overlap })
  })

  test("leave an overlap no one foresaw, and another error, to the caller as they came", async () => {
    for (const error of [wrapped(postgresError("23P01", "container_service_placement_no_overlap")), new Error("something else")]) {
      assert.equal(await thrownBy(refuseOverlap(sentences, async () => Promise.reject(error))), error)
    }
  })

  test("each answers its own SQLSTATE alone: a unique violation is not refuseOverlap's, an exclusion violation not refuseDuplicate's", async () => {
    const exclusion = wrapped(postgresError("23P01", "subscription_no_overlap"))
    assert.equal(await thrownBy(refuseDuplicate(sentences, async () => Promise.reject(exclusion))), exclusion)
    const duplicate = wrapped(postgresError("23505", "subscription_no_overlap"))
    assert.equal(await thrownBy(refuseOverlap(sentences, async () => Promise.reject(duplicate))), duplicate)
    const answered = await thrownBy(refuseDuplicate(sentences, async () => Promise.reject(duplicate)))
    assert.ok(answered instanceof Refused && answered.refusal.reason === "conflict")
  })
})

describe("refuseCheck, the door a check only the database can run goes through", () => {
  const sentences = { planning_area_boundary_boundary_valid: { input: "boundary", sentence: "Not a valid polygon: the ring crosses itself" } }

  test("hands back what the write answered when it succeeded", async () => {
    assert.equal(await refuseCheck(sentences, async () => "written"), "written")
  })

  test("turns a check the caller foresaw into an invalid value at its input, with its sentence", async () => {
    const raised = await thrownBy(refuseCheck(sentences, async () => Promise.reject(wrapped(postgresError("23514", "planning_area_boundary_boundary_valid")))))
    assert.ok(raised instanceof Refused)
    assert.deepEqual(raised.refusal, { reason: "invalid", input: "boundary", sentence: "Not a valid polygon: the ring crosses itself" })
  })

  test("leaves a check no one foresaw, one Postgres did not name, another error, and the 409 doors' states to the caller as they came", async () => {
    for (const error of [
      wrapped(postgresError("23514", "route_scheme_service_days_non_empty")),
      wrapped(postgresError("23514")),
      new Error("something else"),
      wrapped(postgresError("23505", "planning_area_boundary_boundary_valid")),
      wrapped(postgresError("23P01", "planning_area_boundary_boundary_valid")),
    ]) {
      assert.equal(await thrownBy(refuseCheck(sentences, async () => Promise.reject(error))), error)
    }
  })

  test("is not a 409 door's to answer", async () => {
    const check = wrapped(postgresError("23514", "planning_area_boundary_boundary_valid"))
    for (const door of [refuseDuplicate, refuseOverlap]) {
      assert.equal(await thrownBy(door({ planning_area_boundary_boundary_valid: "not this door's sentence" }, async () => Promise.reject(check))), check)
    }
  })
})

describe("replayed, the door that answers a key already taken as the first application", () => {
  const keys = ["driver_command_pkey", "session_pkey"]
  const uniqueViolation = (constraint: string) => wrapped(postgresError("23505", constraint))

  test("answers the write's own result when the write goes through, and never reads the first", async () => {
    let read = 0
    const answer = await replayed(keys, async () => "applied", async () => {
      read += 1
      return "replayed"
    })
    assert.equal(answer, "applied")
    assert.equal(read, 0)
  })

  test("answers what was recorded when the write meets one of the named keys", async () => {
    for (const constraint of keys) {
      assert.equal(await replayed(keys, async () => Promise.reject(uniqueViolation(constraint)), async () => "replayed"), "replayed", constraint)
    }
  })

  test("rethrows a unique violation on any other constraint, a named key that nothing recorded, and an error that is no unique violation, since none is a replay", async () => {
    const other = uniqueViolation("session_driver_open_idx")
    assert.equal(await thrownBy(replayed(keys, async () => Promise.reject(other), async () => "replayed")), other)
    const nobodys = uniqueViolation("driver_command_pkey")
    assert.equal(await thrownBy(replayed(keys, async () => Promise.reject(nobodys), async () => undefined)), nobodys)
    const elsewhere = new Error("the database is gone")
    assert.equal(await thrownBy(replayed(keys, async () => Promise.reject(elsewhere), async () => "replayed")), elsewhere)
    assert.equal(await thrownBy(replayed([], async () => Promise.reject(nobodys), async () => "replayed")), nobodys, "a caller naming no key replays nothing")
  })

  test("answers `taken` for a named key that nothing the caller can see recorded, when the caller gives one, and never for another constraint", async () => {
    assert.equal(await replayed(keys, async () => Promise.reject(uniqueViolation("session_pkey")), async () => undefined, async () => "taken"), "taken")
    const other = uniqueViolation("session_driver_open_idx")
    assert.equal(await thrownBy(replayed(keys, async () => Promise.reject(other), async () => undefined, async () => "taken")), other)
    let asked = 0
    const recorded = await replayed(keys, async () => Promise.reject(uniqueViolation("driver_command_pkey")), async () => "replayed", async () => {
      asked += 1
      return "taken"
    })
    assert.equal(recorded, "replayed")
    assert.equal(asked, 0, "the first answer wins where there is one")
  })
})

describe("messageWithoutStatement", () => {
  test("cuts Drizzle's message at the statement, so neither the SQL nor what was bound to it survives, and leaves any other message whole", () => {
    const drizzle = `${DRIZZLE_QUERY}insert into "wms"."user_account" ("email") values ($1)\nparams: lars.mikkelsen@nordren.example`
    assert.equal(messageWithoutStatement(drizzle), "Failed query")
    assert.equal(messageWithoutStatement('duplicate key value violates unique constraint "ticket_source_event_id_idx"'), 'duplicate key value violates unique constraint "ticket_source_event_id_idx"')
    assert.equal(messageWithoutStatement(""), "")
  })
})

describe("loggable", () => {
  const cause = postgresError("23503", "user_account_role_id_fk")
  const failure = new DrizzleQueryError('insert into "wms"."user_account" ("email") values ($1)', ["lars.mikkelsen@nordren.example"], cause)

  test("keeps who threw, what the database said, the SQLSTATE, the constraint and the stack, down the cause", () => {
    const logged = loggable(failure) as Record<string, unknown>
    assert.deepEqual(Object.keys(logged).sort(), ["cause", "message", "name", "stack"])
    assert.deepEqual(logged.cause, { name: "Error", message: "SQLSTATE 23503", code: "23503", constraint_name: "user_account_role_id_fk", stack: cause.stack })
  })

  test("cuts the statement and its parameters from the wrapper's message and stack, and carries no other member", () => {
    const logged = loggable(Object.assign(failure, { query: "select secret", parameters: ["also secret"] })) as Record<string, unknown>
    assert.equal(logged.message, "Failed query")
    assert.match(String(logged.stack), /^Error: Failed query\n {4}at /)
    const printed = JSON.stringify(logged)
    for (const kept of ["lars.mikkelsen", "insert into", "secret"]) assert.equal(printed.includes(kept), false, kept)
  })

  test("goes three causes deep, and hands back a value that is not an object as it is", () => {
    const deep = { cause: { cause: { cause: { cause: { message: "four down" } } } } }
    assert.deepEqual(loggable(deep), { cause: { cause: { cause: {} } } })
    assert.equal(loggable("a string"), "a string")
    assert.equal(loggable(null), null)
  })
})

describe("strengthFor", () => {
  test("is `update` where the patch sets a column of a unique constraint, whatever else it sets", () => {
    assert.equal(strengthFor(depot, { name: "Nordhavn depot" }), "update")
    assert.equal(strengthFor(depot, { code: "NH", notes: null }), "update")
    assert.equal(strengthFor(vehicle, { registration: "AB 12 345" }), "update")
    assert.equal(strengthFor(company, { country: "SE" }), "update")
  })

  test("is `no key update` where it sets none, leaves a key undefined, or sets a column only a partial index holds unique", () => {
    assert.equal(strengthFor(depot, { notes: "Gate code 4411" }), "no key update")
    assert.equal(strengthFor(depot, { name: undefined, notes: null }), "no key update")
    assert.equal(strengthFor(vehicle, { callsign: "N-7" }), "no key update")
    assert.equal(strengthFor(product, { invoiceCode: "R-140" }), "no key update")
    assert.equal(strengthFor(company, { postalAddress: null }), "no key update")
    assert.equal(strengthFor(company, { shape: { kind: "all-projects" } }), "no key update", "a member that is no column of the table sets no key")
  })
})
