// What a query string spells (query-strings.ts): numbers in plain digits and
// flags as `true` or `false`, nothing looser.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { QueryDecimal, QueryFlag, QueryWhole } from "../query-strings"

describe("QueryFlag", () => {
  test("reads `true` and `false`, exactly", () => {
    assert.equal(QueryFlag.parse("true"), true)
    assert.equal(QueryFlag.parse("false"), false)
  })

  test("refuses every other spelling rather than guess", () => {
    for (const flag of ["True", "FALSE", "1", "0", "yes", "", " true"]) assert.equal(QueryFlag.safeParse(flag).success, false, JSON.stringify(flag))
  })
})

describe("QueryWhole and QueryDecimal", () => {
  test("read digits plainly: no hex, no exponent, no padding, no flag", () => {
    assert.equal(QueryWhole.parse("25"), 25)
    assert.equal(QueryDecimal.parse("2.34"), 2.34)
    for (const number of ["0x10", "1e3", " 2 ", "true", ""]) {
      assert.equal(QueryWhole.safeParse(number).success, false, `whole ${JSON.stringify(number)}`)
      assert.equal(QueryDecimal.safeParse(number).success, false, `decimal ${JSON.stringify(number)}`)
    }
  })
})
