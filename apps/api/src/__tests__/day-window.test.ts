// The window a `from`/`to` pair of days makes over an instant column, as the
// tickets' list filters by it (Issue #109). No database.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { CASING } from "@waste/db/casing"
import { ticket } from "@waste/db/schema/resolution"
import type { SQL } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"

import { dayWindow, endOfDayExclusive } from "../routes/tickets"

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
