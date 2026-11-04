// The scale house (M16a of #293) as drizzle-kit writes it: the tare register,
// one active tare per plate, trailer and container; the window's ticket,
// keyed into its site and its account through the company and into its
// vehicle, agreement, registered tare, route and Unload through its project,
// numbered once in the company, with its party's, weighing's, void's and
// match's shapes; its lines, a ledger, one per position; and the company's
// counter. Then the migration, whose head is drizzle-kit's diff and whose tail
// is the tare's and the ticket's statements and the lines' as a ledger. The
// file is found by its name, and its snapshot by the journal's entry for it,
// since it takes its number at its turn. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { SCALE_TICKET_PARTIES, SCALE_TICKET_STATUSES, TARE_SOURCES } from "@waste/domain/scale-house/vocabulary"
import { generateMigration } from "drizzle-kit/api"

import { MIGRATIONS_FOLDER } from "../migrate"
import { scaleTicket, scaleTicketLine, vehicleTare } from "../schema/scale-house"
import { auditTrail, SCALE_HOUSE_AUDITED } from "../sql/audit-trail"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { checksOf, list, ref } from "./rendering"

async function migrationName(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_scale_house\.sql$/.test(name))
  assert.ok(file !== undefined, "the scale house's migration")
  return file
}

type Snapshot = Parameters<typeof generateMigration>[0]
const snapshot = async (idx: number): Promise<Snapshot> => JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${String(idx).padStart(4, "0")}_snapshot.json`), "utf8")) as Snapshot

/** What drizzle-kit writes for the migration, diffing the snapshot before against its own, by the journal's index for the file. */
async function generated(): Promise<string[]> {
  const tag = (await migrationName()).replace(/\.sql$/, "")
  const journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] }
  const entry = journal.entries.find((row) => row.tag === tag)
  assert.ok(entry !== undefined, `the journal's entry for ${tag}`)
  return (await generateMigration(await snapshot(entry.idx - 1), await snapshot(entry.idx))).map(normalised)
}

describe("the scale house as drizzle-kit writes it", () => {
  test("a ticket names its site and account through the company, the rest through its project, and is numbered once; a line names its ticket; a tare is active once per key", async () => {
    const statements = await generated()
    for (const statement of [
      'ALTER TABLE "wms"."company" ADD COLUMN "next_scale_ticket_number" integer DEFAULT 1000 NOT NULL;',
      'ALTER TABLE "wms"."scale_ticket" ADD CONSTRAINT "scale_ticket_unloading_station_id_fk" FOREIGN KEY ("company_id","unloading_station_id") REFERENCES "wms"."unloading_station"("company_id","id") ON DELETE no action ON UPDATE no action;',
      'ALTER TABLE "wms"."scale_ticket" ADD CONSTRAINT "scale_ticket_unload_id_fk" FOREIGN KEY ("company_id","project_id","unload_id") REFERENCES "wms"."unload"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;',
      'ALTER TABLE "wms"."scale_ticket" ADD CONSTRAINT "scale_ticket_agreement_id_fk" FOREIGN KEY ("company_id","project_id","agreement_id") REFERENCES "wms"."agreement"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;',
      'ALTER TABLE "wms"."scale_ticket" ADD CONSTRAINT "scale_ticket_vehicle_tare_id_fk" FOREIGN KEY ("company_id","project_id","vehicle_tare_id") REFERENCES "wms"."vehicle_tare"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;',
      'ALTER TABLE "wms"."scale_ticket_line" ADD CONSTRAINT "scale_ticket_line_ticket_id_fk" FOREIGN KEY ("company_id","project_id","ticket_id") REFERENCES "wms"."scale_ticket"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;',
      'CREATE INDEX "scale_ticket_station_status_idx" ON "wms"."scale_ticket" USING btree ("company_id","unloading_station_id","status","weighed_out_at");',
      `CREATE UNIQUE INDEX "vehicle_tare_active_key" ON "wms"."vehicle_tare" USING btree ("company_id","project_id","plate",coalesce("trailer_plate", ''),coalesce("container_ref", '')) WHERE "wms"."vehicle_tare"."status" = 'active';`,
    ]) {
      assert.ok(statements.includes(normalised(statement)), statement)
    }
    assert.match(statements.find((statement) => statement.startsWith('CREATE TABLE "wms"."scale_ticket"')) ?? "", /CONSTRAINT "scale_ticket_number_key" UNIQUE\("company_id","number"\)/)
    assert.match(statements.find((statement) => statement.startsWith('CREATE TABLE "wms"."scale_ticket_line"')) ?? "", /CONSTRAINT "scale_ticket_line_ticket_id_position_key" UNIQUE\("company_id","ticket_id","position"\)/)
  })

  test("the ticket's shapes", () => {
    const column = (name: string) => ref("scale_ticket", name)
    const checks = checksOf(scaleTicket)
    assert.equal(checks.get("scale_ticket_party_one_of"), `${column("party")} in (${list(...SCALE_TICKET_PARTIES)})`)
    assert.equal(checks.get("scale_ticket_status_one_of"), `${column("status")} in (${list(...SCALE_TICKET_STATUSES)})`)
    assert.equal(checks.get("scale_ticket_tare_source_one_of"), `${column("tare_source")} in (${list(...TARE_SOURCES)})`)
    assert.equal(
      checks.get("scale_ticket_party_shape"),
      `case when ${column("party")} = 'account' then ${column("customer_id")} is not null and ${column("agreement_id")} is not null else ${column("customer_id")} is null and ${column("agreement_id")} is null end`,
    )
    assert.match(checks.get("scale_ticket_weighing_shape") ?? "", new RegExp(`${column("net_kg").replaceAll(".", "\\.")} = ${column("gross_kg").replaceAll(".", "\\.")} - ${column("tare_kg").replaceAll(".", "\\.")}`))
    assert.match(checks.get("scale_ticket_void_shape") ?? "", /'other'/)
    assert.ok(checks.has("scale_ticket_match_shape"))
    assert.equal(checksOf(scaleTicketLine).get("scale_ticket_line_origin_shape"), `${ref("scale_ticket_line", "origin_municipality")} ~ '^[0-9]{4}$'`)
    assert.ok(checksOf(vehicleTare).has("vehicle_tare_key_shape"))
  })
})

describe("the scale house's migration", () => {
  test("is drizzle-kit's statements, then the ticket's and the tare's, then the lines' as a ledger", async () => {
    const text = await readFile(join(MIGRATIONS_FOLDER, await migrationName()), "utf8")
    const statements = statementsOf(text)
    const drizzle = await generated()
    const [tareTrail, ticketTrail] = SCALE_HOUSE_AUDITED.map(auditTrail)
    assert.deepEqual([...statements.slice(0, drizzle.length)].sort(), [...drizzle].sort())
    assert.deepEqual(
      statements.slice(drizzle.length),
      [...handWrittenStatements(scaleTicket), ...ticketTrail!, ...handWrittenStatements(vehicleTare), ...tareTrail!, ...handWrittenStatements(scaleTicketLine)].map(normalised),
    )
    assert.match(text, /^-- The scale house \(M16a of #293, #404\)/)
  })

  test("a tare's and a ticket's history are their own, under the window's grant; the lines keep none", () => {
    assert.deepEqual(
      SCALE_HOUSE_AUDITED.map((entry) => [entry.table, entry.module, entry.parent]),
      [
        [vehicleTare, "operate.scale-house", undefined],
        [scaleTicket, "operate.scale-house", undefined],
      ],
    )
  })
})
