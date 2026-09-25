import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { BOTH_HOURS_OR_NEITHER, PROVIDER_WITH_PROVIDER_OWNERSHIP } from "@waste/contracts/places"

import { ProblemError } from "../problem"
import { placeShapeInvalid, requirePlaceShape, type PlaceShape } from "../routes/place-rules"

const PROVIDER = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const providerIssue = { path: "serviceProviderId", message: PROVIDER_WITH_PROVIDER_OWNERSHIP }
const hoursIssue = { path: "closesAt", message: BOTH_HOURS_OR_NEITHER }

/** A stored depot the company runs, with no hours. */
const company: PlaceShape = { ownership: "company", serviceProviderId: null, opensAt: null, closesAt: null }
/** A stored provider's depot, open six to four, as Postgres spells the hours. */
const providers: PlaceShape = { ownership: "service-provider", serviceProviderId: PROVIDER, opensAt: "06:00:00", closesAt: "16:00:00" }

/** The 400 a refused patch raises, as its field errors. */
const refusal = (run: () => void) => {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof ProblemError, String(error))
    assert.equal(error.body.status, 400)
    return error.body.errors
  }
  assert.fail("the patch was let through")
}

describe("requirePlaceShape, the patch held against the stored row (database-free)", () => {
  test("lets a patch through that leaves the row whole, and one that touches neither rule", () => {
    requirePlaceShape(company, {})
    requirePlaceShape(company, { ownership: "service-provider", serviceProviderId: PROVIDER })
    requirePlaceShape(providers, { ownership: "company", serviceProviderId: null })
    requirePlaceShape(providers, { serviceProviderId: OTHER })
    requirePlaceShape(company, { opensAt: "22:00", closesAt: "05:00" })
    requirePlaceShape(providers, { closesAt: "17:00" })
    requirePlaceShape(providers, { opensAt: null, closesAt: null })
  })

  test("refuses the ownership and the provider disagreeing, at serviceProviderId, in the contracts' words", () => {
    assert.deepEqual(refusal(() => requirePlaceShape(company, { ownership: "service-provider" })), [providerIssue], "a company depot made a provider's names no provider")
    assert.deepEqual(refusal(() => requirePlaceShape(company, { serviceProviderId: PROVIDER })), [providerIssue], "a company depot naming a provider stays the company's")
    assert.deepEqual(refusal(() => requirePlaceShape(providers, { ownership: "company" })), [providerIssue], "taking the ownership back leaves the provider named")
    assert.deepEqual(refusal(() => requirePlaceShape(providers, { serviceProviderId: null })), [providerIssue], "taking the provider off leaves the ownership a provider's")
  })

  test("refuses one hour without the other, at closesAt", () => {
    assert.deepEqual(refusal(() => requirePlaceShape(company, { opensAt: "06:00" })), [hoursIssue])
    assert.deepEqual(refusal(() => requirePlaceShape(company, { closesAt: "16:00" })), [hoursIssue])
    assert.deepEqual(refusal(() => requirePlaceShape(providers, { opensAt: null })), [hoursIssue], "taking one time off leaves the other alone")
    assert.deepEqual(refusal(() => requirePlaceShape(providers, { closesAt: null })), [hoursIssue])
  })

  test("lists both rules in the one 400 when a patch breaks both, the provider first", () => {
    assert.deepEqual(refusal(() => requirePlaceShape(company, { ownership: "service-provider", opensAt: "06:00" })), [providerIssue, hoursIssue])
    assert.deepEqual(refusal(() => requirePlaceShape(providers, { serviceProviderId: null, closesAt: null })), [providerIssue, hoursIssue], "taking the provider and one time off")
  })
})

describe("placeShapeInvalid, the refuseCheck door behind it", () => {
  test("maps a table's two shape checks onto the same two refusals, by the constraint names the migration spells", () => {
    assert.deepEqual(placeShapeInvalid("depot"), { depot_provider_shape: providerIssue, depot_hours_shape: hoursIssue })
    assert.deepEqual(placeShapeInvalid("unloading_station"), { unloading_station_provider_shape: providerIssue, unloading_station_hours_shape: hoursIssue })
  })
})
