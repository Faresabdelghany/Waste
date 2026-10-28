// Time windows, shifts and breaks (O14 of #290) as the migration writes them:
// a property's and an agreement's service window, a driver's shift with its
// one break, an optimiser Plan's waiting seconds, and why a Plan's stop was
// ordered outside its window. drizzle-kit, diffing the
// snapshot before the migration against its own, writes exactly the columns
// and their checks, and the file is them under its header: no table is new,
// so nothing is hand-written, and every row present passes. The file is found
// by its name, not its number, which it takes at its turn. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { BREAK_MINUTES } from "@waste/domain/execution/shift"
import { generateMigration } from "drizzle-kit/api"

import { MIGRATIONS_FOLDER } from "../migrate"
import { agreement } from "../schema/agreements"
import { property } from "../schema/customers"
import { driver } from "../schema/fleet"
import { plan } from "../schema/routing"
import { normalised, statementsOf } from "../sql/hand-written"
import { checksOf, ref } from "./rendering"

const window = (table: string, start: string, end: string) => `(${ref(table, start)} is null) = (${ref(table, end)} is null) and (${ref(table, start)} is null or ${ref(table, end)} > ${ref(table, start)})`
const addColumn = (table: string, column: string, type: string) => `ALTER TABLE "wms"."${table}" ADD COLUMN "${column}" ${type};`
const addCheck = (table: string, name: string, text: string) => `ALTER TABLE "wms"."${table}" ADD CONSTRAINT "${name}" CHECK (${text});`

const BREAK_RANGE = `${ref("driver", "break_minutes")} between ${BREAK_MINUTES.min} and ${BREAK_MINUTES.max}`
const BREAK_SHAPE = `(${ref("driver", "break_minutes")} is null or ${ref("driver", "shift_start")} is not null) and (${ref("driver", "break_window_start")} is null or (${ref("driver", "break_minutes")} is not null and ${ref("driver", "break_window_start")} >= ${ref("driver", "shift_start")} and ${ref("driver", "break_window_end")} <= ${ref("driver", "shift_end")}))`
const WAITING_SHAPE = `${ref("plan", "waiting_seconds")} is null or (${ref("plan", "waiting_seconds")} >= 0 and ${ref("plan", "status")} = 'ready' and ${ref("plan", "solver")} = 'optimiser')`

const GREW = [
  addColumn("property", "service_window_start", "time"),
  addColumn("property", "service_window_end", "time"),
  addColumn("agreement", "service_window_start", "time"),
  addColumn("agreement", "service_window_end", "time"),
  addColumn("driver", "shift_start", "time"),
  addColumn("driver", "shift_end", "time"),
  addColumn("driver", "break_minutes", "integer"),
  addColumn("driver", "break_window_start", "time"),
  addColumn("driver", "break_window_end", "time"),
  addColumn("plan", "waiting_seconds", "integer"),
  addColumn("plan_stop", "window_warning", "text"),
  addCheck("property", "property_service_window", window("property", "service_window_start", "service_window_end")),
  addCheck("agreement", "agreement_service_window", window("agreement", "service_window_start", "service_window_end")),
  addCheck("driver", "driver_shift_window", window("driver", "shift_start", "shift_end")),
  addCheck("driver", "driver_break_window", window("driver", "break_window_start", "break_window_end")),
  addCheck("driver", "driver_break_minutes_range", BREAK_RANGE),
  addCheck("driver", "driver_break_shape", BREAK_SHAPE),
  addCheck("plan", "plan_waiting_shape", WAITING_SHAPE),
  addCheck("plan_stop", "plan_stop_window_warning_one_of", `${ref("plan_stop", "window_warning")} in ('windows-disjoint', 'window-unreachable')`),
]

/** The migration's file name, by its name: it takes its number at its turn. */
async function migrationName(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_time_windows\.sql$/.test(name))
  assert.ok(file !== undefined, "the time windows' migration")
  return file
}

type Snapshot = Parameters<typeof generateMigration>[0]
const snapshot = async (n: string): Promise<Snapshot> => JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${n}_snapshot.json`), "utf8")) as Snapshot

describe("time windows, shifts and breaks as the migration writes them", () => {
  test("drizzle-kit, diffing the snapshot before against the migration's own, adds the columns and their checks", async () => {
    const own = (await migrationName()).slice(0, 4)
    const before = String(Number(own) - 1).padStart(4, "0")
    assert.deepEqual((await generateMigration(await snapshot(before), await snapshot(own))).map(normalised).sort(), GREW.map(normalised).sort())
  })

  test("the migration is exactly those statements under its header, and nothing hand-written", async () => {
    const text = await readFile(join(MIGRATIONS_FOLDER, await migrationName()), "utf8")
    assert.deepEqual(statementsOf(text), GREW.map(normalised))
    assert.match(text, /^-- Time windows, shifts and breaks \(O14 of #290\)/)
  })

  test("the schema is what the statements make: nullable times and integers, and the checks the domain's bounds spell", () => {
    for (const column of [property.serviceWindowStart, property.serviceWindowEnd, agreement.serviceWindowStart, agreement.serviceWindowEnd, driver.shiftStart, driver.shiftEnd, driver.breakWindowStart, driver.breakWindowEnd]) {
      assert.deepEqual({ type: column.getSQLType(), notNull: column.notNull }, { type: "time", notNull: false }, column.name)
    }
    for (const column of [driver.breakMinutes, plan.waitingSeconds]) assert.deepEqual({ type: column.getSQLType(), notNull: column.notNull }, { type: "integer", notNull: false }, column.name)
    assert.equal(checksOf(property).get("property_service_window"), window("property", "service_window_start", "service_window_end"))
    assert.equal(checksOf(driver).get("driver_break_minutes_range"), BREAK_RANGE)
    assert.equal(checksOf(driver).get("driver_break_shape"), BREAK_SHAPE)
    assert.equal(checksOf(plan).get("plan_waiting_shape"), WAITING_SHAPE)
  })
})
