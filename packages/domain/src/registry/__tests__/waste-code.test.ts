import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { isWasteCode, wasteCodeOf } from "../waste-code"

describe("a waste code", () => {
  test("is six digits of the European List of Waste, chapter 01 to 20, an asterisk after a hazardous entry's", () => {
    for (const code of ["200301", "200108", "150101", "010101", "200121*", "170503*"]) assert.equal(isWasteCode(code), true, code)
    for (const code of ["", "20030", "2003011", "210101", "000101", "20 03 01", "20-03-01", "*200301", "200301**", "20030a"]) assert.equal(isWasteCode(code), false, code)
  })

  test("is read as the list prints it, its spaces taken out", () => {
    assert.equal(wasteCodeOf("20 03 01"), "200301")
    assert.equal(wasteCodeOf(" 20 01 21* "), "200121*")
    assert.equal(isWasteCode(wasteCodeOf("15 01 01")), true)
  })
})
