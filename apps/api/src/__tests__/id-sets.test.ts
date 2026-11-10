// The one guard of routes/id-sets.ts no HTTP call can reach (Issue #101, last
// review round): `writeIds` throws on a repeated id before any statement,
// since the contracts' `eachOnce` should have refused it and a schema that
// lost the rule would otherwise write two rows and answer one. The sets
// themselves — their order, their replacement — are proved through the API by
// the routes' own suites (vehicle-types.test.ts, unloading-stations.test.ts).
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Tx } from "@waste/db/client"

import { writeIds, type IdSet, type IdSetTable, type Owner } from "../routes/id-sets"

const A = "01a0d3a5-e5e0-7000-8000-00000000000a"
const B = "01a0d3a5-e5e0-7000-8000-00000000000b"
const owner: Owner = { companyId: "01a0d3a5-e5e0-7000-8000-000000000000", id: "01a0d3a5-e5e0-7000-8000-000000000001" }

const scripted = () => {
  const written: unknown[] = []
  const tx = { insert: () => ({ values: async (rows: unknown[]) => void written.push(...rows) }) } as unknown as Tx
  return { tx, written }
}

/** A set whose rows are the entry and the owner, and nothing else; `table` and `require` are never reached here. */
const set = { table: {}, rowOf: (entryId: string, of: Owner) => ({ entryId, parent: of.id }) } as unknown as IdSet<IdSetTable>

describe("writeIds", () => {
  test("throws on an id named twice before any statement runs, naming the id and the record", async () => {
    const { tx, written } = scripted()
    await assert.rejects(writeIds(tx, set, owner, [A, B, A]), new RegExp(`${A} is named twice in the set of ${owner.id}`))
    assert.deepEqual(written, [], "nothing written")
  })
})
