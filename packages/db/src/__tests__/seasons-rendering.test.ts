// A Route Scheme's Seasons (O17 of #290) as drizzle-kit writes them: one new
// table, the scheme's set, with its cadence held to the season vocabulary,
// its rotation to every-2-weeks, its two month-days to days every year has
// and apart from each other. Then migration 0055, which is exactly those
// statements, then what the table owes the file by migrations/README.md: its
// fence and trigger, its audit trail as its scheme's set
// (`SEASONS_AUDITED`), and the public door's grant and policy, since the
// collection days read a season (`SEASONS_DOOR`). No database.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { SEASON_FREQUENCIES } from "@waste/domain/planning/vocabulary"
import { MONTH_DAY_SOURCE } from "@waste/domain/route-schemes/seasons"

import { MIGRATIONS_FOLDER } from "../migrate"
import { company, project } from "../schema/organisation"
import { routeScheme, routeSchemeSeason } from "../schema/route-schemes"
import { auditTrail, SEASONS_AUDITED } from "../sql/audit-trail"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { SEASONS_DOOR, seasonsDoorStatements } from "../sql/public-door"
import { checksOf, list, ref } from "./rendering"
import { statementsBetween } from "./specimen"

const MIGRATION = "0055_seasonal_frequencies.sql"

const referenced = { company, project, routeScheme }

/** What drizzle-kit writes for 0055: the one table. */
const generated = (): Promise<string[]> => statementsBetween(referenced, { ...referenced, routeSchemeSeason })

/** What the table owes the file below drizzle-kit's statements: its fence and trigger, its audit trail, then the public door's grant and policy. */
const handWritten = [...handWrittenStatements(routeSchemeSeason), ...SEASONS_AUDITED.flatMap(auditTrail), ...seasonsDoorStatements()]

const fileStatements = async (): Promise<string[]> => statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))

const column = (name: string) => ref("route_scheme_season", name)

describe("the seasons as drizzle-kit writes them", () => {
  test("a season is its scheme's, by name once, and keys into the scheme through its project", async () => {
    const statements = await generated()
    for (const expected of [
      'ALTER TABLE "wms"."route_scheme_season" ADD CONSTRAINT "route_scheme_season_route_scheme_id_fk" FOREIGN KEY ("company_id","project_id","route_scheme_id") REFERENCES "wms"."route_scheme"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;',
      'CREATE INDEX "route_scheme_season_project_id_idx" ON "wms"."route_scheme_season" USING btree ("company_id","project_id");',
    ]) {
      assert.ok(statements.includes(expected), expected)
    }
    assert.match(statements[0], /CONSTRAINT "route_scheme_season_route_scheme_id_name_key" UNIQUE\("company_id","route_scheme_id","name"\)/)
  })

  test("its cadence is a season's, its rotation every-2-weeks', its days days every year has, and apart", () => {
    const checks = checksOf(routeSchemeSeason)
    assert.equal(checks.get("route_scheme_season_frequency_one_of"), `${column("frequency")} in (${list(...SEASON_FREQUENCIES)})`)
    assert.equal(checks.get("route_scheme_season_week_rotation_shape"), `(${column("frequency")} = 'every-2-weeks') = (${column("week_rotation")} is not null)`)
    assert.equal(checks.get("route_scheme_season_starts_on_shape"), `${column("starts_on")} ~ '${MONTH_DAY_SOURCE}'`)
    assert.equal(checks.get("route_scheme_season_ends_on_shape"), `${column("ends_on")} ~ '${MONTH_DAY_SOURCE}'`)
    assert.equal(checks.get("route_scheme_season_span"), `${column("starts_on")} <> ${column("ends_on")}`)
    assert.ok(!SEASON_FREQUENCIES.includes("daily" as never))
  })
})

describe("migration 0055", () => {
  test("begins with exactly what drizzle-kit generates for it", async () => {
    const statements = await fileStatements()
    const head = (await generated()).map(normalised)
    assert.deepEqual(statements.slice(0, head.length), head)
  })

  test("the public door reads a season's days and cadence under its scheme and its keys, nothing more, under one policy", () => {
    assert.deepEqual(SEASONS_DOOR.map(({ columns }) => columns.length), [8])
    const statements = seasonsDoorStatements()
    assert.equal(statements.filter((statement) => statement.startsWith("GRANT SELECT (")).length, 1)
    assert.equal(statements.filter((statement) => statement.startsWith("CREATE POLICY ")).length, 1)
  })

  test("and carries below them the table's fence, trigger, audit trail and public door, in that order", async () => {
    const statements = await fileStatements()
    const head = (await generated()).length
    assert.deepEqual(statements.slice(head), handWritten.map(normalised))
    assert.equal(SEASONS_AUDITED.length, 1, "the seasons")
  })
})
