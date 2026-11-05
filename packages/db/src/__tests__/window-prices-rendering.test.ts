// The scale house's window prices (M16b of #293) as drizzle-kit writes them:
// the ALTERs into the contexts before it — the unit `m3`, the outbox's two
// kinds and their aggregate, the `scale-ticket` event with its line, its key
// and its shapes, the consumer's key leaving the kind to its own per line,
// and the price row's tier — and the window line's product and volume with
// the project key the event's reference needs, moved ahead of it. Then the
// migration's tail: the price row's exclusion constraint again, the tier read
// as 0 where a row has none, so every row present keeps the key it had. The
// file is found by its name, and its snapshot by the journal's entry for it.
// No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { OUTBOX_AGGREGATES, OUTBOX_KINDS } from "@waste/domain/execution/vocabulary"
import { BILLABLE_EVENT_KINDS, CANCEL_REASONS } from "@waste/domain/finance/vocabulary"
import { PRODUCT_UNITS } from "@waste/domain/registry/vocabulary"
import { generateMigration } from "drizzle-kit/api"

import { MIGRATIONS_FOLDER } from "../migrate"
import { billableEvent, priceListRow } from "../schema/finance"
import { scaleTicketLine } from "../schema/scale-house"
import { normalised, statementsOf } from "../sql/hand-written"
import { checksOf, ref } from "./rendering"

async function migrationName(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_window_prices\.sql$/.test(name))
  assert.ok(file !== undefined, "the window prices' migration")
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

/** The tail: the price row's key again, its tier beside its conditions, none read as 0. */
const TAIL = [
  'ALTER TABLE "wms"."price_list_row" DROP CONSTRAINT "price_list_row_no_overlap";',
  `ALTER TABLE "wms"."price_list_row" ADD CONSTRAINT "price_list_row_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "price_list_id" WITH =, "product_id" WITH =, "condition_key" WITH =, (coalesce("from_quantity", 0)) WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);`,
]

describe("the window prices as drizzle-kit writes them", () => {
  test("the vocabularies grow by the cubic metre, the scale ticket's two kinds and aggregate, its event and its void, each last but the reason, the consumer's fourth", () => {
    assert.equal(PRODUCT_UNITS.at(-1), "m3")
    assert.deepEqual(OUTBOX_KINDS.slice(-2), ["scale-ticket-completed", "scale-ticket-voided"])
    assert.equal(OUTBOX_AGGREGATES.at(-1), "scale-ticket")
    assert.equal(BILLABLE_EVENT_KINDS.at(-1), "scale-ticket")
    assert.deepEqual(CANCEL_REASONS.slice(0, 4), ["pickup-corrected", "visit-voided", "weight-revised", "scale-ticket-voided"])
  })

  test("a window line's charge names its line, carries its kilograms, and is one per line; the price row's tier is positive", async () => {
    const statements = await generated()
    for (const statement of [
      'ALTER TABLE "wms"."billable_event" ADD COLUMN "scale_ticket_line_id" uuid;',
      'ALTER TABLE "wms"."price_list_row" ADD COLUMN "from_quantity" integer;',
      'ALTER TABLE "wms"."billable_event" ADD CONSTRAINT "billable_event_scale_ticket_line_id_fk" FOREIGN KEY ("company_id","project_id","scale_ticket_line_id") REFERENCES "wms"."scale_ticket_line"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;',
      `CREATE UNIQUE INDEX "billable_event_scale_ticket_charge_idx" ON "wms"."billable_event" USING btree ("company_id","scale_ticket_line_id") WHERE "wms"."billable_event"."kind" = 'scale-ticket';`,
      'ALTER TABLE "wms"."scale_ticket_line" ADD CONSTRAINT "scale_ticket_line_project_key" UNIQUE("company_id","project_id","id");',
    ]) {
      assert.ok(statements.includes(normalised(statement)), statement)
    }
    const event = (column: string) => ref("billable_event", column)
    assert.equal(checksOf(billableEvent).get("billable_event_scale_ticket_shape"), `(${event("kind")} = 'scale-ticket') = (${event("scale_ticket_line_id")} is not null)`)
    assert.equal(checksOf(billableEvent).get("billable_event_weight_shape"), `(${event("kind")} = 'weight') = (${event("unload_id")} is not null) and (${event("kind")} in ('weight', 'scale-ticket')) = (${event("weight_kg")} is not null)`)
    assert.equal(checksOf(priceListRow).get("price_list_row_from_quantity_positive"), `${ref("price_list_row", "from_quantity")} > 0`)
    assert.equal(checksOf(scaleTicketLine).get("scale_ticket_line_volume_litres_positive"), `${ref("scale_ticket_line", "volume_litres")} > 0`)
  })
})

describe("the window prices' migration", () => {
  test("is drizzle-kit's statements, the line's project key ahead of the event's reference to it, then the price row's key again with its tier", async () => {
    const text = await readFile(join(MIGRATIONS_FOLDER, await migrationName()), "utf8")
    const statements = statementsOf(text)
    const drizzle = await generated()
    assert.deepEqual([...statements.slice(0, drizzle.length)].sort(), [...drizzle].sort())
    assert.deepEqual(statements.slice(drizzle.length), TAIL.map(normalised))
    const key = statements.findIndex((statement) => statement.includes('"scale_ticket_line_project_key"'))
    const reference = statements.findIndex((statement) => statement.includes('"billable_event_scale_ticket_line_id_fk"'))
    assert.ok(key >= 0 && key < reference, "the key the reference needs comes first")
    assert.match(text, /^-- The scale house's window prices \(M16b of #293\)/)
  })
})
