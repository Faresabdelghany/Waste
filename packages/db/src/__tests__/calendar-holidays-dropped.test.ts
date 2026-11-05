// The calendars' holidays dropped (2026-11-05): the migration is the guard
// (src/sql/holiday-lists.ts), then drizzle-kit's drop of
// `collection_calendar_holiday` and nothing else, the guard first, the file
// found by its name, not its number. Then, against a fresh database migrated
// and seeded, the guard itself over the table as it stood (schema/dropped.ts,
// made as a specimen inside a transaction that always rolls back): it passes
// while every calendar holiday's day is on the list its project names, and
// refuses a day off that list and a day of a project that names no list.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { after, before, describe, test } from "node:test"

import { sql } from "drizzle-orm"
import { generateMigration } from "drizzle-kit/api"

import { createDb, type Database } from "../client"
import { migrateDatabase, MIGRATIONS_FOLDER } from "../migrate"
import { collectionCalendarHoliday } from "../schema/dropped"
import { DEMO_IDS, seedDemo } from "../seed/demo"
import { normalised, statementsOf } from "../sql/hand-written"
import { calendarHolidaysOnLists } from "../sql/holiday-lists"
import { databaseUnderTest, freshDatabase, type FreshDatabase } from "./database"
import { refusedWith, withSpecimen, type Tx } from "./specimen"

const DROP = 'DROP TABLE "wms"."collection_calendar_holiday" CASCADE;'

async function migrationName(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_calendar_holidays_dropped\.sql$/.test(name))
  assert.ok(file !== undefined, "the calendar holidays' drop")
  return file
}

type Snapshot = Parameters<typeof generateMigration>[0]
const snapshot = async (n: string): Promise<Snapshot> => JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${n}_snapshot.json`), "utf8")) as Snapshot

describe("the calendar holidays' drop as the migration writes it", () => {
  test("drizzle-kit writes the table's drop and nothing else", async () => {
    const own = (await migrationName()).slice(0, 4)
    const generated = await generateMigration(await snapshot(String(Number(own) - 1).padStart(4, "0")), await snapshot(own))
    assert.deepEqual(generated.map(normalised), [normalised(DROP)])
  })

  test("is the guard, then the drop: the table is never dropped bare", async () => {
    const text = await readFile(join(MIGRATIONS_FOLDER, await migrationName()), "utf8")
    assert.deepEqual(statementsOf(text), [calendarHolidaysOnLists(), DROP].map(normalised))
    assert.match(text, /^-- The calendars' holidays dropped \(2026-11-05\)/)
  })

  test("the guard counts the days off the list their project names, a project naming none included, and raises before the drop", () => {
    const guard = calendarHolidaysOnLists()
    assert.match(guard, /^DO \$\$/)
    assert.match(guard, /WHERE NOT EXISTS \(SELECT 1 FROM "wms"\."holiday_list" AS l JOIN "wms"\."holiday_list_holiday" AS d .* l\."name" = p\."holiday_list" AND d\."day" = h\."day"\)/)
    assert.match(guard, /RAISE EXCEPTION 'collection_calendar_holiday still holds % day\(s\)/)
  })
})

const database = databaseUnderTest()

describe("the guard against the table as it stood", { skip: database.skip }, () => {
  let fresh: FreshDatabase
  let owner: Database
  const { company, projects, planning } = DEMO_IDS
  const central = { companyId: company, projectId: projects.copenhagen, collectionCalendarId: planning.collectionCalendars["calendar-central"] }
  const harbor = { companyId: company, projectId: projects.harbor, collectionCalendarId: planning.collectionCalendars["calendar-harbor"] }

  before(async () => {
    fresh = await freshDatabase(database.adminUrl, "waste_calendar_holidays_dropped")
    await migrateDatabase(fresh.url)
    await seedDemo(fresh.url)
    owner = createDb(fresh.url, { max: 1 })
  })
  after(async () => {
    await owner?.close()
    await fresh?.drop()
  })

  const guarded = (tx: Tx) => tx.transaction((savepoint) => savepoint.execute(sql.raw(calendarHolidaysOnLists())))

  test("passes on an empty table, and on days the project's list holds", async () => {
    await withSpecimen(owner.db, { collectionCalendarHoliday }, async (tx) => {
      await guarded(tx)
      // Grundlovsdag and Christmas Day, on the seeded Danish list Copenhagen Central names.
      await tx.insert(collectionCalendarHoliday).values([
        { ...central, day: "2026-06-05", name: "Grundlovsdag" },
        { ...central, day: "2026-12-25", name: "Juledag" },
      ])
      await guarded(tx)
    })
  })

  test("refuses a day the project's list does not hold, counting it", async () => {
    await withSpecimen(owner.db, { collectionCalendarHoliday }, async (tx) => {
      await tx.insert(collectionCalendarHoliday).values([
        { ...central, day: "2026-06-05", name: "Grundlovsdag" },
        { ...central, day: "2026-07-01", name: "Not on the list" },
      ])
      await assert.rejects(guarded(tx), refusedWith("P0001", /still holds 1 day\(s\) that are not on the holiday list.*2026-07-01/))
    })
  })

  test("refuses a day of a project that names no list", async () => {
    await withSpecimen(owner.db, { collectionCalendarHoliday }, async (tx) => {
      await tx.insert(collectionCalendarHoliday).values({ ...harbor, day: "2026-12-25", name: null })
      await assert.rejects(guarded(tx), refusedWith("P0001", /still holds 1 day\(s\)/))
    })
  })
})
