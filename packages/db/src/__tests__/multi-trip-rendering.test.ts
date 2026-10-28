// Multi-trip unloading (O15 of #290) as the migration writes it: a Plan's
// stop gains its kind — a pickup, or an unload visit on the way — and the
// station an unload visit names, the pickup no longer required of every stop.
// drizzle-kit, diffing the snapshot before the migration against its own,
// writes exactly the columns, the key and its index and the checks, and the
// file is them under its header: no table is new, so nothing is
// hand-written, and every row present is a pickup by the column's default.
// The file is found by its name, not its number, which it takes at its turn.
// No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { generateMigration } from "drizzle-kit/api"

import { MIGRATIONS_FOLDER } from "../migrate"
import { planStop } from "../schema/routing"
import { normalised, statementsOf } from "../sql/hand-written"
import { checksOf, ref } from "./rendering"

const KIND_SHAPE = `case ${ref("plan_stop", "kind")} when 'pickup' then ${ref("plan_stop", "pickup_id")} is not null and ${ref("plan_stop", "unloading_station_id")} is null else ${ref("plan_stop", "pickup_id")} is null and ${ref("plan_stop", "unloading_station_id")} is not null and ${ref("plan_stop", "window_warning")} is null end`

const GREW = [
  `ALTER TABLE "wms"."plan_stop" ALTER COLUMN "pickup_id" DROP NOT NULL;`,
  `ALTER TABLE "wms"."plan_stop" ADD COLUMN "kind" text DEFAULT 'pickup' NOT NULL;`,
  `ALTER TABLE "wms"."plan_stop" ADD COLUMN "unloading_station_id" uuid;`,
  `ALTER TABLE "wms"."plan_stop" ADD CONSTRAINT "plan_stop_unloading_station_id_fk" FOREIGN KEY ("company_id","unloading_station_id") REFERENCES "wms"."unloading_station"("company_id","id") ON DELETE no action ON UPDATE no action;`,
  `CREATE INDEX "plan_stop_unloading_station_id_idx" ON "wms"."plan_stop" USING btree ("company_id","unloading_station_id");`,
  `ALTER TABLE "wms"."plan_stop" ADD CONSTRAINT "plan_stop_kind_one_of" CHECK (${ref("plan_stop", "kind")} in ('pickup', 'unload'));`,
  `ALTER TABLE "wms"."plan_stop" ADD CONSTRAINT "plan_stop_kind_shape" CHECK (${KIND_SHAPE});`,
]

/** The migration's file name, by its name: it takes its number at its turn. */
async function migrationName(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_multi_trip_unloading\.sql$/.test(name))
  assert.ok(file !== undefined, "the multi-trip unloading migration")
  return file
}

type Snapshot = Parameters<typeof generateMigration>[0]
const snapshot = async (n: string): Promise<Snapshot> => JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${n}_snapshot.json`), "utf8")) as Snapshot

describe("multi-trip unloading as the migration writes it", () => {
  test("drizzle-kit, diffing the snapshot before against the migration's own, adds the kind, the station and their checks", async () => {
    const own = (await migrationName()).slice(0, 4)
    const before = String(Number(own) - 1).padStart(4, "0")
    assert.deepEqual((await generateMigration(await snapshot(before), await snapshot(own))).map(normalised).sort(), GREW.map(normalised).sort())
  })

  test("the migration is exactly those statements under its header, and nothing hand-written", async () => {
    const text = await readFile(join(MIGRATIONS_FOLDER, await migrationName()), "utf8")
    assert.deepEqual(statementsOf(text), GREW.map(normalised))
    assert.match(text, /^-- Multi-trip unloading \(O15 of #290\)/)
  })

  test("the schema is what the statements make: a kind every stop has, a pickup and a station each stop may lack, and the shape that says which", () => {
    assert.deepEqual({ type: planStop.kind.getSQLType(), notNull: planStop.kind.notNull }, { type: "text", notNull: true })
    for (const column of [planStop.pickupId, planStop.unloadingStationId]) assert.deepEqual({ type: column.getSQLType(), notNull: column.notNull }, { type: "uuid", notNull: false }, column.name)
    assert.equal(checksOf(planStop).get("plan_stop_kind_shape"), KIND_SHAPE)
  })
})
