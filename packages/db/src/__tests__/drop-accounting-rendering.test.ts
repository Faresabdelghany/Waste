// The accounting export's removal as the migration writes it: drizzle-kit,
// diffing the snapshot before the migration against its own, drops the
// mapping's four tables and the export's three ledgers; the file is those
// drops and then the delete of every grant of the module key the exports were
// read and made under, `commercial.accounting`, which the domain no longer
// lists. The schema, the audit trail and the module keys name none of it any
// more. The file is found by its name, not its number, which it takes at its
// turn; accounting-rendering.test.ts reads the seven as SAF-T left them
// (accounting-as-of.ts). No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { MODULE_KEYS } from "@waste/domain/access/modules"
import { getTableName, is } from "drizzle-orm"
import { generateMigration } from "drizzle-kit/api"
import { PgTable } from "drizzle-orm/pg-core"

import { MIGRATIONS_FOLDER } from "../migrate"
import * as schema from "../schema"
import { AUDITED_TABLE_NAMES, EXEMPT } from "../sql/audit-trail"
import { normalised, statementsOf } from "../sql/hand-written"

const DROPPED = ["accounting_account", "accounting_export", "accounting_export_line", "accounting_export_voucher", "accounting_product_account", "accounting_settings", "accounting_vat_code"]

const DROPS = DROPPED.map((name) => `DROP TABLE "wms"."${name}" CASCADE;`)
const GRANTS_DELETED = `DELETE FROM "wms"."role_grant" WHERE "module_key" = 'commercial.accounting';`

/** The migration's file name, by its name: it takes its number at its turn. */
async function migrationName(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_drop_accounting\.sql$/.test(name))
  assert.ok(file !== undefined, "the accounting export's removal")
  return file
}

type Snapshot = Parameters<typeof generateMigration>[0]
const snapshot = async (n: string): Promise<Snapshot> => JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${n}_snapshot.json`), "utf8")) as Snapshot

describe("the accounting export's removal as the migration writes it", () => {
  test("drizzle-kit, diffing the snapshot before against the migration's own, drops the seven tables and nothing else", async () => {
    const own = (await migrationName()).slice(0, 4)
    const before = String(Number(own) - 1).padStart(4, "0")
    assert.deepEqual(await generateMigration(await snapshot(before), await snapshot(own)), DROPS)
  })

  test("the migration is the seven drops, then the module key's grants deleted, under its header", async () => {
    const text = await readFile(join(MIGRATIONS_FOLDER, await migrationName()), "utf8")
    assert.deepEqual(statementsOf(text), [...DROPS, GRANTS_DELETED].map(normalised))
    assert.match(text, /^-- The accounting export removed \(#291 C7/)
  })

  test("the schema, the audit trail and the module keys name none of it", () => {
    const tables = (Object.values(schema) as unknown[]).filter((value): value is PgTable => is(value, PgTable)).map((table) => getTableName(table))
    for (const name of DROPPED) {
      assert.ok(!tables.includes(name), `${name} is not in the schema`)
      assert.ok(!AUDITED_TABLE_NAMES.has(name), `${name} is not audited`)
      assert.ok(!EXEMPT.some((entry) => getTableName(entry.table) === name), `${name} is not exempt`)
    }
    assert.ok(!(MODULE_KEYS as readonly string[]).includes("commercial.accounting"))
  })
})
