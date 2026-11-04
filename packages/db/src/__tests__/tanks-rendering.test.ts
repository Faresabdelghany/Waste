// Septic-tank emptying (M11 of #293) as drizzle-kit writes it: the register
// of tank installations, keyed into the Property and the Container through
// their project, and the inspections, a ledger keyed into the installation;
// the proof's litres, the `volume` kind and its shape, diffed from the proof
// as 0038 left it (proof-as-of.ts), since an applied file is never edited;
// and the receipt's kind respelt, which Postgres has no ALTER for, grown by
// `record-volume`. Then the migration, whose head is exactly those statements
// and whose tail is what the tables owe the file. The file is found by its
// name, not its number, which it takes at its turn. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { DRIVER_COMMAND_KINDS } from "@waste/domain/execution/vocabulary"

import { MIGRATIONS_FOLDER } from "../migrate"
import { userAccount } from "../schema/access"
import { container } from "../schema/containers"
import { property } from "../schema/customers"
import { pickup, proofOfService, route, session } from "../schema/execution"
import { company, project } from "../schema/organisation"
import { contaminantCode } from "../schema/pickup-exceptions"
import { tankInspection, tankInstallation } from "../schema/tanks"
import { appendOnly } from "../sql/append-only"
import { auditTrail, TANKS_AUDITED } from "../sql/audit-trail"
import { excludeOverlapping } from "../sql/exclude-overlapping"
import { normalised, statementsOf } from "../sql/hand-written"
import { tenantFence } from "../sql/tenant-fence"
import { touchUpdatedAt } from "../sql/touch-updated-at"
import { checksOf, oneOfCheck, ref } from "./rendering"
import { proofAsOf0038 } from "./proof-as-of"
import { statementsBetween } from "./specimen"

const referenced = { company, project, route, session, pickup, userAccount, container, property, contaminantCode }

/** The receipt's kind respelt: dropped and added again with today's list. */
const RECEIPT_RESPELT = [
  'ALTER TABLE "wms"."driver_command" DROP CONSTRAINT "driver_command_kind_one_of";',
  `ALTER TABLE "wms"."driver_command" ADD ${oneOfCheck("driver_command", "kind", ...DRIVER_COMMAND_KINDS)};`,
]

/** What drizzle-kit writes: the two tables, the proof from 0038's spelling to today's, and the receipt's kind. */
const generated = async (): Promise<string[]> => [...(await statementsBetween({ ...referenced, proofOfService: proofAsOf0038 }, { ...referenced, proofOfService, tankInstallation, tankInspection })), ...RECEIPT_RESPELT]

/** What the file owes below drizzle-kit's statements: the two fences, the register's exclusion constraint, the ledger's revoke, the register's trigger and its audit trail. */
const handWritten = (): string[] => [
  ...tenantFence(tankInspection),
  ...tenantFence(tankInstallation),
  ...excludeOverlapping(tankInstallation, [tankInstallation.containerId]),
  ...appendOnly(tankInspection),
  ...touchUpdatedAt(tankInstallation),
  ...TANKS_AUDITED.flatMap(auditTrail),
]

/** The migration, by its name: it takes its number at its turn. */
async function migration(): Promise<{ text: string; statements: string[] }> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_septic_tanks\.sql$/.test(name))
  assert.ok(file !== undefined, "the septic tanks' migration")
  const text = await readFile(join(MIGRATIONS_FOLDER, file), "utf8")
  return { text, statements: statementsOf(text) }
}

describe("septic tanks as drizzle-kit writes them", () => {
  test("the migration's head is exactly drizzle-kit's statements: the two tables with their keys and indexes, the proof's litres and its three checks respelt, and the receipt's kind", async () => {
    const { statements } = await migration()
    const head = (await generated()).map(normalised)
    // The same statements, whatever order drizzle-kit's loader gave them.
    assert.deepEqual([...statements.slice(0, head.length)].sort(), [...head].sort())
    assert.ok(head.includes(normalised('ALTER TABLE "wms"."proof_of_service" ADD COLUMN "volume_litres" integer;')), "the litres, null on every proof present")
    assert.ok(head.includes(normalised('ALTER TABLE "wms"."tank_installation" ADD CONSTRAINT "tank_installation_container_id_fk" FOREIGN KEY ("company_id","project_id","container_id") REFERENCES "wms"."container"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;')), "a container of the tank's project")
    assert.ok(head.includes(normalised('ALTER TABLE "wms"."tank_inspection" ADD CONSTRAINT "tank_inspection_tank_installation_id_fk" FOREIGN KEY ("company_id","project_id","tank_installation_id") REFERENCES "wms"."tank_installation"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;')), "an inspection of a tank of its project")
  })

  test("and its tail is what the tables owe it, in that order, and nothing else", async () => {
    const { text, statements } = await migration()
    const tail = handWritten().map(normalised)
    assert.deepEqual(statements.slice(statements.length - tail.length), tail)
    assert.equal(statements.length, (await generated()).length + tail.length, "nothing else in the file")
    assert.ok(tail.includes(normalised('ALTER TABLE "wms"."tank_installation" ADD CONSTRAINT "tank_installation_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "container_id" WITH =, daterange("valid_from", "valid_to", \'[)\') WITH &&);')), "a container stands for one tank at a time")
    assert.ok(tail.includes(normalised('REVOKE UPDATE, DELETE ON "wms"."tank_inspection" FROM wms_api;')))
    assert.match(text, /^-- Septic-tank emptying \(M11 of #293\)/)
  })

  test("the receipt's kinds grew by record-volume, last", () => {
    assert.equal(DRIVER_COMMAND_KINDS.at(-1), "record-volume")
  })
})

describe("the checks of the two tables", () => {
  test("a tank holds some litres and is emptied every 1 to 120 months; an inspection's next one comes after it", () => {
    assert.equal(checksOf(tankInstallation).get("tank_installation_volume_litres_positive"), `${ref("tank_installation", "volume_litres")} > 0`)
    assert.equal(checksOf(tankInstallation).get("tank_installation_emptying_interval_months_range"), `${ref("tank_installation", "emptying_interval_months")} between 1 and 120`)
    const inspection = (name: string) => ref("tank_inspection", name)
    assert.equal(checksOf(tankInspection).get("tank_inspection_next_inspection_after"), `${inspection("next_inspection_on")} is null or ${inspection("next_inspection_on")} > ${inspection("inspected_on")}`)
    assert.equal(checksOf(proofOfService).get("proof_of_service_volume_litres_positive"), `${ref("proof_of_service", "volume_litres")} > 0`)
  })
})
