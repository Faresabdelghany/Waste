// A price row's chain (#291 C8) as drizzle-kit writes it: the row it was
// indexed from, with its key into the table itself and its index, the label,
// the basis points, and `price_list_row_index_shape`: the three null together
// or set together, and a row never indexed from itself — the provider
// price's chain less its base, since a customer row has no bid. The
// migration is exactly those statements: no table is new, so nothing is
// written by hand, and the audit trigger the table already carries covers the
// columns. finance-rendering.test.ts spells the row's CREATE TABLE as of
// today. The file is found by its name, not its number, which it takes at its
// turn. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { MIGRATIONS_FOLDER } from "../migrate"
import { priceListRow } from "../schema/finance"
import { statementsOf } from "../sql/hand-written"
import { checksOf, index, projectFkTo, ref } from "./rendering"

const INDEX_SHAPE = `(${ref("price_list_row", "indexed_from_id")} is null) = (${ref("price_list_row", "index_label")} is null) and (${ref("price_list_row", "indexed_from_id")} is null) = (${ref("price_list_row", "index_basis_points")} is null) and ${ref("price_list_row", "indexed_from_id")} <> ${ref("price_list_row", "id")}`

/** The migration, by its name: it takes its number at its turn. */
async function migration(): Promise<string[]> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_price_indexation\.sql$/.test(name))
  assert.ok(file !== undefined, "the price indexation's migration")
  return statementsOf(await readFile(join(MIGRATIONS_FOLDER, file), "utf8"))
}

describe("a price row's chain as drizzle-kit writes it", () => {
  test("the three columns, the chain's key and index, and the shape: exactly the migration", async () => {
    assert.deepEqual(await migration(), [
      'ALTER TABLE "wms"."price_list_row" ADD COLUMN "indexed_from_id" uuid;',
      'ALTER TABLE "wms"."price_list_row" ADD COLUMN "index_label" text;',
      'ALTER TABLE "wms"."price_list_row" ADD COLUMN "index_basis_points" integer;',
      projectFkTo("price_list_row", "indexed_from_id", "price_list_row"),
      index("price_list_row", "price_list_row_indexed_from_id_idx", "company_id", "indexed_from_id"),
      `ALTER TABLE "wms"."price_list_row" ADD CONSTRAINT "price_list_row_index_shape" CHECK (${INDEX_SHAPE});`,
    ])
  })

  test("the shape renders without parameters", () => {
    assert.equal(checksOf(priceListRow).get("price_list_row_index_shape"), INDEX_SHAPE)
  })
})
