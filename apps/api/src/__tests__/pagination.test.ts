import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { Page } from "@waste/contracts/pagination"
import * as z from "zod"

import { afterCursor, decodeCursor, encodeCursor, fetchLimit, pageOf } from "../pagination"
import { ProblemError } from "../problem"

const ID = "01a0d3a5-e5e0-7000-8000-00000000000"
const ids = Array.from({ length: 5 }, (_, i) => `${ID}${i}`)
const rows = ids.map((id, i) => ({ id, name: `Row ${i}` }))

describe("the cursor", () => {
  test("is the id it was made from, and nothing a client can read at a glance", () => {
    const cursor = encodeCursor(ids[0])
    assert.equal(decodeCursor(cursor), ids[0])
    assert.notEqual(cursor, ids[0])
    assert.match(cursor, /^[A-Za-z0-9_-]+$/, "base64url: safe in a query string unescaped")
  })

  test("refuses anything that is not one of ours", () => {
    for (const cursor of ["", "not base64url!", "MjU=", " ", encodeCursor(ids[0]) + "=", encodeCursor("nonsense"), encodeCursor("01a0d3a5-e5e0-4000-8000-000000000000"), Buffer.from("x".repeat(40)).toString("base64url")]) {
      assert.equal(decodeCursor(cursor), undefined, JSON.stringify(cursor))
    }
  })

  test("survives the round trip through a URL", () => {
    const cursor = encodeCursor(ids[4])
    const url = new URL(`https://api.example/projects?cursor=${cursor}`)
    assert.equal(url.searchParams.get("cursor"), cursor)
    assert.equal(decodeCursor(url.searchParams.get("cursor") ?? ""), ids[4])
  })
})

describe("afterCursor", () => {
  test("is nothing at all when the request carried no cursor: that is the first page", () => {
    assert.equal(afterCursor(undefined), undefined)
  })

  test("is the id to read after when the cursor is one of ours", () => {
    assert.equal(afterCursor(encodeCursor(ids[2])), ids[2])
  })

  test("is a 400 naming the cursor when it is not", () => {
    let thrown: unknown
    try {
      afterCursor("nonsense")
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown instanceof ProblemError, "a cursor we did not write is a bad request")
    assert.equal(thrown.body.status, 400)
    assert.deepEqual(thrown.body.errors?.map((error) => error.path), ["cursor"])
    assert.match(thrown.body.errors?.[0].message ?? "", /cursor/i)
    assert.match(thrown.body.detail ?? "", /query/)
  })
})

describe("pageOf", () => {
  test("asks the database for one row more than the page, which is how it knows there is a next one", () => {
    assert.equal(fetchLimit(50), 51)
    assert.equal(fetchLimit(1), 2)
  })

  test("keeps the page and turns the row beyond it into the next cursor", () => {
    const page = pageOf(rows.slice(0, fetchLimit(2)), 2)
    assert.deepEqual(page.items, rows.slice(0, 2))
    assert.equal(page.nextCursor, encodeCursor(ids[1]), "the last item of this page, not the row that was peeked at")
    assert.equal(decodeCursor(page.nextCursor ?? ""), ids[1])
  })

  test("is the last page when the database had no row beyond it, full or not", () => {
    assert.deepEqual(pageOf(rows.slice(0, 2), 2), { items: rows.slice(0, 2), nextCursor: null })
    assert.deepEqual(pageOf(rows.slice(0, 1), 2), { items: rows.slice(0, 1), nextCursor: null })
    assert.deepEqual(pageOf([], 2), { items: [], nextCursor: null })
  })

  test("answers the shape @waste/contracts/pagination spells", () => {
    const Item = z.object({ id: z.string(), name: z.string() })
    assert.deepEqual(Page(Item).parse(pageOf(rows.slice(0, fetchLimit(2)), 2)).items.length, 2)
    assert.deepEqual(Page(Item).parse(pageOf(rows.slice(0, 1), 2)).nextCursor, null)
  })

  test("refuses a page size that is not a whole number of rows: that is a bug here, not a bad request", () => {
    for (const limit of [0, -1, 1.5, Number.NaN]) assert.throws(() => pageOf(rows, limit), /page size/, String(limit))
  })
})
