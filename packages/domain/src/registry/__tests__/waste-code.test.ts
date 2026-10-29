import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { hazardousAgrees, hazardousOf, isHazardousCode, isWasteCode, wasteCodeOf, wasteCodePrinted } from "../waste-code"

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

describe("a fraction's hazardous flag", () => {
  test("is what a starred code says, and may be set under any other code or none", () => {
    assert.equal(isHazardousCode("200121*"), true)
    assert.equal(isHazardousCode("200301"), false)
    assert.equal(hazardousAgrees("200121*", true), true)
    assert.equal(hazardousAgrees("200121*", false), false)
    assert.equal(hazardousAgrees("200301", true), true, "a mirror entry's waste may be hazardous")
    assert.equal(hazardousAgrees(null, true), true)
    assert.equal(hazardousAgrees(null, false), true)
  })

  test("is the write's own where it gives one, the starred code's where it does not, else as it was", () => {
    assert.equal(hazardousOf("200121*", false, true), false, "given, even against the code: the check refuses it after")
    assert.equal(hazardousOf("200121*", undefined, false), true)
    assert.equal(hazardousOf("200301", undefined, true), true, "a code that loses its asterisk leaves the flag as it was")
    assert.equal(hazardousOf(null, undefined, false), false)
  })
})

describe("a waste code printed", () => {
  test("spaces its pairs as the list prints them, the asterisk kept", () => {
    assert.equal(wasteCodePrinted("200301"), "20 03 01")
    assert.equal(wasteCodePrinted("200133*"), "20 01 33*")
    assert.equal(wasteCodeOf(wasteCodePrinted("150101")), "150101", "read back as it is stored")
  })
})
