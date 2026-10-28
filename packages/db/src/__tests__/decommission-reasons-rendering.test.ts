// Decommission Reasons (O30 of #290, row 9.6) as the migration writes them:
// one new table, the company's reasons by code and name, each once, retired
// by its status; the ledger's new column, its key into the reasons, its index
// and the shape that asks a decommission and nothing else for a reason. Then
// the file: drizzle-kit's statements, the shape check moved below the two
// hand-written statements that give every company its reasons and every
// decommission already recorded `other` (src/sql/decommission-reasons.ts), so
// the check holds when it is added, then the table's fence, trigger and audit
// trail. The file is found by its name, not its number. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { DEFAULT_DECOMMISSION_REASONS } from "@waste/domain/resources/decommission-reasons"
import { DECOMMISSION_REASON_STATUSES } from "@waste/domain/resources/vocabulary"
import { generateMigration } from "drizzle-kit/api"

import { MIGRATIONS_FOLDER } from "../migrate"
import { decommissionReason, stockMovement } from "../schema/stock"
import { auditTrail, DECOMMISSION_REASONS_AUDITED } from "../sql/audit-trail"
import { decommissionReasonsBackfill, decommissionReasonsSeed } from "../sql/decommission-reasons"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { checksOf, list, ref } from "./rendering"

const SHAPE = 'ALTER TABLE "wms"."stock_movement" ADD CONSTRAINT "stock_movement_decommission_reason_shape" CHECK (("wms"."stock_movement"."kind" = \'decommission\') = ("wms"."stock_movement"."decommission_reason_id" is not null));'

async function migrationName(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_decommission_reasons\.sql$/.test(name))
  assert.ok(file !== undefined, "the decommission reasons' migration")
  return file
}

type Snapshot = Parameters<typeof generateMigration>[0]
const snapshot = async (n: string): Promise<Snapshot> => JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${n}_snapshot.json`), "utf8")) as Snapshot

/** What drizzle-kit writes for the migration, diffing the snapshot before against its own. */
async function generated(): Promise<string[]> {
  const own = (await migrationName()).slice(0, 4)
  return (await generateMigration(await snapshot(String(Number(own) - 1).padStart(4, "0")), await snapshot(own))).map(normalised)
}

describe("the decommission reasons as drizzle-kit writes them", () => {
  test("a reason is the company's, by a lowercase code and a name each once, active or retired; the ledger names one on a decommission and on nothing else", async () => {
    const statements = await generated()
    assert.ok(statements.includes(normalised(SHAPE)))
    assert.ok(statements.includes(normalised('ALTER TABLE "wms"."stock_movement" ADD COLUMN "decommission_reason_id" uuid;')))
    assert.ok(statements.includes(normalised('ALTER TABLE "wms"."stock_movement" ADD CONSTRAINT "stock_movement_decommission_reason_id_fk" FOREIGN KEY ("company_id","decommission_reason_id") REFERENCES "wms"."decommission_reason"("company_id","id") ON DELETE no action ON UPDATE no action;')))
    const checks = checksOf(decommissionReason)
    assert.equal(checks.get("decommission_reason_status_one_of"), `${ref("decommission_reason", "status")} in (${list(...DECOMMISSION_REASON_STATUSES)})`)
    assert.equal(checks.get("decommission_reason_code_lowercase"), `${ref("decommission_reason", "code")} = lower(${ref("decommission_reason", "code")})`)
    assert.equal(checksOf(stockMovement).get("stock_movement_decommission_reason_shape"), `(${ref("stock_movement", "kind")} = 'decommission') = (${ref("stock_movement", "decommission_reason_id")} is not null)`)
  })
})

describe("the decommission reasons' migration", () => {
  test("is drizzle-kit's statements, the shape check last of them, after the seed and the backfill; then the fence, the trigger and the audit trail", async () => {
    const text = await readFile(join(MIGRATIONS_FOLDER, await migrationName()), "utf8")
    const statements = statementsOf(text)
    const drizzle = await generated()
    const head = drizzle.filter((statement) => statement !== normalised(SHAPE))
    assert.deepEqual([...statements.slice(0, head.length)].sort(), [...head].sort())
    assert.deepEqual(statements.slice(head.length), [decommissionReasonsSeed(), decommissionReasonsBackfill(), SHAPE, ...handWrittenStatements(decommissionReason), ...DECOMMISSION_REASONS_AUDITED.flatMap(auditTrail)].map(normalised))
    assert.match(text, /^-- Decommission Reasons \(O30 of #290, row 9\.6\)/)
  })

  test("the seed gives every company the domain's eight, leaving one it holds by code; the backfill gives a decommission without a reason its company's other", () => {
    const seed = decommissionReasonsSeed()
    for (const { code, name } of DEFAULT_DECOMMISSION_REASONS) assert.ok(seed.includes(`('${code}', '${name}')`), code)
    assert.match(seed, /FROM "wms"\."company" AS c CROSS JOIN \(VALUES .*\) AS v \("code", "name"\) ON CONFLICT \("company_id", "code"\) DO NOTHING;$/)
    assert.match(decommissionReasonsBackfill(), /r\."code" = 'other' AND m\."kind" = 'decommission' AND m\."decommission_reason_id" IS NULL;$/)
  })
})
