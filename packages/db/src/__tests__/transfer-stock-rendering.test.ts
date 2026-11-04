// A transfer station's haul-out (M17 of #293, row 28.3) as the migration
// writes it: an Unloading Station may be a transfer station; an Outbound Load
// of a project leaves one station for another, of a fraction, carried by our
// vehicle of the project or a hauler, its out-weighing an Unload's shape, the
// receiving site's ticket there exactly while it is received, a dispute or a
// cancellation saying why, its costs never negative; and the adjustments, a
// ledger, never zero. Then the file: drizzle-kit's statements, then the load's
// fence, touch and audit trail, then the adjustments' fence and revoke. The
// file is found by its name and its snapshots by its journal entry, since its
// number waits for its turn in the queue. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { OUTBOUND_LOAD_STATUSES } from "@waste/domain/execution/vocabulary"
import { generateMigration } from "drizzle-kit/api"

import { MIGRATIONS_FOLDER } from "../migrate"
import { materialAdjustment, outboundLoad } from "../schema/haul-out"
import { auditTrail, HAUL_OUT_AUDITED } from "../sql/audit-trail"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { checksOf, list, ref } from "./rendering"

async function migrationName(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_transfer_stock\.sql$/.test(name))
  assert.ok(file !== undefined, "the transfer stock's migration")
  return file
}

type Snapshot = Parameters<typeof generateMigration>[0]
const snapshot = async (idx: number): Promise<Snapshot> => JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${String(idx).padStart(4, "0")}_snapshot.json`), "utf8")) as Snapshot

/** What drizzle-kit writes for the migration, diffing the snapshot before against its own, both found by the journal's index of its tag. */
async function generated(): Promise<string[]> {
  const tag = (await migrationName()).replace(/\.sql$/, "")
  const journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] }
  const entry = journal.entries.find((each) => each.tag === tag)
  assert.ok(entry !== undefined, `${tag} in the journal`)
  return (await generateMigration(await snapshot(entry.idx - 1), await snapshot(entry.idx))).map(normalised)
}

describe("the transfer stock as drizzle-kit writes it", () => {
  test("a station may be a transfer station, off for every station there is", async () => {
    assert.ok((await generated()).includes(normalised('ALTER TABLE "wms"."unloading_station" ADD COLUMN "transfer" boolean DEFAULT false NOT NULL;')))
  })

  test("a load names two stations and a fraction of the company, our vehicle of its project or a hauler, and its shapes hold the weights, the receipt, the note and the costs", async () => {
    const statements = await generated()
    for (const statement of [
      'ALTER TABLE "wms"."outbound_load" ADD CONSTRAINT "outbound_load_from_station_id_fk" FOREIGN KEY ("company_id","from_station_id") REFERENCES "wms"."unloading_station"("company_id","id") ON DELETE no action ON UPDATE no action;',
      'ALTER TABLE "wms"."outbound_load" ADD CONSTRAINT "outbound_load_to_station_id_fk" FOREIGN KEY ("company_id","to_station_id") REFERENCES "wms"."unloading_station"("company_id","id") ON DELETE no action ON UPDATE no action;',
      'ALTER TABLE "wms"."outbound_load" ADD CONSTRAINT "outbound_load_vehicle_id_fk" FOREIGN KEY ("company_id","project_id","vehicle_id") REFERENCES "wms"."vehicle"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;',
      'ALTER TABLE "wms"."outbound_load" ADD CONSTRAINT "outbound_load_service_provider_id_fk" FOREIGN KEY ("company_id","service_provider_id") REFERENCES "wms"."service_provider"("company_id","id") ON DELETE no action ON UPDATE no action;',
      'CREATE INDEX "outbound_load_from_station_idx" ON "wms"."outbound_load" USING btree ("company_id","from_station_id","waste_fraction_id");',
      'CREATE INDEX "material_adjustment_station_idx" ON "wms"."material_adjustment" USING btree ("company_id","unloading_station_id","waste_fraction_id","id");',
    ]) {
      assert.ok(statements.includes(normalised(statement)), statement)
    }
    // The key an alert about the load points at (part 2), held to the alert's own project.
    assert.match(statements.find((statement) => statement.startsWith('CREATE TABLE "wms"."outbound_load"')) ?? "", /CONSTRAINT "outbound_load_project_key" UNIQUE\("company_id","project_id","id"\)/)
    const load = checksOf(outboundLoad)
    const column = (name: string) => ref("outbound_load", name)
    assert.equal(load.get("outbound_load_status_one_of"), `${column("status")} in (${list(...OUTBOUND_LOAD_STATUSES)})`)
    assert.equal(load.get("outbound_load_stations_apart"), `${column("from_station_id")} <> ${column("to_station_id")}`)
    assert.equal(load.get("outbound_load_weights_shape"), `(${column("gross_kg")} is null) = (${column("tare_kg")} is null) and (${column("gross_kg")} is null or ${column("net_kg")} = ${column("gross_kg")} - ${column("tare_kg")})`)
    assert.equal(
      load.get("outbound_load_receipt_shape"),
      `(${column("status")} in (${list("received", "reconciled", "disputed")})) = (${column("receiving_ticket")} is not null) and (${column("receiving_ticket")} is null) = (${column("received_net_kg")} is null) and (${column("receiving_ticket")} is null) = (${column("received_at")} is null)`,
    )
    assert.equal(load.get("outbound_load_note_shape"), `${column("status")} not in ('disputed', 'cancelled') or ${column("note")} is not null`)
    assert.equal(checksOf(materialAdjustment).get("material_adjustment_delta_not_zero"), `${ref("material_adjustment", "delta_kg")} <> 0`)
  })
})

describe("the transfer stock's migration", () => {
  test("is drizzle-kit's statements, then the load's, then the adjustments' as a ledger", async () => {
    const text = await readFile(join(MIGRATIONS_FOLDER, await migrationName()), "utf8")
    const statements = statementsOf(text)
    const drizzle = await generated()
    const [loadTrail] = HAUL_OUT_AUDITED.map(auditTrail)
    assert.deepEqual([...statements.slice(0, drizzle.length)].sort(), [...drizzle].sort())
    assert.deepEqual(statements.slice(drizzle.length), [...handWrittenStatements(outboundLoad), ...loadTrail!, ...handWrittenStatements(materialAdjustment)].map(normalised))
    assert.match(text, /^-- A transfer station's haul-out \(M17 of #293, row 28\.3\)/)
  })

  test("a load's history is its own, under Route Studio › Weights beside the Unloads; the adjustments keep none", () => {
    assert.deepEqual(
      HAUL_OUT_AUDITED.map((entry) => [entry.table, entry.module, entry.parent]),
      [[outboundLoad, "route-studio.weights", undefined]],
    )
  })
})
