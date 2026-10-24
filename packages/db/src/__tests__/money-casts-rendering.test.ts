// The money checks recast (#314) as drizzle-kit writes them. The two
// `_vat_shape` checks read `round(net * pct / 100.0)`, and `net_minor *
// vat_percent` is an `integer` product, computed before anything is cast,
// which overflows past about 85.9 million minor units at 25 %: a net that
// fits its column failed the check with 22003. The two `_amounts_shape`
// checks multiply the unit price by the quantity, and `invoice_line`'s takes
// `abs` of the net, which overflow the same way at the columns' bounds.
// Migration 0028 drops the four and adds them back with the products cast
// first — the amounts to bigint, the VAT's net to numeric — which every row
// that passed before still passes, so nothing is backfilled.
//
// The file is held to what drizzle-kit diffs between the two snapshots it
// wrote, 0027's and 0028's, so the committed SQL is `pnpm db:generate`'s and
// not a hand-copied spelling; the four constraints are held to the schema's
// own checks; and finance-rendering.test.ts maps today's spelling back onto
// 0010's (`CHANGED_IN_0028`). No database.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { generateMigration } from "drizzle-kit/api"

import { MIGRATIONS_FOLDER } from "../migrate"
import { billableEvent, invoiceLine } from "../schema/finance"
import { normalised, statementsOf } from "../sql/hand-written"
import { checksOf, ref } from "./rendering"

const MIGRATION = "0028_money_casts.sql"

/** A snapshot drizzle-kit wrote beside a migration. */
const snapshot = async (n: string): Promise<Parameters<typeof generateMigration>[0]> =>
  JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${n}_snapshot.json`), "utf8")) as Parameters<typeof generateMigration>[0]

const fileStatements = async (): Promise<string[]> => statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))

/** The four checks as 0028 adds them back. */
const RECAST = {
  billable_event_amounts_shape: `${ref("billable_event", "net_minor")} is null or ${ref("billable_event", "net_minor")} = (case ${ref("billable_event", "kind")} when 'reversal' then -1 else 1 end) * ${ref("billable_event", "unit_price_minor")}::bigint * ${ref("billable_event", "quantity")}`,
  billable_event_vat_shape: `${ref("billable_event", "vat_minor")} is null or ${ref("billable_event", "vat_minor")} = round(${ref("billable_event", "net_minor")}::numeric * ${ref("billable_event", "vat_percent")} / 100.0)`,
  invoice_line_amounts_shape: `abs(${ref("invoice_line", "net_minor")}::bigint) = ${ref("invoice_line", "unit_price_minor")}::bigint * ${ref("invoice_line", "quantity")} and (${ref("invoice_line", "credits_line_id")} is null or ${ref("invoice_line", "net_minor")} <= 0)`,
  invoice_line_vat_shape: `${ref("invoice_line", "vat_minor")} = round(${ref("invoice_line", "net_minor")}::numeric * ${ref("invoice_line", "vat_percent")} / 100.0)`,
} as const

const tableOf = (name: keyof typeof RECAST): string => (name.startsWith("billable_event") ? "billable_event" : "invoice_line")

/** What 0028 does: drop the four, in drizzle-kit's order, then add them back recast. */
const altered = [
  ...(["billable_event_amounts_shape", "billable_event_vat_shape", "invoice_line_amounts_shape", "invoice_line_vat_shape"] as const).map((name) => `ALTER TABLE "wms"."${tableOf(name)}" DROP CONSTRAINT "${name}";`),
  ...(["billable_event_amounts_shape", "billable_event_vat_shape", "invoice_line_amounts_shape", "invoice_line_vat_shape"] as const).map((name) => `ALTER TABLE "wms"."${tableOf(name)}" ADD CONSTRAINT "${name}" CHECK (${RECAST[name]});`),
]

describe("the money checks recast (#314)", () => {
  test("drizzle-kit, diffing 0027's snapshot against 0028's, drops the four and adds them back with the products cast first", async () => {
    assert.deepEqual(await generateMigration(await snapshot("0027"), await snapshot("0028")), altered)
  })

  test("the schema's four checks are the recast ones", () => {
    assert.equal(checksOf(billableEvent).get("billable_event_amounts_shape"), RECAST.billable_event_amounts_shape)
    assert.equal(checksOf(billableEvent).get("billable_event_vat_shape"), RECAST.billable_event_vat_shape)
    assert.equal(checksOf(invoiceLine).get("invoice_line_amounts_shape"), RECAST.invoice_line_amounts_shape)
    assert.equal(checksOf(invoiceLine).get("invoice_line_vat_shape"), RECAST.invoice_line_vat_shape)
  })

  test("migration 0028 is exactly that, and nothing hand-written: the fences and the triggers are the tables', as 0010 wrote them", async () => {
    assert.deepEqual(await fileStatements(), altered.map(normalised))
  })
})
