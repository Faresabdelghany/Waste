// The cancel's reason code (O5 of #290) as drizzle-kit writes it:
// `cancel_reason_code`, a nullable token of the domain's closed list with its
// `one_of`, and `route_cancel_reason_shape`, which keeps a code to a
// cancelled route and `regeneration` to a run's cancel — three ALTER TABLE
// statements diffed from 0016's spelling of the route (route-as-of.ts) to
// today's; execution-rendering.test.ts maps today's route back
// (`CHANGED_IN_0024`, first of its chain). Then migration 0024, which is
// exactly those three: a column on a table already fenced and touched needs
// no hand-written statement of its own (migrations/README.md), and nothing is
// backfilled. No database.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { ROUTE_CANCEL_REASON_CODES } from "@waste/domain/execution/vocabulary"

import { MIGRATIONS_FOLDER } from "../migrate"
import { route } from "../schema/execution"
import { normalised, statementsOf } from "../sql/hand-written"
import { checksOf, list, ref } from "./rendering"
import { routeAsOf } from "./route-as-of"
import { statementsBetween } from "./specimen"

const MIGRATION = "0024_route_cancel_reason.sql"

const SHAPE = `${ref("route", "cancel_reason_code")} is null or (${ref("route", "status")} = 'cancelled' and (${ref("route", "cancel_reason_code")} = 'regeneration') = ${ref("route", "cancelled_by_generation")})`

/** What 0024 does to `route`: the code as a column, held to the list, and the check that keeps it to a cancelled route. */
const altered = [
  `ALTER TABLE "wms"."route" ADD COLUMN "cancel_reason_code" text;`,
  `ALTER TABLE "wms"."route" ADD CONSTRAINT "route_cancel_reason_code_one_of" CHECK (${ref("route", "cancel_reason_code")} in (${list(...ROUTE_CANCEL_REASON_CODES)}));`,
  `ALTER TABLE "wms"."route" ADD CONSTRAINT "route_cancel_reason_shape" CHECK (${SHAPE});`,
]

/** The ALTER TABLEs as drizzle-kit writes them: the route from 0016's spelling to today's. */
const generatedAlterations = (): Promise<string[]> => statementsBetween({ route: routeAsOf("0016") }, { route })

const fileStatements = async (): Promise<string[]> => statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))

describe("the cancel's reason code as drizzle-kit writes it", () => {
  test("the route gains its reason code: a nullable token of the domain's list, and the check that keeps it to a cancelled route and the run's code to the run's cancel", async () => {
    assert.deepEqual(await generatedAlterations(), altered)
  })

  test("migration 0024 is exactly that, and nothing hand-written or backfilled: the fence and the trigger are the table's, and stand as 0008 wrote them", async () => {
    const statements = await fileStatements()
    assert.deepEqual(statements, altered.map(normalised))
    assert.equal(statements.filter((statement) => statement.startsWith("UPDATE ") || statement.startsWith("DO ")).length, 0)
  })

  test("the code is nullable text — null is a route not cancelled, or cancelled before the codes — and its two checks render without parameters", () => {
    assert.deepEqual({ sqlType: route.cancelReasonCode.getSQLType(), notNull: route.cancelReasonCode.notNull }, { sqlType: "text", notNull: false })
    assert.equal(checksOf(route).get("route_cancel_reason_shape"), SHAPE)
    assert.equal(checksOf(route).get("route_cancel_reason_code_one_of"), `${ref("route", "cancel_reason_code")} in (${list(...ROUTE_CANCEL_REASON_CODES)})`)
  })
})
