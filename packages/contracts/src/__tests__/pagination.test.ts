import assert from "node:assert/strict"
import { describe, test } from "node:test"
import * as z from "zod"

import { PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX, Page, PageRequest } from "../pagination"

describe("PageRequest", () => {
  test("defaults the limit and leaves the cursor absent", () => {
    assert.deepEqual(PageRequest.parse({}), { limit: PAGE_LIMIT_DEFAULT })
    assert.equal(PAGE_LIMIT_DEFAULT, 50)
    assert.equal(PAGE_LIMIT_MAX, 200)
  })

  test("reads the limit from a query string and keeps it a whole number in range", () => {
    assert.deepEqual(PageRequest.parse({ limit: "25", cursor: "opaque" }), { limit: 25, cursor: "opaque" })
    assert.equal(PageRequest.parse({ limit: 200 }).limit, 200)
    assert.equal(PageRequest.parse({ limit: 1 }).limit, 1)
    assert.equal(PageRequest.safeParse({ limit: "0" }).success, false)
    assert.equal(PageRequest.safeParse({ limit: "201" }).success, false)
    assert.equal(PageRequest.safeParse({ limit: "2.5" }).success, false)
    assert.equal(PageRequest.safeParse({ limit: 2.5 }).success, false)
    assert.equal(PageRequest.safeParse({ limit: "many" }).success, false)
  })

  test("an empty or null limit is not given and takes the default", () => {
    assert.deepEqual(PageRequest.parse({ limit: "" }), { limit: PAGE_LIMIT_DEFAULT })
    assert.deepEqual(PageRequest.parse({ limit: null }), { limit: PAGE_LIMIT_DEFAULT })
  })

  test("coerces decimal digits only: no booleans, arrays, hex, exponents or padding", () => {
    for (const value of [true, ["25"], ["25", "30"], "0x19", "1e1", " 25 ", "+25", "25px"]) {
      assert.equal(PageRequest.safeParse({ limit: value }).success, false, JSON.stringify(value))
    }
  })

  test("rejects an empty cursor: absent means the first page", () => {
    assert.equal(PageRequest.safeParse({ cursor: "" }).success, false)
    assert.equal(PageRequest.safeParse({ cursor: 7 }).success, false)
  })
})

describe("Page", () => {
  const Item = z.object({ id: z.string(), name: z.string() })
  const ItemPage = Page(Item)

  test("wraps the items with the cursor of the next page, or null on the last page", () => {
    const first = { items: [{ id: "a", name: "A" }], nextCursor: "after-a" }
    assert.deepEqual(ItemPage.parse(first), first)
    assert.deepEqual(ItemPage.parse({ items: [], nextCursor: null }), { items: [], nextCursor: null })
  })

  test("validates every item and insists on the cursor field", () => {
    assert.equal(ItemPage.safeParse({ items: [{ id: "a" }], nextCursor: null }).success, false)
    assert.equal(ItemPage.safeParse({ items: [] }).success, false, "nextCursor missing")
    assert.equal(ItemPage.safeParse({ items: [], nextCursor: "" }).success, false, "empty cursor")
  })
})
