import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Address } from "@waste/contracts/addresses"

import { addressPicked, picksLetGoBy } from "../address-lookup"
import type { BusinessFormField } from "../business-form-types"

const FIELDS = { address: "serviceAddress", registryId: "registryId", latitude: "latitude", longitude: "longitude" }
const PARKVEJ: Address = {
  id: "0a3f50a0-75ba-32b8-e044-0003ba298005",
  designation: "Parkvej 18, 2100 København Ø",
  parts: { streetName: "Parkvej", houseNumber: "18", floor: null, door: null, postcode: "2100", postTown: "København Ø", municipalityCode: "0101" },
  registryId: "100045674",
  location: { type: "Point", coordinates: [12.5763, 55.7046] },
  attribution: "Indeholder data fra Klimadatastyrelsen, CC BY 4.0",
}

describe("an address picked from the register (#291 C13)", () => {
  test("fills the address, and the BFE number and the point where the form holds none", () => {
    assert.deepEqual(addressPicked("addressId", FIELDS, PARKVEJ, { serviceAddress: "park", registryId: "", latitude: "", longitude: "" }), {
      addressId: PARKVEJ.id,
      serviceAddress: "Parkvej 18, 2100 København Ø",
      registryId: "100045674",
      latitude: "55.7046",
      longitude: "12.5763",
    })
  })

  test("keeps a number and a point the office typed, either ordinate counting as placed", () => {
    assert.deepEqual(addressPicked("addressId", FIELDS, PARKVEJ, { registryId: "CPH-1", latitude: "55.7", longitude: "" }), {
      addressId: PARKVEJ.id,
      serviceAddress: "Parkvej 18, 2100 København Ø",
    })
  })

  test("leaves blank what the register does not hold", () => {
    assert.deepEqual(addressPicked("addressId", FIELDS, { ...PARKVEJ, registryId: null, location: null }, {}), { addressId: PARKVEJ.id, serviceAddress: "Parkvej 18, 2100 København Ø" })
  })

  test("goes when the address it filled is typed over, and nothing else lets it go", () => {
    const fields: BusinessFormField[] = [
      { id: "addressId", label: "Find in the address register", type: "address-lookup", addressLookup: FIELDS },
      { id: "serviceAddress", label: "Service address", type: "textarea" },
    ]
    assert.deepEqual(picksLetGoBy(fields, "serviceAddress"), ["addressId"])
    assert.deepEqual(picksLetGoBy(fields, "registryId"), [])
  })
})
