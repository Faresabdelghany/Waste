import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { Address, ADDRESS_QUERY_MAX, AddressSearch, AddressSearchQuery } from "../addresses"

const ID = "0a3f50a0-75ba-32b8-e044-0003ba298018"
const PARTS = { streetName: "Parkvej", houseNumber: "18", floor: null, door: null, postcode: "2100", postTown: "København Ø", municipalityCode: "0101" }
const address = {
  id: ID,
  designation: "Parkvej 18, 2100 København Ø",
  parts: PARTS,
  registryId: "100012345",
  location: { type: "Point", coordinates: [12.5763, 55.7046] },
  attribution: "Indeholder data fra Klimadatastyrelsen, CC BY 4.0",
}

describe("the address lookup (#291 C13)", () => {
  test("searches with the text typed so far, trimmed, two characters at least and bounded", () => {
    assert.deepEqual(AddressSearchQuery.parse({ q: "  park " }), { q: "park" })
    assert.equal(AddressSearchQuery.safeParse({ q: " p " }).success, false)
    assert.equal(AddressSearchQuery.safeParse({ q: "p".repeat(ADDRESS_QUERY_MAX + 1) }).success, false)
    assert.equal(AddressSearchQuery.safeParse({ q: "park", limit: 3 }).success, false, "a query names nothing else")
  })

  test("answers matches by the register's id and designation, ten at most", () => {
    const match = { id: ID, designation: address.designation }
    assert.deepEqual(AddressSearch.parse({ items: [match], attribution: address.attribution }).items, [match])
    assert.equal(AddressSearch.safeParse({ items: Array.from({ length: 11 }, () => match), attribution: "" }).success, false)
  })

  test("reads one address whole: its parts, the BFE number it lies on and its point, either of the two absent", () => {
    assert.deepEqual(Address.parse(address), address)
    assert.deepEqual(Address.parse({ ...address, registryId: null, location: null }).location, null)
    assert.equal(Address.safeParse({ ...address, parts: { ...PARTS, postcode: "210" } }).success, false, "a postcode is four digits")
    assert.equal(Address.safeParse({ ...address, parts: { ...PARTS, municipalityCode: "101" } }).success, false, "a municipality code is four digits")
    assert.equal(Address.safeParse({ ...address, id: "Parkvej 18" }).success, false)
  })
})
