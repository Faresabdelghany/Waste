// The company's counters unaudited: the migration replaces the company's
// audit trigger with every counter the company declares ignored, as
// `replaceAuditTrail` spells it, and nothing else — drizzle-kit has nothing
// to write for it. The file is found by its name, not its number. A rendering
// test lives until its migration merges (migrations/README.md).
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { generateMigration } from "drizzle-kit/api"

import { MIGRATIONS_FOLDER } from "../migrate"
import { company } from "../schema/organisation"
import { replaceAuditTrail } from "../sql/audit-trail"
import { normalised, statementsOf } from "../sql/hand-written"
import { AUDITED } from "../table-policies"

async function migrationName(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_company_counters_unaudited\.sql$/.test(name))
  assert.ok(file !== undefined, "the company's counters unaudited")
  return file
}

type Snapshot = Parameters<typeof generateMigration>[0]
const snapshot = async (n: string): Promise<Snapshot> => JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${n}_snapshot.json`), "utf8")) as Snapshot

describe("the company's counters unaudited, as the migration writes them", () => {
  test("drizzle-kit has nothing to write: the schema is as the file before left it", async () => {
    const own = (await migrationName()).slice(0, 4)
    assert.deepEqual(await generateMigration(await snapshot(String(Number(own) - 1).padStart(4, "0")), await snapshot(own)), [])
  })

  test("is the company's trigger dropped and added again, ignoring every counter the company declares, and nothing else", async () => {
    const entry = AUDITED.find((audited) => audited.table === company)
    assert.ok(entry)
    assert.deepEqual(statementsOf(await readFile(join(MIGRATIONS_FOLDER, await migrationName()), "utf8")), replaceAuditTrail(entry).map(normalised))
    assert.match(replaceAuditTrail(entry).at(-1) ?? "", /wms\.audit_row\('', '', 'next_route_number', 'next_ticket_number', 'next_invoice_number', 'next_scale_ticket_number'\);$/)
  })
})
