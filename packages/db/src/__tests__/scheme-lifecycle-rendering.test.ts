// A Route Scheme's lifecycle (O21 of #290) as the migration writes it: the
// scheme's Plan Ahead window, `plan_ahead_days`, held to the domain's bounds,
// and the mark an archive leaves, `archived_at`, with the shape that keeps an
// archived scheme's Plan Ahead off. drizzle-kit, diffing the snapshot before
// the migration against its own, writes exactly the columns and their checks,
// and the file is them under its header: no table is new, so nothing is
// hand-written, and every row present passes. The file is found by its name,
// not its number, which it takes at its turn. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { PLAN_AHEAD_DAYS_DEFAULT, PLAN_AHEAD_DAYS_MAX } from "@waste/domain/planning/lifecycle"
import { generateMigration } from "drizzle-kit/api"

import { MIGRATIONS_FOLDER } from "../migrate"
import { routeScheme } from "../schema/route-schemes"
import { normalised, statementsOf } from "../sql/hand-written"
import { checksOf, ref } from "./rendering"

const RANGE = `${ref("route_scheme", "plan_ahead_days")} between 1 and ${PLAN_AHEAD_DAYS_MAX}`
const ARCHIVED_SHAPE = `${ref("route_scheme", "archived_at")} is null or not ${ref("route_scheme", "plan_ahead")}`

const GREW = [
  `ALTER TABLE "wms"."route_scheme" ADD COLUMN "plan_ahead_days" integer DEFAULT ${PLAN_AHEAD_DAYS_DEFAULT} NOT NULL;`,
  `ALTER TABLE "wms"."route_scheme" ADD COLUMN "archived_at" timestamp with time zone;`,
  `ALTER TABLE "wms"."route_scheme" ADD CONSTRAINT "route_scheme_plan_ahead_days_range" CHECK (${RANGE});`,
  `ALTER TABLE "wms"."route_scheme" ADD CONSTRAINT "route_scheme_archived_shape" CHECK (${ARCHIVED_SHAPE});`,
]

/** The migration's file name, by its name: it takes its number at its turn. */
async function migrationName(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_scheme_lifecycle\.sql$/.test(name))
  assert.ok(file !== undefined, "the scheme lifecycle's migration")
  return file
}

type Snapshot = Parameters<typeof generateMigration>[0]
const snapshot = async (n: string): Promise<Snapshot> => JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${n}_snapshot.json`), "utf8")) as Snapshot

describe("a route scheme's lifecycle as the migration writes it", () => {
  test("drizzle-kit, diffing the snapshot before against the migration's own, adds the two columns and their checks", async () => {
    const own = (await migrationName()).slice(0, 4)
    const before = String(Number(own) - 1).padStart(4, "0")
    assert.deepEqual((await generateMigration(await snapshot(before), await snapshot(own))).map(normalised).sort(), GREW.map(normalised).sort())
  })

  test("the migration is exactly those statements under its header, and nothing hand-written", async () => {
    const text = await readFile(join(MIGRATIONS_FOLDER, await migrationName()), "utf8")
    assert.deepEqual(statementsOf(text), GREW.map(normalised))
    assert.match(text, /^-- A Route Scheme's lifecycle \(O21 of #290\)/)
  })

  test("the schema is what the statements make: a window of 7 by default, an instant null while the scheme plans", () => {
    assert.deepEqual({ type: routeScheme.planAheadDays.getSQLType(), notNull: routeScheme.planAheadDays.notNull, default: routeScheme.planAheadDays.default }, { type: "integer", notNull: true, default: PLAN_AHEAD_DAYS_DEFAULT })
    assert.deepEqual({ type: routeScheme.archivedAt.getSQLType(), notNull: routeScheme.archivedAt.notNull }, { type: "timestamp with time zone", notNull: false })
    assert.equal(checksOf(routeScheme).get("route_scheme_plan_ahead_days_range"), RANGE)
    assert.equal(checksOf(routeScheme).get("route_scheme_archived_shape"), ARCHIVED_SHAPE)
  })
})
