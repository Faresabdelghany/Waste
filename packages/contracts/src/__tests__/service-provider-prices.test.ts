import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { ServiceProviderPrice, ServiceProviderPriceCreate, ServiceProviderPriceIndex, ServiceProviderPriceListQuery, ServiceProviderPricePatch } from "../service-provider-prices"
import { ENDS_AFTER_IT_STARTS } from "../validity"
import { refusal, refusesAnEmptyPatch, refusesWhatTheServerOwns } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const THIRD = "01a0d3a5-e5e0-7000-8000-000000000003"
const STAMPS = { createdAt: "2026-09-25T09:00:00.000Z", updatedAt: "2026-09-25T09:00:00.000Z" }
const BACKWARDS = { path: "validTo", message: ENDS_AFTER_IT_STARTS }

const price = {
  id: ID,
  projectId: OTHER,
  serviceAreaAssignmentId: THIRD,
  productId: OTHER,
  bidMinor: 8_000,
  unitPriceMinor: 8_000,
  currency: "DKK",
  indexedFromId: null,
  indexLabel: null,
  indexBasisPoints: null,
  indexBase: null,
  notes: null,
  validFrom: "2026-01-01",
  validTo: null,
  ...STAMPS,
}

describe("ServiceProviderPrice", () => {
  test("is the first row of a chain — the bid and the fee alike, no index — or an indexed row naming the one it came from with the label, the basis points and the base", () => {
    assert.deepEqual(ServiceProviderPrice.parse(price), price)
    const indexed = { ...price, id: OTHER, unitPriceMinor: 8_400, indexedFromId: ID, indexLabel: "CPI", indexBasisPoints: 500, indexBase: "current-fee", validFrom: "2027-01-01", notes: "Base collection 80 kr flat per pickup" }
    assert.deepEqual(ServiceProviderPrice.parse(indexed), indexed)
    const deflated = { ...indexed, indexBasisPoints: -200, indexBase: "bid", unitPriceMinor: 7_840 }
    assert.deepEqual(ServiceProviderPrice.parse(deflated), deflated)
  })

  test("holds the bid and the fee to zero or more, the base to its vocabulary, the currency to ISO 4217 and the period to running forwards", () => {
    for (const field of ["bidMinor", "unitPriceMinor"] as const) assert.deepEqual(refusal(ServiceProviderPrice.safeParse({ ...price, [field]: -1 })).map((issue) => issue.path), [field], field)
    assert.deepEqual(refusal(ServiceProviderPrice.safeParse({ ...price, indexBase: "current fee" })).map((issue) => issue.path), ["indexBase"])
    assert.deepEqual(refusal(ServiceProviderPrice.safeParse({ ...price, currency: "kr" })).map((issue) => issue.path), ["currency"])
    assert.deepEqual(refusal(ServiceProviderPrice.safeParse({ ...price, validTo: "2026-01-01" })), [BACKWARDS])
  })
})

describe("ServiceProviderPriceCreate, ServiceProviderPricePatch and ServiceProviderPriceIndex", () => {
  const body = { serviceAreaAssignmentId: THIRD, productId: OTHER, bidMinor: 8_000, validFrom: "2026-01-01" }

  test("the create takes the assignment, the product, the bid and a first day, the fee defaulting to the bid on the server, and no currency, project or index", () => {
    assert.deepEqual(ServiceProviderPriceCreate.parse(body), body)
    assert.deepEqual(ServiceProviderPriceCreate.parse({ ...body, unitPriceMinor: 8_200, notes: null, validTo: "2027-01-01" }), { ...body, unitPriceMinor: 8_200, notes: null, validTo: "2027-01-01" })
    assert.match(ServiceProviderPriceCreate.shape.unitPriceMinor.description ?? "", /bid/)
    for (const key of Object.keys(body)) {
      const without: Record<string, unknown> = { ...body }
      delete without[key]
      assert.deepEqual(refusal(ServiceProviderPriceCreate.safeParse(without)).map((issue) => issue.path), [key])
    }
    refusesWhatTheServerOwns(ServiceProviderPriceCreate, body)
    for (const key of ["currency", "projectId", "indexedFromId", "indexLabel", "indexBasisPoints", "indexBase"]) assert.match(refusal(ServiceProviderPriceCreate.safeParse({ ...body, [key]: "x" }))[0].message, new RegExp(key), key)
    assert.deepEqual(refusal(ServiceProviderPriceCreate.safeParse({ ...body, validTo: "2025-12-31" })), [BACKWARDS])
    assert.deepEqual(refusal(ServiceProviderPriceCreate.safeParse({ ...body, bidMinor: -1 })).map((issue) => issue.path), ["bidMinor"])
  })

  test("the patch moves the notes and the end, refuses an empty patch, and never the bid or the fee: the bid is locked, the fee moves by index alone", () => {
    assert.deepEqual(ServiceProviderPricePatch.parse({ validTo: "2027-01-01" }), { validTo: "2027-01-01" })
    assert.deepEqual(ServiceProviderPricePatch.parse({ notes: null }), { notes: null })
    refusesAnEmptyPatch(ServiceProviderPricePatch)
    for (const [key, value] of [
      ["bidMinor", 9_000],
      ["unitPriceMinor", 9_000],
      ["validFrom", "2026-02-01"],
      ["productId", OTHER],
      ["serviceAreaAssignmentId", OTHER],
    ] as const) {
      assert.match(refusal(ServiceProviderPricePatch.safeParse({ notes: "x", [key]: value }))[0].message, new RegExp(key), key)
    }
  })

  test("the index takes the label, the basis points either sign, the base and the day it applies from", () => {
    const index = { label: "CPI", basisPoints: 500, base: "current-fee", appliedFrom: "2027-01-01" }
    assert.deepEqual(ServiceProviderPriceIndex.parse(index), index)
    assert.deepEqual(ServiceProviderPriceIndex.parse({ ...index, basisPoints: -200, base: "bid" }), { ...index, basisPoints: -200, base: "bid" })
    for (const key of Object.keys(index)) {
      const without: Record<string, unknown> = { ...index }
      delete without[key]
      assert.deepEqual(refusal(ServiceProviderPriceIndex.safeParse(without)).map((issue) => issue.path), [key])
    }
    assert.deepEqual(refusal(ServiceProviderPriceIndex.safeParse({ ...index, basisPoints: 5.5 })).map((issue) => issue.path), ["basisPoints"])
    assert.deepEqual(refusal(ServiceProviderPriceIndex.safeParse({ ...index, base: "fee" })).map((issue) => issue.path), ["base"])
    assert.deepEqual(refusal(ServiceProviderPriceIndex.safeParse({ ...index, unitPriceMinor: 8_400 })).map((issue) => issue.path), [""], "the new fee is computed, not given")
  })
})

describe("ServiceProviderPriceListQuery", () => {
  test("pages by project, assignment, provider, product and day", () => {
    assert.deepEqual(ServiceProviderPriceListQuery.parse({}), { limit: 50 })
    assert.deepEqual(ServiceProviderPriceListQuery.parse({ serviceAreaAssignmentId: THIRD, serviceProviderId: OTHER, productId: ID, validOn: "2026-06-01" }), { limit: 50, serviceAreaAssignmentId: THIRD, serviceProviderId: OTHER, productId: ID, validOn: "2026-06-01" })
    assert.deepEqual(refusal(ServiceProviderPriceListQuery.safeParse({ validOn: "June" })).map((issue) => issue.path), ["validOn"])
  })
})
