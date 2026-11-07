// What the shared write statements agree on, without a database (Issue #109
// part B): the SQLSTATE readers over an error as postgres.js raises it and as
// Drizzle wraps it, and `Refused`, the refusal a statement both processes run
// throws in place of the API's problem — its status, its sentence, and the
// field a 400 came in; and the strength a patch's row lock is taken at.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { DrizzleQueryError } from "drizzle-orm/errors"

import { Refused, refused, RefusedField, strengthFor } from "../commands/shared"
import { product } from "../schema/catalogue"
import { vehicle } from "../schema/fleet"
import { company } from "../schema/organisation"
import { depot } from "../schema/places"
import { CHECK_VIOLATION, checkConstraintOf, DRIZZLE_QUERY, EXCLUSION_VIOLATION, exclusionConstraintOf, loggable, messageWithoutStatement, sqlstate, UNIQUE_VIOLATION, uniqueConstraintOf } from "../sqlstate"

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
