// The pure helpers of routes/shared.ts that need no request: how a row's
// stamps and a `time` column are spelled on the wire (Issue #97). No database.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { IsoTime } from "@waste/contracts/dates"

import { driverCommand, session } from "@waste/db/schema/execution"

import { ProblemError } from "../problem"
import { COMMAND_BACKDATE_MS, OCCURRED_AT_SKEW_MS, primaryKeyOf, providerShapeIssue, replayed, requireProviderShape, stampsOf, timeOf } from "../routes/shared"

describe("timeOf", () => {
  test("drops the seconds Postgres spells a time with, so the value is the contracts' IsoTime", () => {
    assert.equal(timeOf("06:30:00"), "06:30")
    assert.equal(timeOf("23:59:59"), "23:59")
    assert.equal(timeOf("06:30:00.5"), "06:30", "fractional seconds go too")
    for (const value of ["06:30:00", "00:00:00"]) assert.ok(IsoTime.safeParse(timeOf(value)).success, value)
  })

  test("passes a time already spelled HH:MM through", () => {
    assert.equal(timeOf("06:30"), "06:30")
  })

  test("throws on anything that is not a time of day, since that is a statement's bug and not a client's", () => {
    for (const value of ["", "6:30:00", "06:30:00+02:00", "2026-09-25T06:30:00", "morning"]) {
      assert.throws(() => timeOf(value), /timeOf: .* is not a time of day as Postgres spells one \(HH:MM:SS\)/, value)
    }
  })
})

describe("providerShapeIssue and requireProviderShape, the provider rule's two doors", () => {
  const PROVIDER = "01a0d3a5-e5e0-7000-8000-000000000001"
  const SENTENCE = "the family's sentence"
  const issue = { path: "serviceProviderId", message: SENTENCE }

  test("answer nothing where the merged row holds, and the field error at serviceProviderId where it does not", () => {
    assert.equal(providerShapeIssue("company", { serviceProviderId: null }, SENTENCE), undefined)
    assert.equal(providerShapeIssue("service-provider", { serviceProviderId: PROVIDER }, SENTENCE), undefined)
    assert.deepEqual(providerShapeIssue("service-provider", { serviceProviderId: null }, SENTENCE), issue, "a provider's row names no provider")
    assert.deepEqual(providerShapeIssue("company", { serviceProviderId: PROVIDER }, SENTENCE), issue, "the company's row names one")
  })

  test("the throwing door is the same answer as a 400, so a caller with one rule to hold and one collecting several agree", () => {
    requireProviderShape("company", { serviceProviderId: null }, SENTENCE)
    assert.throws(
      () => requireProviderShape("company", { serviceProviderId: PROVIDER }, SENTENCE),
      (error: unknown) => error instanceof ProblemError && error.body.status === 400 && JSON.stringify(error.body.errors) === JSON.stringify([issue]),
    )
  })
})

describe("stampsOf", () => {
  test("spells the two instants as RFC 3339 in UTC", () => {
    const at = new Date("2026-09-25T06:30:00.000+02:00")
    assert.deepEqual(stampsOf({ createdAt: at, updatedAt: at }), { createdAt: "2026-09-25T04:30:00.000Z", updatedAt: "2026-09-25T04:30:00.000Z" })
  })
})

// Execution, slice 4 (Issue #104): the fourth door and the clock bounds, over a scripted write.

/** What postgres.js throws for a unique violation, as Drizzle wraps it: the SQLSTATE and the constraint on the cause. */
const uniqueViolation = (constraint: string): Error => Object.assign(new Error("duplicate key"), { cause: { code: "23505", constraint_name: constraint } })

describe("replayed, the door that answers a client-minted id already present as the first application", () => {
  const keys = [primaryKeyOf(driverCommand), primaryKeyOf(session)]

  test("names a table's primary key the way Postgres does", () => {
    assert.equal(primaryKeyOf(driverCommand), "driver_command_pkey")
    assert.equal(primaryKeyOf(session), "session_pkey")
  })

  test("answers the write's own result when the write goes through, and never reads the first", async () => {
    let read = 0
    const answer = await replayed(keys, async () => "applied", async () => {
      read += 1
      return "replayed"
    })
    assert.equal(answer, "applied")
    assert.equal(read, 0)
  })

  test("answers what was recorded when the write meets one of the named primary keys — the receipt's or the made row's", async () => {
    for (const constraint of keys) {
      const answer = await replayed(
        keys,
        async () => {
          throw uniqueViolation(constraint)
        },
        async () => "replayed",
      )
      assert.equal(answer, "replayed", constraint)
    }
  })

  test("rethrows a unique violation on any other constraint, and a violation of a named key that nothing recorded, since neither is a replay", async () => {
    const other = uniqueViolation("session_driver_open_idx")
    await assert.rejects(
      replayed(keys, async () => {
        throw other
      }, async () => "replayed"),
      (error) => error === other,
    )
    const nobodys = uniqueViolation(primaryKeyOf(driverCommand))
    await assert.rejects(
      replayed(keys, async () => {
        throw nobodys
      }, async () => undefined),
      (error) => error === nobodys,
    )
    const elsewhere = new Error("the database is gone")
    await assert.rejects(
      replayed(keys, async () => {
        throw elsewhere
      }, async () => "replayed"),
      (error) => error === elsewhere,
      "an error that is not a unique violation is not a replay either",
    )
  })
})

describe("the clock bounds a recorded instant is held within", () => {
  test("are five minutes ahead and forty-eight hours behind the request, spelled once", () => {
    assert.equal(OCCURRED_AT_SKEW_MS, 5 * 60_000)
    assert.equal(COMMAND_BACKDATE_MS, 48 * 60 * 60_000)
  })
})
