import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { addressDesignation, FOUR_DIGITS_PATTERN, type AddressParts } from "../address"

const parkvej: AddressParts = { streetName: "Parkvej", houseNumber: "18", floor: null, door: null, postcode: "2100", postTown: "København Ø", municipalityCode: "0101" }

describe("an address's designation", () => {
  test("is the street and number, then the postcode and town", () => {
    assert.equal(addressDesignation(parkvej), "Parkvej 18, 2100 København Ø")
  })

  test("names a unit's floor and door between them, a numbered floor with its period", () => {
    assert.equal(addressDesignation({ ...parkvej, floor: "2", door: "th" }), "Parkvej 18, 2. th, 2100 København Ø")
    assert.equal(addressDesignation({ ...parkvej, floor: "st", door: null }), "Parkvej 18, st, 2100 København Ø")
    assert.equal(addressDesignation({ ...parkvej, floor: null, door: "3" }), "Parkvej 18, 3, 2100 København Ø")
  })

  test("reads a postcode and a municipality code as four digits", () => {
    const fourDigits = new RegExp(FOUR_DIGITS_PATTERN)
    for (const code of ["0101", "2100", "8000"]) assert.equal(fourDigits.test(code), true, code)
    for (const code of ["101", "21000", "21 0", "abcd", ""]) assert.equal(fourDigits.test(code), false, code)
  })
})
