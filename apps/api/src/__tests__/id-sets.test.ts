// The two helpers of routes/id-sets.ts that hold without a database (Issue
// #101, last review round): `asRead`, which only sorts, and `writeIds`, the one
// guard behind it — a repeated id is thrown before any statement, since the
// contracts' `eachOnce` should have refused it and a schema that lost the rule
// would otherwise write two rows and answer one. The routes' own suites
// (vehicle-types.test.ts, unloading-stations.test.ts) prove the sets against
// Postgres.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Tx } from "@waste/db/client"

import { asRead, writeIds, type IdSet, type IdSetTable, type Owner } from "../routes/id-sets"

const A = "01a0d3a5-e5e0-7000-8000-00000000000a"
const B = "01a0d3a5-e5e0-7000-8000-00000000000b"
const owner: Owner = { companyId: "01a0d3a5-e5e0-7000-8000-000000000000", id: "01a0d3a5-e5e0-7000-8000-000000000001" }

/** A `tx` whose one `insert(...).values(rows)` keeps the rows it was given. */
const scripted = () => {
  const written: unknown[] = []
  const tx = { insert: () => ({ values: async (rows: unknown[]) => void written.push(...rows) }) } as unknown as Tx
  return { tx, written }
}

/** A set whose rows are the entry and the owner, and nothing else; `table` and `require` are never reached here. */
const set = { table: {}, rowOf: (entryId: string, of: Owner) => ({ entryId, parent: of.id }) } as unknown as IdSet<IdSetTable>

describe("asRead", () => {
  test("sorts the body's ids into the order Postgres gives a uuid, the string order of its lowercase spelling, and drops nothing", () => {
    assert.deepEqual(asRead([B, A]), [A, B])
    assert.deepEqual(asRead([]), [])
    assert.deepEqual(asRead([A, A]), [A, A], "no dedup here: the contracts refused a repeat already, and writeIds throws on one that got past them")
  })
})

describe("writeIds", () => {
  test("writes one row per id in the body's order, and no statement for an empty set", async () => {
    const { tx, written } = scripted()
    await writeIds(tx, set, owner, [B, A])
    assert.deepEqual(written, [
      { entryId: B, parent: owner.id },
      { entryId: A, parent: owner.id },
    ])
    const empty = scripted()
    await writeIds(empty.tx, set, owner, [])
    assert.deepEqual(empty.written, [])
  })

  test("throws on an id named twice before any statement runs, naming the id and the record", async () => {
    const { tx, written } = scripted()
    await assert.rejects(writeIds(tx, set, owner, [A, B, A]), new RegExp(`${A} is named twice in the set of ${owner.id}`))
    assert.deepEqual(written, [], "nothing written")
  })
})
