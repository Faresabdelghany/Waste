// A ticket type's own deadline, default team and charge (#548 of #544) as the
// migration writes them: the SLA's targets, the default teams and the ticket
// charges each gain a Ticket Type of the company, a target naming its kind,
// its type or neither, a default team and a charge exactly one of the two,
// each named once per project with nulls as equal. Then the file: drizzle-kit's
// statements alone. The file is found by its name, not its number. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { generateMigration } from "drizzle-kit/api"

import { MIGRATIONS_FOLDER } from "../migrate"
import { ticketKindProduct } from "../schema/finance"
import { ticketSla, ticketTeamDefault } from "../schema/resolution"
import { normalised, statementsOf } from "../sql/hand-written"
import { checksOf, ref } from "./rendering"

async function migrationName(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_ticket_type_settings\.sql$/.test(name))
  assert.ok(file !== undefined, "the ticket type settings' migration")
  return file
}

type Snapshot = Parameters<typeof generateMigration>[0]
const snapshot = async (n: string): Promise<Snapshot> => JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${n}_snapshot.json`), "utf8")) as Snapshot

/** What drizzle-kit writes for the migration, diffing the snapshot before against its own. */
async function generated(): Promise<string[]> {
  const own = (await migrationName()).slice(0, 4)
  return (await generateMigration(await snapshot(String(Number(own) - 1).padStart(4, "0")), await snapshot(own))).map(normalised)
}

const TABLES = [
  ["ticket_sla", "kind"],
  ["ticket_team_default", "kind"],
  ["ticket_kind_product", "ticket_kind"],
] as const

describe("a ticket type's own settings as drizzle-kit writes them", () => {
  test("each of the three names a type of the company, indexed, and is named once per project by its kind or its type, nulls as equal", async () => {
    const statements = await generated()
    for (const [table] of TABLES) {
      assert.ok(statements.includes(normalised(`ALTER TABLE "wms"."${table}" ADD COLUMN "ticket_type_id" uuid;`)), table)
      assert.ok(statements.includes(normalised(`ALTER TABLE "wms"."${table}" ADD CONSTRAINT "${table}_ticket_type_id_fk" FOREIGN KEY ("company_id","ticket_type_id") REFERENCES "wms"."ticket_type"("company_id","id") ON DELETE no action ON UPDATE no action;`)), table)
      assert.ok(statements.includes(normalised(`CREATE INDEX "${table}_ticket_type_id_idx" ON "wms"."${table}" USING btree ("company_id","ticket_type_id");`)), table)
    }
    assert.ok(statements.includes(normalised('ALTER TABLE "wms"."ticket_sla" ADD CONSTRAINT "ticket_sla_project_id_kind_ticket_type_id_priority_key" UNIQUE NULLS NOT DISTINCT("company_id","project_id","kind","ticket_type_id","priority");')))
    assert.ok(statements.includes(normalised('ALTER TABLE "wms"."ticket_team_default" ADD CONSTRAINT "ticket_team_default_project_id_kind_ticket_type_id_key" UNIQUE NULLS NOT DISTINCT("company_id","project_id","kind","ticket_type_id");')))
    assert.ok(statements.includes(normalised('ALTER TABLE "wms"."ticket_kind_product" ADD CONSTRAINT "ticket_kind_product_project_id_ticket_kind_ticket_type_id_key" UNIQUE NULLS NOT DISTINCT("company_id","project_id","ticket_kind","ticket_type_id");')))
    // A default team and a charge name a kind or a type now, so the kind is no longer required.
    assert.ok(statements.includes(normalised('ALTER TABLE "wms"."ticket_team_default" ALTER COLUMN "kind" DROP NOT NULL;')))
    assert.ok(statements.includes(normalised('ALTER TABLE "wms"."ticket_kind_product" ALTER COLUMN "ticket_kind" DROP NOT NULL;')))
  })

  test("a target names its kind, its type or neither; a default team and a charge exactly one of the two", () => {
    assert.equal(checksOf(ticketSla).get("ticket_sla_scope_shape"), `${ref("ticket_sla", "kind")} is null or ${ref("ticket_sla", "ticket_type_id")} is null`)
    for (const [table, kind] of TABLES.slice(1)) {
      const checks = checksOf(table === "ticket_team_default" ? ticketTeamDefault : ticketKindProduct)
      assert.equal(checks.get(`${table}_kind_or_type_exactly_one`), `(${ref(table, kind)} is not null)::int + (${ref(table, "ticket_type_id")} is not null)::int = 1`, table)
    }
  })
})

describe("the ticket type settings' migration", () => {
  test("is drizzle-kit's statements alone, under its header", async () => {
    const text = await readFile(join(MIGRATIONS_FOLDER, await migrationName()), "utf8")
    assert.deepEqual([...statementsOf(text)].sort(), [...(await generated())].sort())
    assert.match(text, /^-- A ticket type's own deadline, default team and charge \(#548 of #544\)/)
  })
})
