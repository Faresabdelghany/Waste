// Field inspections and the driver's fill estimate (M23a of #293) as
// drizzle-kit writes them: the inspection, keyed into its container or its
// property and its inspector, and its photos, a ledger keyed into it; the
// stop's fill estimate, a column with its check; and the receipt's kind
// respelt with `record-fill`, which Postgres has no ALTER for. Then the
// migration, whose head is exactly those statements and whose tail is what
// the two tables owe the file. The file is found by its name, not its
// number, which it takes at its turn. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { DRIVER_COMMAND_KINDS, FILL_LEVELS } from "@waste/domain/execution/vocabulary"

import { MIGRATIONS_FOLDER } from "../migrate"
import { fieldInspection, fieldInspectionPhoto } from "../schema/inspections"
import { appendOnly } from "../sql/append-only"
import { auditTrail, INSPECTIONS_AUDITED } from "../sql/audit-trail"
import { normalised, statementsOf } from "../sql/hand-written"
import { tenantFence } from "../sql/tenant-fence"
import { touchUpdatedAt } from "../sql/touch-updated-at"
import { checksOf, oneOfCheck, ref } from "./rendering"
import { statementsFor } from "./specimen"

const alter = (table: string, statement: string): string => `ALTER TABLE "wms"."${table}" ${statement};`

/** What drizzle-kit wrote into the tables already applied: the receipt's kind respelt, and the stop's fill estimate with its check. */
const ALTERED = [
  alter("driver_command", 'DROP CONSTRAINT "driver_command_kind_one_of"'),
  alter("driver_command", `ADD ${oneOfCheck("driver_command", "kind", ...DRIVER_COMMAND_KINDS)}`),
  alter("pickup", 'ADD COLUMN "fill_level" text'),
  alter("pickup", `ADD ${oneOfCheck("pickup", "fill_level", ...FILL_LEVELS)}`),
]

/** What the file owes below drizzle-kit's statements: the two fences, the ledger's revoke, the inspection's trigger and its audit trail. */
const handWritten = (): string[] => [...tenantFence(fieldInspection), ...tenantFence(fieldInspectionPhoto), ...appendOnly(fieldInspectionPhoto), ...touchUpdatedAt(fieldInspection), ...INSPECTIONS_AUDITED.flatMap(auditTrail)]

/** The migration, by its name: it takes its number at its turn. */
async function migration(): Promise<{ text: string; statements: string[] }> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_field_inspections\.sql$/.test(name))
  assert.ok(file !== undefined, "the field inspections migration")
  const text = await readFile(join(MIGRATIONS_FOLDER, file), "utf8")
  return { text, statements: statementsOf(text) }
}

describe("field inspections as drizzle-kit writes them", () => {
  test("the migration's head is exactly drizzle-kit's statements: the two tables with their keys and indexes, the receipt's kind respelt and the stop's fill estimate", async () => {
    const { statements } = await migration()
    const generated = [...(await statementsFor({ fieldInspection, fieldInspectionPhoto })), ...ALTERED].map(normalised)
    // The same statements, whatever order drizzle-kit's loader gave them.
    assert.deepEqual([...statements.slice(0, generated.length)].sort(), [...generated].sort())
    assert.ok(generated.includes(normalised('ALTER TABLE "wms"."field_inspection" ADD CONSTRAINT "field_inspection_container_id_fk" FOREIGN KEY ("company_id","project_id","container_id") REFERENCES "wms"."container"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;')), "a container of the inspection's project")
    assert.ok(generated.includes(normalised('ALTER TABLE "wms"."field_inspection_photo" ADD CONSTRAINT "field_inspection_photo_inspection_id_fk" FOREIGN KEY ("company_id","project_id","inspection_id") REFERENCES "wms"."field_inspection"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;')), "a photo of an inspection of its project")
  })

  test("and its tail is what the tables owe it, in that order, and nothing else", async () => {
    const { text, statements } = await migration()
    const tail = handWritten().map(normalised)
    assert.deepEqual(statements.slice(statements.length - tail.length), tail)
    assert.equal(statements.length, (await statementsFor({ fieldInspection, fieldInspectionPhoto })).length + ALTERED.length + tail.length, "nothing else in the file")
    assert.ok(tail.includes(normalised('REVOKE UPDATE, DELETE ON "wms"."field_inspection_photo" FROM wms_api;')))
    assert.match(text, /^-- Field inspections and the driver's fill estimate \(M23a of #293/)
  })

  test("the receipt's kinds grew by record-fill, last", () => {
    assert.equal(DRIVER_COMMAND_KINDS.at(-1), "record-fill")
  })
})

describe("the checks of the inspection", () => {
  test("one subject; a verdict its findings agree with; closed exactly when it says when", () => {
    const column = (name: string) => ref("field_inspection", name)
    const checks = checksOf(fieldInspection)
    assert.equal(checks.get("field_inspection_subject_exactly_one"), `(${column("container_id")} is not null)::int + (${column("property_id")} is not null)::int = 1`)
    assert.equal(checks.get("field_inspection_findings_shape"), `(${column("outcome")} = 'compliant') = (cardinality(${column("findings")}) = 0)`)
    assert.equal(checks.get("field_inspection_closed_shape"), `(${column("status")} = 'closed') = (${column("closed_at")} is not null)`)
  })
})
