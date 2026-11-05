// Holiday Lists (2026-11-05) as the migration writes them: two new tables,
// the company's list by country and name, each once, and the list's days, one
// per day; the Project's list name a key into the lists by name, following a
// rename. Then the file: drizzle-kit's statements, the Project's key and its
// index moved below the three hand-written statements that make a list of
// every name the projects carry, put every project on its country's list and
// copy the projects' calendar holidays onto the lists
// (src/sql/holiday-lists.ts), so the key holds when it is added; then the
// tables' fences, triggers and audit trail, and the public door's grants and
// policies. The file is found by its name, not its number. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { generateMigration } from "drizzle-kit/api"

import { MIGRATIONS_FOLDER } from "../migrate"
import { holidayList, holidayListHoliday } from "../schema/organisation"
import { auditTrail, HOLIDAY_LISTS_AUDITED } from "../sql/audit-trail"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { holidayListsBackfill, holidaysFromCalendars, holidayListsFromProjects, projectsOntoTheirList } from "../sql/holiday-lists"
import { holidayListsDoorStatements } from "../sql/public-door"
import { checksOf, ref } from "./rendering"

const KEY = 'ALTER TABLE "wms"."project" ADD CONSTRAINT "project_holiday_list_fk" FOREIGN KEY ("company_id","holiday_list") REFERENCES "wms"."holiday_list"("company_id","name") ON DELETE no action ON UPDATE cascade;'
const KEY_INDEX = 'CREATE INDEX "project_holiday_list_idx" ON "wms"."project" USING btree ("company_id","holiday_list");'

async function migrationName(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_holiday_lists\.sql$/.test(name))
  assert.ok(file !== undefined, "the holiday lists' migration")
  return file
}

type Snapshot = Parameters<typeof generateMigration>[0]
const snapshot = async (n: string): Promise<Snapshot> => JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${n}_snapshot.json`), "utf8")) as Snapshot

/** What drizzle-kit writes for the migration, diffing the snapshot before against its own. */
async function generated(): Promise<string[]> {
  const own = (await migrationName()).slice(0, 4)
  return (await generateMigration(await snapshot(String(Number(own) - 1).padStart(4, "0")), await snapshot(own))).map(normalised)
}

describe("the holiday lists as drizzle-kit writes them", () => {
  test("a list is the company's, by a two-letter country and a name each once; a day is one list's once; a project names its list by name, and a rename follows", async () => {
    const statements = await generated()
    assert.ok(statements.includes(normalised(KEY)))
    assert.ok(statements.includes(normalised(KEY_INDEX)))
    assert.ok(statements.some((statement) => statement.includes('CONSTRAINT "holiday_list_country_key" UNIQUE("company_id","country")')))
    assert.ok(statements.some((statement) => statement.includes('CONSTRAINT "holiday_list_name_key" UNIQUE("company_id","name")')))
    assert.ok(statements.some((statement) => statement.includes('CONSTRAINT "holiday_list_holiday_holiday_list_id_day_key" UNIQUE("company_id","holiday_list_id","day")')))
    assert.equal(checksOf(holidayList).get("holiday_list_country_shape"), `${ref("holiday_list", "country")} ~ '^[A-Z]{2}$'`)
  })
})

describe("the holiday lists' migration", () => {
  test("is drizzle-kit's statements, the project's key and its index last of them, after the backfill; then the fences, the triggers, the audit trail and the public door", async () => {
    const text = await readFile(join(MIGRATIONS_FOLDER, await migrationName()), "utf8")
    const statements = statementsOf(text)
    const drizzle = await generated()
    const moved = [normalised(KEY), normalised(KEY_INDEX)]
    const head = drizzle.filter((statement) => !moved.includes(statement))
    assert.deepEqual([...statements.slice(0, head.length)].sort(), [...head].sort())
    assert.deepEqual(
      statements.slice(head.length),
      [...holidayListsBackfill(), KEY, KEY_INDEX, ...handWrittenStatements(holidayList), ...handWrittenStatements(holidayListHoliday), ...HOLIDAY_LISTS_AUDITED.flatMap(auditTrail), ...holidayListsDoorStatements()].map(normalised),
    )
    assert.match(text, /^-- Holiday Lists \(Settings › Operations › Holiday lists, 2026-11-05\)/)
  })

  test("the backfill makes a list per company and country, the known names of their own country and any other of the company's; puts each project on its country's list; and copies its calendars' days once a day", () => {
    assert.match(holidayListsFromProjects(), /CASE p\."holiday_list" WHEN 'Danish public holidays' THEN 'DK' WHEN 'Egyptian public holidays' THEN 'EG' ELSE c\."country" END/)
    assert.match(holidayListsFromProjects(), /SELECT DISTINCT ON \(named\."company_id", named\."country"\)/)
    assert.match(projectsOntoTheirList(), /target\."holiday_list" IS DISTINCT FROM l\."name";$/)
    assert.match(holidaysFromCalendars(), /max\(h\."name"\) FROM "wms"\."collection_calendar_holiday" AS h .* GROUP BY h\."company_id", l\."id", h\."day";$/)
    assert.equal(holidayListHoliday.day.name, "day")
  })
})
