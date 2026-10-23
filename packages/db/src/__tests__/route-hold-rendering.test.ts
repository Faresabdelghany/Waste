// The route's hold (#209) as drizzle-kit writes it: `held_at`, the instant
// the office last moved a planned route's day, start or Planned Assignment by
// hand, and `route_hold_shape`, which keeps a hold on a planned route alone —
// two ALTER TABLE statements diffed from 0013's spelling (route-as-of.ts),
// since an applied file is never edited; execution-rendering.test.ts maps
// today's route back (`CHANGED_IN_0015`). Then migration 0015, which is
// exactly those two: a column on a table already fenced and touched needs no
// hand-written statement of its own (migrations/README.md). No database.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { MIGRATIONS_FOLDER } from "../migrate"
import { route } from "../schema/execution"
import { normalised, statementsOf } from "../sql/hand-written"
import { checksOf, ref } from "./rendering"
import { routeAsOf } from "./route-as-of"
import { statementsBetween } from "./specimen"

const MIGRATION = "0015_route_hold.sql"
const INSTANT = "timestamp with time zone"

/** What 0015 does to `route`: the hold as a column, and the check that keeps it to a planned route. */
const altered = [
  `ALTER TABLE "wms"."route" ADD COLUMN "held_at" ${INSTANT};`,
  `ALTER TABLE "wms"."route" ADD CONSTRAINT "route_hold_shape" CHECK (${ref("route", "held_at")} is null or ${ref("route", "status")} = 'planned');`,
]

/** The ALTER TABLEs as drizzle-kit writes them: the route from 0013's spelling to today's. */
const generatedAlterations = (): Promise<string[]> => statementsBetween({ route: routeAsOf("0013") }, { route })

const fileStatements = async (): Promise<string[]> => statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))

describe("the route's hold as drizzle-kit writes it", () => {
  test("the route gains its hold: a nullable instant and the check that keeps it to a planned route", async () => {
    assert.deepEqual(await generatedAlterations(), altered)
  })

  test("migration 0015 is exactly that, and nothing hand-written: the fence and the trigger are the table's, and stand as 0008 wrote them", async () => {
    assert.deepEqual(await fileStatements(), altered.map(normalised))
  })

  test("the hold is an instant, nullable — null is a route that is the scheme's — and its check renders without parameters", () => {
    assert.deepEqual({ dataType: route.heldAt.dataType, sqlType: route.heldAt.getSQLType(), notNull: route.heldAt.notNull }, { dataType: "date", sqlType: INSTANT, notNull: false })
    assert.equal(checksOf(route).get("route_hold_shape"), `${ref("route", "held_at")} is null or ${ref("route", "status")} = 'planned'`)
  })
})
