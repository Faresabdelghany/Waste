// Weight to billing (O28 of #290, C32 of #291) as drizzle-kit writes it: the
// ALTER TABLEs into the contexts before it — the product's unit grown by
// `tonne`, the outbox's kinds by `weight-reviewed`, and the billable event's
// `weight` kind, its clause of the kind's shape, the consumer's
// `weight-revised` reason, the Unload with its key and its index, the share's
// kilograms with their check, the two's shape, and the consumer's key
// rebuilt to leave the weight kind to its own key per event and stop. The
// kind's shape is respelt whole, as Postgres has no ALTER for a check;
// finance-rendering.test.ts spells it out, so here it is read from the
// schema. Then the migration, which is exactly those statements: nothing is
// hand-written, no table being new. The file is found by its name, not its
// number, which it takes at its turn. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { OUTBOX_KINDS } from "@waste/domain/execution/vocabulary"
import { BILLABLE_EVENT_KINDS, CANCEL_REASONS } from "@waste/domain/finance/vocabulary"
import { PRODUCT_UNITS } from "@waste/domain/registry/vocabulary"

import { MIGRATIONS_FOLDER } from "../migrate"
import { billableEvent } from "../schema/finance"
import { normalised, statementsOf } from "../sql/hand-written"
import { checksOf, index, oneOfCheck, partialUniqueIndex, projectFkTo, ref } from "./rendering"

const alter = (table: string, statement: string): string => `ALTER TABLE "wms"."${table}" ${statement};`

/** The clause the weight charges' migration adds to the event's kind shape. */
const WEIGHT_CLAUSE = `when 'weight' then ${ref("billable_event", "unload_id")} is not null and ${ref("billable_event", "pickup_id")} is not null and ${ref("billable_event", "ticket_id")} is null and ${ref("billable_event", "reverses_event_id")} is null`

/** What drizzle-kit wrote: the checks and the consumer's key dropped, the two columns, the key into the Unload, the two indexes, the key again, then the checks added again. */
const ALTERED = (): string[] => {
  const events = checksOf(billableEvent)
  return [
    alter("product", 'DROP CONSTRAINT "product_unit_one_of"'),
    alter("outbox_event", 'DROP CONSTRAINT "outbox_event_kind_one_of"'),
    alter("billable_event", 'DROP CONSTRAINT "billable_event_kind_one_of"'),
    alter("billable_event", 'DROP CONSTRAINT "billable_event_cancel_reason_one_of"'),
    alter("billable_event", 'DROP CONSTRAINT "billable_event_kind_shape"'),
    'DROP INDEX "wms"."billable_event_source_event_id_idx";',
    alter("billable_event", 'ADD COLUMN "unload_id" uuid'),
    alter("billable_event", 'ADD COLUMN "weight_kg" integer'),
    projectFkTo("billable_event", "unload_id", "unload"),
    partialUniqueIndex("billable_event", "billable_event_weight_charge_idx", ["company_id", "source_event_id", "pickup_id"], `${ref("billable_event", "kind")} = 'weight'`),
    index("billable_event", "billable_event_unload_id_idx", "company_id", "unload_id"),
    partialUniqueIndex("billable_event", "billable_event_source_event_id_idx", ["company_id", "source_event_id", "kind"], `${ref("billable_event", "source_event_id")} is not null and ${ref("billable_event", "kind")} not in ('reversal', 'weight')`),
    alter("product", `ADD ${oneOfCheck("product", "unit", ...PRODUCT_UNITS)}`),
    alter("outbox_event", `ADD ${oneOfCheck("outbox_event", "kind", ...OUTBOX_KINDS)}`),
    alter("billable_event", `ADD CONSTRAINT "billable_event_weight_kg_positive" CHECK (${events.get("billable_event_weight_kg_positive")})`),
    alter("billable_event", `ADD CONSTRAINT "billable_event_weight_shape" CHECK (${events.get("billable_event_weight_shape")})`),
    alter("billable_event", `ADD ${oneOfCheck("billable_event", "kind", ...BILLABLE_EVENT_KINDS)}`),
    alter("billable_event", `ADD ${oneOfCheck("billable_event", "cancel_reason", ...CANCEL_REASONS)}`),
    alter("billable_event", `ADD CONSTRAINT "billable_event_kind_shape" CHECK (${events.get("billable_event_kind_shape")})`),
  ]
}

/** The migration, by its name: it takes its number at its turn. */
async function migration(): Promise<string[]> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_weight_charges\.sql$/.test(name))
  assert.ok(file !== undefined, "the weight charges' migration")
  return statementsOf(await readFile(join(MIGRATIONS_FOLDER, file), "utf8"))
}

describe("weight to billing as drizzle-kit writes it", () => {
  test("the migration is exactly drizzle-kit's statements, and nothing hand-written", async () => {
    // The same statements, whatever order drizzle-kit's loader gave them.
    assert.deepEqual([...(await migration())].sort(), ALTERED().map(normalised).sort())
  })

  test("the vocabularies the checks spell grew by the weight charge, last of each but the cancel reason, the consumer's third", () => {
    assert.equal(PRODUCT_UNITS.at(-1), "tonne")
    assert.equal(OUTBOX_KINDS.at(-1), "weight-reviewed")
    assert.equal(BILLABLE_EVENT_KINDS.at(-1), "weight")
    assert.deepEqual(CANCEL_REASONS.slice(0, 3), ["pickup-corrected", "visit-voided", "weight-revised"], "the consumer's three reasons first")
    assert.ok(checksOf(billableEvent).get("billable_event_kind_shape")?.includes(WEIGHT_CLAUSE))
  })

  test("a weight charge names its Unload and carries its share's kilograms, and nothing else does either", () => {
    const event = (column: string) => ref("billable_event", column)
    assert.equal(checksOf(billableEvent).get("billable_event_weight_shape"), `(${event("kind")} = 'weight') = (${event("unload_id")} is not null) and (${event("unload_id")} is null) = (${event("weight_kg")} is null)`)
  })
})
