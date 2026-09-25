// The plural check's loop and its guards, without a database (Issue #101,
// last review round): a scripted `tx` answers each `select` with the ids it
// "finds", so the suite can say what the set sees on every pass — a row that
// arrived between two statements, a row flickering under the request, two
// rows taking turns — which no real database would do on cue. The statements
// themselves run against Postgres in every route suite that names a set.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Tx } from "@waste/db/client"
import { wasteFraction } from "@waste/db/schema/catalogue"

import { eachPresent, firstMissing, idsNamed, rowsPresent, type Named } from "../routes/sets"

const COMPANY = "01a0d3a5-e5e0-7000-8000-000000000000"
const A: Named = { id: "01a0d3a5-e5e0-7000-8000-00000000000a", path: "ids.0" }
const B: Named = { id: "01a0d3a5-e5e0-7000-8000-00000000000b", path: "ids.1" }

/**
 * A `tx` whose every `select … from … where` answers the ids `found(n)` says
 * the n-th statement finds, and counts the statements. Drizzle's `and`, `eq`
 * and `inArray` only build SQL over the real columns, so nothing else is
 * touched.
 */
const scripted = (found: (statement: number) => readonly string[]) => {
  let statements = 0
  const tx = {
    select: () => ({ from: () => ({ where: () => Promise.resolve(found(statements++).map((id) => ({ id }))) }) }),
  } as unknown as Tx
  return { tx, asked: () => statements }
}

/** A singular check that lets every entry through and remembers the ones it was handed. */
const passing = () => {
  const handed: Named[] = []
  return { singular: async (entry: Named) => void handed.push(entry), handed }
}

describe("idsNamed", () => {
  test("names each id once, in the order first named", () => {
    assert.deepEqual(idsNamed([B, A, { ...B, path: "ids.2" }]), [B.id, A.id])
    assert.deepEqual(idsNamed([]), [])
  })
})

describe("firstMissing", () => {
  test("answers the lowest entry the set did not find, by the path the body spelled it at, and nothing when every id is there or nothing was named", async () => {
    const some = scripted(() => [B.id])
    assert.deepEqual(await firstMissing(some.tx, wasteFraction, wasteFraction.id, COMPANY, [A, B]), A)
    const all = scripted(() => [A.id, B.id])
    assert.equal(await firstMissing(all.tx, wasteFraction, wasteFraction.id, COMPANY, [A, B]), undefined)
    const none = scripted(() => [])
    assert.equal(await firstMissing(none.tx, wasteFraction, wasteFraction.id, COMPANY, []), undefined)
    assert.equal(none.asked(), 0, "nothing named is no statement")
  })
})

describe("eachPresent", () => {
  test("spends one statement on a body whose every id is there", async () => {
    const { tx, asked } = scripted(() => [A.id, B.id])
    const { singular, handed } = passing()
    await eachPresent(tx, wasteFraction, wasteFraction.id, COMPANY, [A, B], singular)
    assert.deepEqual([asked(), handed], [1, []])
  })

  test("hands the missing entry to the singular and asks the set again: a row that arrived between the two statements is there now", async () => {
    // The first statement finds A alone; B arrives; the second finds both.
    const { tx, asked } = scripted((statement) => (statement === 0 ? [A.id] : [A.id, B.id]))
    const { singular, handed } = passing()
    await eachPresent(tx, wasteFraction, wasteFraction.id, COMPANY, [A, B], singular)
    assert.deepEqual(handed, [B], "the singular saw B and let it through")
    assert.equal(asked(), 2, "and the set was asked once more, so no entry is written that no statement proved")
  })

  test("is refused at the singular's word, and asks nothing further", async () => {
    const { tx, asked } = scripted(() => [A.id])
    const refused = new Error("Not a waste fraction of this company")
    await assert.rejects(
      eachPresent(tx, wasteFraction, wasteFraction.id, COMPANY, [A, B], async () => {
        throw refused
      }),
      (error: unknown) => error === refused,
    )
    assert.equal(asked(), 1)
  })

  test("throws on a row flickering under the request: an entry the singular let through and the set finds missing again", async () => {
    const { tx, asked } = scripted(() => [A.id])
    const { singular, handed } = passing()
    await assert.rejects(eachPresent(tx, wasteFraction, wasteFraction.id, COMPANY, [A, B], singular), /ids\.1 names .* which the singular check found and the set did not/)
    assert.deepEqual([asked(), handed], [2, [B]], "the singular was asked once about B, and the loop stopped the second time the set missed it")
  })

  test("throws when two entries take turns, since every path the singular let through is remembered", async () => {
    // The set finds A, then B, then A, and would go on forever if the loop
    // remembered only the last entry it passed: B's turn would look new
    // after A's. It remembers both.
    const { tx, asked } = scripted((statement) => (statement % 2 === 0 ? [A.id] : [B.id]))
    const { singular, handed } = passing()
    await assert.rejects(eachPresent(tx, wasteFraction, wasteFraction.id, COMPANY, [A, B], singular), /ids\.1 names .* which the singular check found and the set did not/)
    assert.deepEqual(handed, [B, A], "B passed, then A passed, then B was missing again")
    assert.equal(asked(), 3)
  })
})

describe("rowsPresent", () => {
  test("runs the loop and then reads every row named, once each, by id", async () => {
    // A is named twice and B arrives late: the loop asks twice, the read is asked once, for the two ids.
    const { tx, asked } = scripted((statement) => (statement === 0 ? [A.id] : [A.id, B.id]))
    const { singular, handed } = passing()
    const asks: (readonly string[])[] = []
    const rows = await rowsPresent(tx, wasteFraction, wasteFraction.id, COMPANY, [A, B, { ...A, path: "ids.2" }], singular, async (ids) => {
      asks.push(ids)
      return ids.map((id) => ({ id, status: id === A.id ? "active" : "retired" }))
    })
    assert.deepEqual(handed, [B])
    assert.deepEqual(asks, [[A.id, B.id]], "one read, every id once")
    assert.deepEqual([...rows.keys()], [A.id, B.id])
    assert.equal(rows.get(B.id)?.status, "retired", "the row that arrived between the statements is read like the rest, so a gate over the rows sees it")
    assert.equal(asked(), 2, "the loop's two statements; the read is the caller's")
  })

  test("names nothing: no statement, no read, an empty map", async () => {
    const { tx, asked } = scripted(() => [])
    let reads = 0
    const rows = await rowsPresent(tx, wasteFraction, wasteFraction.id, COMPANY, [], passing().singular, async () => {
      reads += 1
      return []
    })
    assert.deepEqual([asked(), reads, rows.size], [0, 0, 0])
  })

  test("is refused at the singular's word before any row is read", async () => {
    const { tx } = scripted(() => [])
    let reads = 0
    await assert.rejects(
      rowsPresent(
        tx,
        wasteFraction,
        wasteFraction.id,
        COMPANY,
        [A],
        async () => {
          throw new Error("refused")
        },
        async () => {
          reads += 1
          return []
        },
      ),
      /refused/,
    )
    assert.equal(reads, 0)
  })
})
