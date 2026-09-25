// The pure helpers of routes/shared.ts that need no request: how a row's
// stamps and a `time` column are spelled on the wire (Issue #97), the
// whole-day window a pair of days makes and the skew check (Issue #109). No
// database.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { IsoTime } from "@waste/contracts/dates"
import { CASING } from "@waste/db/casing"
import { driverCommand, session } from "@waste/db/schema/execution"
import { ticket } from "@waste/db/schema/resolution"
import { RECORDED_AFTER_IT_HAPPENED } from "@waste/domain/execution/commands"
import type { SQL } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"

import { ProblemError } from "../problem"
import {
  COMMAND_BACKDATE_MS,
  dayWindow,
  endOfDayExclusive,
  instantOf,
  OCCURRED_AT_SKEW_MS,
  primaryKeyOf,
  providerShapeIssue,
  replayed,
  requireNotAhead,
  requireProviderShape,
  stampsOf,
  timeOf,
} from "../routes/shared"

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

describe("instantOf", () => {
  test("spells a nullable instant as RFC 3339 in UTC, and null as null", () => {
    assert.equal(instantOf(new Date("2026-09-25T06:30:00.000+02:00")), "2026-09-25T04:30:00.000Z")
    assert.equal(instantOf(null), null)
  })
})

// Resolution (Issue #109): the window a `from`/`to` pair of days makes over an instant column.

describe("endOfDayExclusive", () => {
  test("is the midnight after the day on the UTC calendar: the last millisecond of the day is inside it, the first of the next day is not", () => {
    const end = endOfDayExclusive("2026-10-05")
    assert.equal(end.toISOString(), "2026-10-06T00:00:00.000Z")
    assert.ok(new Date("2026-10-05T23:59:59.999Z") < end, "23:59:59.999 on the day is in")
    assert.ok(!(new Date("2026-10-06T00:00:00.000Z") < end), "midnight after it is out")
    assert.equal(endOfDayExclusive("2026-12-31").toISOString(), "2027-01-01T00:00:00.000Z", "across the year")
    assert.equal(endOfDayExclusive("2028-02-29").toISOString(), "2028-03-01T00:00:00.000Z", "a leap day is a day")
  })
})

describe("dayWindow", () => {
  const dialect = new PgDialect({ casing: CASING })
  /** The fragment as Postgres would see it: its text, and its parameters as instants. */
  const rendered = (window: SQL | undefined) => {
    if (window === undefined) return undefined
    const query = dialect.sqlToQuery(window)
    return { sql: query.sql, params: query.params.map((param) => (param instanceof Date ? param.toISOString() : param)) }
  }

  test("is nothing when neither end was given, as `and` of nothing is", () => {
    assert.equal(rendered(dayWindow(ticket.occurredAt, undefined, undefined)), undefined)
  })

  test("takes the whole of both days: `>=` the first instant of `from`, `<` the midnight after `to`", () => {
    const both = rendered(dayWindow(ticket.occurredAt, "2026-10-01", "2026-10-05"))
    assert.match(both?.sql ?? "", /"occurred_at" >= \$1 and .*"occurred_at" < \$2/)
    assert.deepEqual(both?.params, ["2026-10-01T00:00:00.000Z", "2026-10-06T00:00:00.000Z"], "a row at 23:59:59.999Z on the 5th is inside the window and one at 00:00:00Z on the 6th is not")
    const oneDay = rendered(dayWindow(ticket.occurredAt, "2026-10-05", "2026-10-05"))
    assert.deepEqual(oneDay?.params, ["2026-10-05T00:00:00.000Z", "2026-10-06T00:00:00.000Z"], "from and to on one day is that day")
  })

  test("takes one end alone: a lower bound with no upper, an upper with no lower", () => {
    const from = rendered(dayWindow(ticket.occurredAt, "2026-10-01", undefined))
    assert.match(from?.sql ?? "", /"occurred_at" >= \$1$/)
    assert.deepEqual(from?.params, ["2026-10-01T00:00:00.000Z"])
    const to = rendered(dayWindow(ticket.occurredAt, undefined, "2026-10-05"))
    assert.match(to?.sql ?? "", /"occurred_at" < \$1$/)
    assert.deepEqual(to?.params, ["2026-10-06T00:00:00.000Z"])
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

  test("answers `taken` for a named key that nothing the caller can see recorded, when the caller gives one, and never for another constraint", async () => {
    const answer = await replayed(
      keys,
      async () => {
        throw uniqueViolation(primaryKeyOf(session))
      },
      async () => undefined,
      async () => "taken",
    )
    assert.equal(answer, "taken", "the id is another device's command")
    const other = uniqueViolation("session_driver_open_idx")
    await assert.rejects(
      replayed(
        keys,
        async () => {
          throw other
        },
        async () => undefined,
        async () => "taken",
      ),
      (error) => error === other,
      "an index that is not a command's key is not a taken id",
    )
    let asked = 0
    const recorded = await replayed(
      keys,
      async () => {
        throw uniqueViolation(primaryKeyOf(driverCommand))
      },
      async () => "replayed",
      async () => {
        asked += 1
        return "taken"
      },
    )
    assert.equal(recorded, "replayed")
    assert.equal(asked, 0, "the first answer wins where there is one")
  })
})

describe("the clock bounds a recorded instant is held within", () => {
  test("are five minutes ahead and forty-eight hours behind the request, spelled once", () => {
    assert.equal(OCCURRED_AT_SKEW_MS, 5 * 60_000)
    assert.equal(COMMAND_BACKDATE_MS, 48 * 60 * 60_000)
  })
})

describe("requireNotAhead, the one skew check the ticket create, the alert raise, the unload capture and the ledger read (Issue #109)", () => {
  const at = new Date("2026-10-05T12:00:00Z")
  const refusedAt = (path: string) => (error: unknown) =>
    error instanceof ProblemError && error.body.status === 400 && JSON.stringify(error.body.errors) === JSON.stringify([{ path, message: RECORDED_AFTER_IT_HAPPENED }])

  test("passes an instant at the clock, up to the skew ahead of it, and any distance behind it, since it has no lower bound", () => {
    requireNotAhead(at, at)
    requireNotAhead(new Date(at.getTime() + OCCURRED_AT_SKEW_MS), at)
    requireNotAhead(new Date(at.getTime() - 1), at)
    requireNotAhead(new Date("2020-01-01T00:00:00Z"), at)
  })

  test("refuses a millisecond past the skew as recorded after it happened, at `occurredAt` unless the caller names the field", () => {
    const beyond = new Date(at.getTime() + OCCURRED_AT_SKEW_MS + 1)
    assert.throws(() => requireNotAhead(beyond, at), refusedAt("occurredAt"))
    assert.throws(() => requireNotAhead(beyond, at, "detectedAt"), refusedAt("detectedAt"), "the alert raise names its own field")
    assert.throws(() => requireNotAhead(new Date(at.getTime() + 60 * 60_000), at), refusedAt("occurredAt"), "an hour ahead is no closer")
  })
})
