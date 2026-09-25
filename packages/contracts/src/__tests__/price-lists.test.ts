import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  PriceList,
  PriceListCreate,
  PriceListListQuery,
  PriceListPatch,
  PriceListRow,
  PriceListRowCreate,
  PriceListRowListQuery,
  PriceListRowPatch,
  PriceResolution,
  PriceResolveQuery,
  RowVerdict,
} from "../price-lists"
import { ENDS_AFTER_IT_STARTS } from "../validity"
import { refusal, refusesAnEmptyPatch, refusesWhatTheServerOwns } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const THIRD = "01a0d3a5-e5e0-7000-8000-000000000003"
const STAMPS = { createdAt: "2026-09-25T09:00:00.000Z", updatedAt: "2026-09-25T09:00:00.000Z" }
const BACKWARDS = { path: "validTo", message: ENDS_AFTER_IT_STARTS }

const list = {
  id: ID,
  projectId: OTHER,
  code: "pl-cph-2026",
  name: "Copenhagen tariff 2026",
  currency: "DKK",
  isDefault: true,
  notes: null,
  validFrom: "2026-01-01",
  validTo: null,
  ...STAMPS,
}

const row = {
  id: ID,
  projectId: OTHER,
  priceListId: THIRD,
  productId: OTHER,
  unitPriceMinor: 12_345,
  planningAreaId: null,
  customerKind: null,
  containerTypeId: null,
  wasteFractionId: null,
  customerId: null,
  note: null,
  validFrom: "2026-01-01",
  validTo: null,
  ...STAMPS,
}

describe("PriceList", () => {
  test("is the list on the wire: a slug code, a name, a currency, whether it is the default, and the period it is in force for", () => {
    assert.deepEqual(PriceList.parse(list), list)
    const named = { ...list, code: "pl-housing", isDefault: false, notes: "Negotiated with the housing association", validTo: "2027-01-01" }
    assert.deepEqual(PriceList.parse(named), named)
  })

  test("holds the code to a slug, the currency to ISO 4217 and the period to running forwards", () => {
    for (const code of ["PL-CPH-2026", "pl cph", "pl_cph", ""]) assert.deepEqual(refusal(PriceList.safeParse({ ...list, code })).map((issue) => issue.path), ["code"], code)
    assert.deepEqual(refusal(PriceList.safeParse({ ...list, currency: "dkk" })).map((issue) => issue.path), ["currency"])
    assert.deepEqual(refusal(PriceList.safeParse({ ...list, validTo: "2026-01-01" })), [BACKWARDS])
  })
})

describe("PriceListCreate and PriceListPatch", () => {
  const body = { projectId: OTHER, code: "pl-cph-2026", name: "Copenhagen tariff 2026", validFrom: "2026-01-01" }

  test("default the flag to false and leave the currency to the project when absent, and say so in the schema", () => {
    assert.deepEqual(PriceListCreate.parse(body), { ...body, isDefault: false })
    assert.deepEqual(PriceListCreate.parse({ ...body, currency: "EUR", isDefault: true, notes: null, validTo: "2027-01-01" }), { ...body, currency: "EUR", isDefault: true, notes: null, validTo: "2027-01-01" })
    assert.match(PriceListCreate.shape.isDefault.description ?? "", /false/)
    assert.match(PriceListCreate.shape.currency.description ?? "", /project/)
  })

  test("need the project, the code, the name and a first day, refuse a backwards period, and mint nothing", () => {
    for (const key of Object.keys(body)) {
      const without: Record<string, unknown> = { ...body }
      delete without[key]
      assert.deepEqual(refusal(PriceListCreate.safeParse(without)).map((issue) => issue.path), [key])
    }
    assert.deepEqual(refusal(PriceListCreate.safeParse({ ...body, validTo: "2025-12-31" })), [BACKWARDS])
    refusesWhatTheServerOwns(PriceListCreate, body)
  })

  test("patch the name, the flag, the notes and the period, refuse an empty patch, and never the code or the currency the rows are quoted in", () => {
    assert.deepEqual(PriceListPatch.parse({ isDefault: false }), { isDefault: false })
    assert.deepEqual(PriceListPatch.parse({ validTo: null, notes: null }), { validTo: null, notes: null })
    refusesAnEmptyPatch(PriceListPatch)
    for (const [key, value] of [
      ["code", "pl-x"],
      ["currency", "EUR"],
      ["projectId", OTHER],
    ] as const) {
      assert.match(refusal(PriceListPatch.safeParse({ name: "x", [key]: value }))[0].message, new RegExp(key), key)
    }
    assert.deepEqual(refusal(PriceListPatch.safeParse({ validFrom: "2026-02-01", validTo: "2026-02-01" })), [BACKWARDS])
  })
})

describe("PriceListRow", () => {
  test("is one price under a condition set: the default row names none, a zone row a planning area, a negotiated row its customer — and never the condition key", () => {
    assert.deepEqual(PriceListRow.parse(row), row)
    const zone = { ...row, planningAreaId: THIRD, customerKind: "organisation", containerTypeId: ID, wasteFractionId: OTHER, unitPriceMinor: 15_000, validTo: "2027-01-01" }
    assert.deepEqual(PriceListRow.parse(zone), zone)
    const deal = { ...row, customerId: THIRD, unitPriceMinor: 900, note: "Agreed at the annual meeting" }
    assert.deepEqual(PriceListRow.parse(deal), deal)
    assert.equal("conditionKey" in PriceListRow.shape, false, "the database's device for its exclusion constraint")
    assert.equal("conditionKey" in PriceListRow.parse({ ...row, conditionKey: "////" }), false, "a resource is not strict: an unknown member is dropped, not refused")
  })

  test("takes a price of zero and never a negative one, holds the kind to the Registry's, and the period to running forwards", () => {
    assert.equal(PriceListRow.parse({ ...row, unitPriceMinor: 0 }).unitPriceMinor, 0, "a free service is a price, not a missing row")
    for (const unitPriceMinor of [-1, 12.5]) assert.deepEqual(refusal(PriceListRow.safeParse({ ...row, unitPriceMinor })).map((issue) => issue.path), ["unitPriceMinor"], String(unitPriceMinor))
    assert.deepEqual(refusal(PriceListRow.safeParse({ ...row, customerKind: "Household" })).map((issue) => issue.path), ["customerKind"])
    assert.deepEqual(refusal(PriceListRow.safeParse({ ...row, validTo: "2025-01-01" })), [BACKWARDS])
  })
})

describe("PriceListRowCreate and PriceListRowPatch", () => {
  const body = { productId: OTHER, unitPriceMinor: 12_345, validFrom: "2026-01-01" }

  test("take the product, the price and a first day, every condition as null or absent, and neither the list nor the project", () => {
    assert.deepEqual(PriceListRowCreate.parse(body), body)
    const zone = { ...body, planningAreaId: THIRD, customerKind: "person", containerTypeId: null, wasteFractionId: ID, customerId: null, note: "Harbour rate", validTo: "2027-01-01" }
    assert.deepEqual(PriceListRowCreate.parse(zone), zone)
    for (const key of Object.keys(body)) {
      const without: Record<string, unknown> = { ...body }
      delete without[key]
      assert.deepEqual(refusal(PriceListRowCreate.safeParse(without)).map((issue) => issue.path), [key])
    }
    for (const key of ["priceListId", "projectId", "conditionKey"]) assert.match(refusal(PriceListRowCreate.safeParse({ ...body, [key]: ID }))[0].message, new RegExp(key), key)
    refusesWhatTheServerOwns(PriceListRowCreate, body)
    assert.deepEqual(refusal(PriceListRowCreate.safeParse({ ...body, validTo: "2026-01-01" })), [BACKWARDS])
  })

  test("patch the price, the note and the end, refuse an empty patch, and never a condition or the start: end the row and add another", () => {
    assert.deepEqual(PriceListRowPatch.parse({ unitPriceMinor: 12_900 }), { unitPriceMinor: 12_900 })
    assert.deepEqual(PriceListRowPatch.parse({ validTo: "2027-01-01", note: null }), { validTo: "2027-01-01", note: null })
    refusesAnEmptyPatch(PriceListRowPatch)
    for (const key of ["validFrom", "planningAreaId", "customerKind", "containerTypeId", "wasteFractionId", "customerId", "productId"]) {
      assert.match(refusal(PriceListRowPatch.safeParse({ unitPriceMinor: 1, [key]: "x" }))[0].message, new RegExp(key), key)
    }
    assert.deepEqual(refusal(PriceListRowPatch.safeParse({ unitPriceMinor: -1 })).map((issue) => issue.path), ["unitPriceMinor"])
  })
})

describe("the resolve read", () => {
  test("PriceResolveQuery names the product and the day, and the conditions the rows are judged against", () => {
    assert.deepEqual(PriceResolveQuery.parse({ productId: OTHER, on: "2026-08-20" }), { productId: OTHER, on: "2026-08-20" })
    const whole = { productId: OTHER, on: "2026-08-20", planningAreaId: THIRD, customerKind: "organisation", containerTypeId: ID, wasteFractionId: OTHER, customerId: THIRD }
    assert.deepEqual(PriceResolveQuery.parse(whole), whole)
    assert.deepEqual(refusal(PriceResolveQuery.safeParse({ productId: OTHER })).map((issue) => issue.path), ["on"])
    for (const on of ["2026-08-20T00:00:00Z", "20/08/2026", "today", "2026-8-20"]) assert.deepEqual(refusal(PriceResolveQuery.safeParse({ productId: OTHER, on })).map((issue) => issue.path), ["on"], on)
    assert.deepEqual(refusal(PriceResolveQuery.safeParse({ productId: OTHER, on: "2026-08-20", customerKind: "Household" })).map((issue) => issue.path), ["customerKind"])
    assert.equal(PriceResolveQuery.safeParse({ productId: OTHER, on: "2026-08-20", limit: "10" }).success, true, "an unknown parameter is dropped, not refused: a query string is not a body")
  })

  test("PriceResolution answers every verdict, the winner, its price, the rate and the currency", () => {
    const won = { row, eligible: true, reason: null, matched: [], score: 0, winner: true }
    const lost = { row: { ...row, id: OTHER, planningAreaId: THIRD }, eligible: false, reason: "Requires planning area Central", matched: [], score: -1, winner: false }
    assert.deepEqual(RowVerdict.parse(won), won)
    const resolution = { verdicts: [won, lost], winner: won, unitPriceMinor: 12_345, vatPercent: 25, currency: "DKK" }
    assert.deepEqual(PriceResolution.parse(resolution), resolution)
    const none = { verdicts: [lost], winner: null, unitPriceMinor: null, vatPercent: null, currency: "DKK" }
    assert.deepEqual(PriceResolution.parse(none), none)
    assert.deepEqual(refusal(PriceResolution.safeParse({ ...resolution, currency: "kr" })).map((issue) => issue.path), ["currency"])
    assert.deepEqual(refusal(RowVerdict.safeParse({ ...won, score: 1.5 })).map((issue) => issue.path), ["score"])
  })
})

describe("the list queries", () => {
  test("PriceListListQuery pages by project, day and the default flag, spelled as a query string spells a boolean", () => {
    assert.deepEqual(PriceListListQuery.parse({}), { limit: 50 })
    assert.deepEqual(PriceListListQuery.parse({ projectId: OTHER, validOn: "2026-06-01", isDefault: "true" }), { limit: 50, projectId: OTHER, validOn: "2026-06-01", isDefault: true })
    assert.equal(PriceListListQuery.parse({ isDefault: "false" }).isDefault, false)
    for (const wrong of ["yes", "TRUE", "1", ""]) assert.deepEqual(refusal(PriceListListQuery.safeParse({ isDefault: wrong })).map((issue) => issue.path), ["isDefault"], wrong)
    assert.equal(PriceListListQuery.safeParse({ validOn: "2026-06-01T00:00:00Z" }).success, false)
  })

  test("PriceListRowListQuery pages one list's rows by product and day: the path says the list", () => {
    assert.deepEqual(PriceListRowListQuery.parse({}), { limit: 50 })
    assert.deepEqual(PriceListRowListQuery.parse({ productId: OTHER, validOn: "2026-06-01", limit: "20" }), { limit: 20, productId: OTHER, validOn: "2026-06-01" })
    assert.equal("projectId" in PriceListRowListQuery.shape, false, "a list's rows are the list's, not a project's")
  })
})
