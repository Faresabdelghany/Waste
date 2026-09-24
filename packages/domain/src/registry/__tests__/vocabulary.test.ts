// The Registry vocabulary is read by the database check (`oneOf`) and by the
// contracts enum (`z.enum`), so there is no second spelling to hold in
// lockstep and nothing here compares two lists. What is held is the shape every
// list has to keep: a value is a kebab-case token, because it is written into a
// migration as a SQL literal and onto the wire as a zod enum member, and a list
// with a duplicate or a gap would put one of the two somewhere it does not
// belong. `REGISTRY_VOCABULARIES` is what lets this walk them all, so a list
// added to the module and left out of the object is caught here.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  AGREEMENT_STATUSES,
  BILLING_CADENCES,
  CONTAINER_OWNERSHIPS,
  CUSTOMER_KINDS,
  CUSTOMER_STATUSES,
  PRODUCT_KINDS,
  PRODUCT_STATUSES,
  PRODUCT_UNITS,
  PROPERTY_GROUP_MEMBER_ROLES,
  PROPERTY_GROUP_PURPOSES,
  PROPERTY_GROUP_STATUSES,
  PROPERTY_KINDS,
  PROPERTY_PARTY_ROLES,
  PROPERTY_STATUSES,
  REGISTRY_VOCABULARIES,
  SHARED_COLLECTION_POINT_ACCESS_MODES,
  SHARED_COLLECTION_POINT_BILLING_MODES,
  SHARED_COLLECTION_POINT_KINDS,
  SHARED_COLLECTION_POINT_MEMBER_ROLES,
  SHARED_COLLECTION_POINT_OPERATING_MODELS,
  SHARED_COLLECTION_POINT_STATUSES,
} from "../vocabulary"

/** A value of any list: lowercase words joined by single hyphens, nothing else. */
const TOKEN = /^[a-z]+(-[a-z]+)*$/

describe("the Registry vocabulary", () => {
  test("every list has values, each a kebab-case token, and names none of them twice", () => {
    for (const [name, values] of Object.entries(REGISTRY_VOCABULARIES)) {
      assert.ok(values.length > 0, `${name} is empty`)
      for (const value of values) assert.match(value, TOKEN, `${name} has "${value}"`)
      assert.equal(new Set(values).size, values.length, `${name} spells a value twice`)
    }
  })

  test("REGISTRY_VOCABULARIES names exactly the twenty lists, each the list itself", () => {
    assert.deepEqual(REGISTRY_VOCABULARIES, {
      CUSTOMER_KINDS,
      CUSTOMER_STATUSES,
      PROPERTY_KINDS,
      PROPERTY_STATUSES,
      PROPERTY_PARTY_ROLES,
      PROPERTY_GROUP_PURPOSES,
      PROPERTY_GROUP_STATUSES,
      PROPERTY_GROUP_MEMBER_ROLES,
      SHARED_COLLECTION_POINT_KINDS,
      SHARED_COLLECTION_POINT_OPERATING_MODELS,
      SHARED_COLLECTION_POINT_ACCESS_MODES,
      SHARED_COLLECTION_POINT_BILLING_MODES,
      SHARED_COLLECTION_POINT_STATUSES,
      SHARED_COLLECTION_POINT_MEMBER_ROLES,
      PRODUCT_KINDS,
      PRODUCT_STATUSES,
      PRODUCT_UNITS,
      AGREEMENT_STATUSES,
      BILLING_CADENCES,
      CONTAINER_OWNERSHIPS,
    })
    assert.equal(Object.keys(REGISTRY_VOCABULARIES).length, 20)
  })
})
