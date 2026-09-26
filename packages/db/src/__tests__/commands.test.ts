// What the shared write statements agree on, without a database (Issue #109
// part B): the SQLSTATE readers over an error as postgres.js raises it and as
// Drizzle wraps it, and `Refused`, the refusal a statement both processes run
// throws in place of the API's problem — its status, its sentence, and the
// field a 400 came in.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { Refused, refused, RefusedField } from "../commands/shared"
import { CHECK_VIOLATION, checkConstraintOf, EXCLUSION_VIOLATION, exclusionConstraintOf, sqlstate, UNIQUE_VIOLATION, uniqueConstraintOf } from "../sqlstate"

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
    assert.deepEqual([UNIQUE_VIOLATION, EXCLUSION_VIOLATION, CHECK_VIOLATION], ["23505", "23P01", "23514"])
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

describe("Refused", () => {
  test("is an Error with the status the API answers and the sentence a person reads; a 409 names no field", () => {
    const error = refused(409, "This alert is resolved and does not change")
    assert.ok(error instanceof Refused)
    assert.ok(error instanceof Error)
    assert.deepEqual([error.name, error.status, error.message, error.path], ["Refused", 409, "This alert is resolved and does not change", undefined])
  })

  test("a RefusedField is a 400 at the field the value came in", () => {
    const error = new RefusedField("alertId", "Not an alert of this project")
    assert.ok(error instanceof Refused)
    assert.deepEqual([error.name, error.status, error.message, error.path], ["RefusedField", 400, "Not an alert of this project", "alertId"])
  })
})
