// Live positions (O8 of #290) as drizzle-kit writes them: `session_position`,
// one row per fix, with its keys into the route, the session of that route
// and the driver, its indexes — a session's track in order, and the purge's
// sweep by age across companies — and the receipt's kind grown by
// `record-positions`, which Postgres has no ALTER for, so the check is dropped
// and added again. Then the migration, whose head is exactly those statements
// and whose tail is the table's fence, the ledger's revoke from the API role,
// and the one delete path into it, the worker's retention purge. The file is
// found by its name, not its number, which it takes at its turn. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { DRIVER_COMMAND_KINDS } from "@waste/domain/execution/vocabulary"

import { MIGRATIONS_FOLDER } from "../migrate"
import { proofOfService, route, sessionPosition } from "../schema/execution"
import { appendOnly } from "../sql/append-only"
import { normalised, statementsOf } from "../sql/hand-written"
import { retentionPurge } from "../sql/retention-purge"
import { tenantFence } from "../sql/tenant-fence"
import { checksOf, oneOfCheck, ref } from "./rendering"
import { statementsFor } from "./specimen"

/** The receipt's kinds as of this file: today's less `pre-trip-check`, which migration 0075 added (O13 of #290), and `record-volume`, which 0098 did (M11 of #293). */
const KINDS_AS_OF_0060 = DRIVER_COMMAND_KINDS.filter((kind) => kind !== "pre-trip-check" && kind !== "record-volume")

const alter = (statement: string): string => `ALTER TABLE "wms"."driver_command" ${statement};`

/** What drizzle-kit wrote into the receipt: its kind's check, dropped and added again with the new kind. */
const ALTERED = [alter('DROP CONSTRAINT "driver_command_kind_one_of"'), alter(`ADD ${oneOfCheck("driver_command", "kind", ...KINDS_AS_OF_0060)}`)]

/** What the file owes below drizzle-kit's statements: the fence, the revoke, the purge's grant. */
const handWritten = (): string[] => [...tenantFence(sessionPosition), ...appendOnly(sessionPosition), ...retentionPurge(sessionPosition)]

/** The migration, by its name: it takes its number at its turn. */
async function migration(): Promise<{ text: string; statements: string[] }> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_live_positions\.sql$/.test(name))
  assert.ok(file !== undefined, "the live positions' migration")
  const text = await readFile(join(MIGRATIONS_FOLDER, file), "utf8")
  return { text, statements: statementsOf(text) }
}

describe("live positions as drizzle-kit writes them", () => {
  test("the migration's head is exactly drizzle-kit's statements: the table with its keys and indexes, and the receipt's kind respelt", async () => {
    const { statements } = await migration()
    const generated = [...(await statementsFor({ sessionPosition })), ...ALTERED].map(normalised)
    // The same statements, whatever order drizzle-kit's loader gave them.
    assert.deepEqual([...statements.slice(0, generated.length)].sort(), [...generated].sort())
    assert.ok(generated.some((statement) => statement.includes('"session_position_route_id_session_id_fk" FOREIGN KEY ("company_id","project_id","route_id","session_id") REFERENCES "wms"."session"("company_id","project_id","route_id","id")')), "a session of the route the position names")
    assert.ok(generated.includes(normalised('CREATE INDEX "session_position_session_id_idx" ON "wms"."session_position" USING btree ("company_id","session_id","fixed_at");')), "a session's track in order")
    assert.ok(generated.includes(normalised('CREATE INDEX "session_position_fixed_at_idx" ON "wms"."session_position" USING btree ("fixed_at");')), "the purge's sweep by age, across companies")
  })

  test("and its tail is the fence, the revoke and the purge's grant, in that order, and nothing else", async () => {
    const { text, statements } = await migration()
    const tail = handWritten().map(normalised)
    assert.deepEqual(statements.slice(statements.length - tail.length), tail)
    assert.equal(statements.length, (await statementsFor({ sessionPosition })).length + ALTERED.length + tail.length, "nothing else in the file")
    assert.deepEqual(tail.slice(-2), [normalised('REVOKE UPDATE, DELETE ON "wms"."session_position" FROM wms_api;'), normalised('GRANT DELETE ON "wms"."session_position" TO wms_worker;')])
    assert.match(text, /^-- Live positions \(O8 of #290/)
  })

  test("the receipt's kinds grew by record-positions, last", () => {
    assert.equal(KINDS_AS_OF_0060.at(-1), "record-positions")
    assert.equal(KINDS_AS_OF_0060.length, DRIVER_COMMAND_KINDS.length - 2, "two kinds added since")
  })
})

describe("the checks of a position", () => {
  test("a fix's point is valid, its accuracy positive, its speed and heading within what a road vehicle and a compass can say", () => {
    const checks = checksOf(sessionPosition)
    const column = (name: string) => ref("session_position", name)
    assert.equal(checks.get("session_position_accuracy_m_positive"), `${column("accuracy_m")} > 0`)
    assert.equal(checks.get("session_position_speed_range"), `${column("speed_kmh")} is null or ${column("speed_kmh")} between 0 and 300`)
    assert.equal(checks.get("session_position_heading_range"), `${column("heading_deg")} is null or ${column("heading_deg")} between 0 and 359`)
    assert.ok(checks.has("session_position_location_valid"))
  })
})

describe("retentionPurge", () => {
  test("grants the worker DELETE on a ledger, and refuses a current-state table, which spreads `timestamps`", () => {
    assert.deepEqual(retentionPurge(proofOfService), ['GRANT DELETE ON "wms"."proof_of_service" TO wms_worker;'])
    assert.throws(() => retentionPurge(route), /has no recorded_at/)
  })
})
