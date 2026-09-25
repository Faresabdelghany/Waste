import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { AGREEMENT_STATUSES, BILLING_CADENCES } from "@waste/domain/registry/vocabulary"

import {
  Agreement,
  AgreementCreate,
  AgreementListQuery,
  AgreementPatch,
  AgreementStatus,
  BillingCadence,
  Subscription,
  SubscriptionCreate,
  SubscriptionListQuery,
  SubscriptionPatch,
} from "../agreements"
import { refusal, refusesAnEmptyPatch, refusesWhatTheServerOwns } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const THIRD = "01a0d3a5-e5e0-7000-8000-000000000003"
const STAMPS = { createdAt: "2026-09-24T13:41:00.000Z", updatedAt: "2026-09-24T13:41:00.000Z" }
const BACKWARDS = "validTo is the first day out of force, so it comes after validFrom"

const agreement = {
  id: ID,
  projectId: OTHER,
  number: "AGR-2408",
  customerId: THIRD,
  payerCustomerId: THIRD,
  status: "active",
  billingCadence: "quarterly",
  currency: "DKK",
  notes: "Signed at the housing association's annual meeting.",
  priceListId: null,
  validFrom: "2026-01-01",
  validTo: null,
  ...STAMPS,
}

const subscription = {
  id: ID,
  projectId: OTHER,
  agreementId: THIRD,
  productId: THIRD,
  propertyId: THIRD,
  sharedCollectionPointId: null,
  quantity: 2,
  validFrom: "2026-01-01",
  validTo: "2027-01-01",
  ...STAMPS,
}

describe("the agreement enums", () => {
  test("are the vocabulary the database checks against, value for value and in the same order", () => {
    assert.deepEqual(AgreementStatus.options, [...AGREEMENT_STATUSES])
    assert.deepEqual(BillingCadence.options, [...BILLING_CADENCES])
    assert.equal(AgreementStatus.safeParse("expired").success, false, "expiry is a reading of the period, never a status")
    assert.equal(BillingCadence.safeParse("weekly").success, false)
  })
})

describe("Agreement", () => {
  test("is the row on the wire, with the period it is in force for and no status that repeats it", () => {
    assert.deepEqual(Agreement.parse(agreement), agreement)
    const ended = { ...agreement, status: "cancelled", notes: null, validTo: "2026-07-01" }
    assert.deepEqual(Agreement.parse(ended), ended)
  })

  test("refuses a period that runs backwards, at the field that is wrong", () => {
    assert.deepEqual(refusal(Agreement.safeParse({ ...agreement, validTo: "2025-12-31" })), [{ path: "validTo", message: BACKWARDS }])
    assert.deepEqual(refusal(Agreement.safeParse({ ...agreement, validTo: "2026-01-01" })), [{ path: "validTo", message: BACKWARDS }])
  })

  test("takes the currency as ISO 4217, the same shape the project's takes", () => {
    assert.equal(Agreement.safeParse({ ...agreement, currency: "dkk" }).success, false)
    assert.equal(Agreement.safeParse({ ...agreement, currency: "kroner" }).success, false)
  })

  test("names the price list it is priced under, or null for the project's default (Issue #112)", () => {
    const listed = { ...agreement, priceListId: OTHER }
    assert.deepEqual(Agreement.parse(listed), listed)
    assert.deepEqual(refusal(Agreement.safeParse({ ...agreement, priceListId: "pl-cph-2026" })).map((issue) => issue.path), ["priceListId"], "an id, not the list's code")
  })
})

describe("AgreementCreate and AgreementPatch", () => {
  const body = {
    projectId: OTHER,
    number: "AGR-2408",
    customerId: THIRD,
    payerCustomerId: THIRD,
    billingCadence: "quarterly",
    currency: "DKK",
    validFrom: "2026-01-01",
  }

  test("default the status to draft, read an absent end as open ended, and say so in the schema", () => {
    assert.deepEqual(AgreementCreate.parse(body), { ...body, status: "draft" })
    assert.deepEqual(AgreementCreate.parse({ ...body, validTo: null }), { ...body, status: "draft", validTo: null })
    assert.match(AgreementCreate.shape.status.description ?? "", /draft/)
  })

  test("need the project, the number, both customers, the cadence, the currency and a first day, and mint nothing", () => {
    for (const key of Object.keys(body)) {
      const without: Record<string, unknown> = { ...body }
      delete without[key]
      assert.deepEqual(refusal(AgreementCreate.safeParse(without)).map((issue) => issue.path), [key])
    }
    refusesWhatTheServerOwns(AgreementCreate, body)
  })

  test("refuse a period that runs backwards on the way in", () => {
    assert.deepEqual(refusal(AgreementCreate.safeParse({ ...body, validTo: "2026-01-01" })), [{ path: "validTo", message: BACKWARDS }])
  })

  test("move the end, reopen it with null, and refuse an empty patch or the project", () => {
    assert.deepEqual(AgreementPatch.parse({ validTo: "2027-01-01" }), { validTo: "2027-01-01" })
    assert.deepEqual(AgreementPatch.parse({ validTo: null }), { validTo: null })
    assert.deepEqual(AgreementPatch.parse({ status: "cancelled", notes: null }), { status: "cancelled", notes: null })
    refusesAnEmptyPatch(AgreementPatch)
    assert.match(refusal(AgreementPatch.safeParse({ number: "AGR-1", projectId: OTHER }))[0].message, /projectId/)
  })

  test("hold the two days against each other when a patch gives both, and leave the stored row to the route", () => {
    assert.deepEqual(refusal(AgreementPatch.safeParse({ validFrom: "2026-02-01", validTo: "2026-01-01" })), [{ path: "validTo", message: BACKWARDS }])
    assert.deepEqual(AgreementPatch.parse({ validTo: "2020-01-01" }), { validTo: "2020-01-01" })
  })

  test("take the price list on the way in and on a patch, and clear it with null for the project's default (Issue #112)", () => {
    assert.deepEqual(AgreementCreate.parse({ ...body, priceListId: OTHER }), { ...body, status: "draft", priceListId: OTHER })
    assert.deepEqual(AgreementCreate.parse({ ...body, priceListId: null }), { ...body, status: "draft", priceListId: null })
    assert.deepEqual(AgreementPatch.parse({ priceListId: OTHER }), { priceListId: OTHER })
    assert.deepEqual(AgreementPatch.parse({ priceListId: null }), { priceListId: null })
    assert.deepEqual(refusal(AgreementPatch.safeParse({ priceListId: "default" })).map((issue) => issue.path), ["priceListId"])
  })
})

describe("Subscription", () => {
  test("is one product at one place under one agreement, the other place null", () => {
    assert.deepEqual(Subscription.parse(subscription), subscription)
    const atAPoint = { ...subscription, propertyId: null, sharedCollectionPointId: THIRD }
    assert.deepEqual(Subscription.parse(atAPoint), atAPoint)
  })

  test("carries no locationId: the generated column is the database's device for its exclusion constraint", () => {
    assert.deepEqual(Object.keys(Subscription.shape).includes("locationId"), false)
  })

  test("takes a whole positive quantity and a period that runs forwards", () => {
    for (const quantity of [0, -1, 1.5]) assert.equal(Subscription.safeParse({ ...subscription, quantity }).success, false, JSON.stringify(quantity))
    assert.deepEqual(refusal(Subscription.safeParse({ ...subscription, validTo: "2025-01-01" })), [{ path: "validTo", message: BACKWARDS }])
  })
})

describe("SubscriptionCreate", () => {
  const body = { productId: THIRD, propertyId: THIRD, validFrom: "2026-01-01" }

  test("defaults the quantity to one and takes neither the agreement nor the project: the path carries one and the agreement the other", () => {
    assert.deepEqual(SubscriptionCreate.parse(body), { ...body, quantity: 1 })
    assert.match(refusal(SubscriptionCreate.safeParse({ ...body, agreementId: THIRD }))[0].message, /agreementId/)
    assert.match(refusal(SubscriptionCreate.safeParse({ ...body, projectId: OTHER }))[0].message, /projectId/)
  })

  test("needs exactly one place: neither is not a subscription, and both is two", () => {
    const onePlace = { path: "", message: "Give exactly one of propertyId and sharedCollectionPointId: a subscription is delivered at one place" }
    const neither = { productId: THIRD, validFrom: "2026-01-01" }
    assert.deepEqual(refusal(SubscriptionCreate.safeParse(neither)), [onePlace])
    assert.deepEqual(refusal(SubscriptionCreate.safeParse({ ...body, sharedCollectionPointId: OTHER })), [onePlace])
    assert.equal(SubscriptionCreate.safeParse({ productId: THIRD, sharedCollectionPointId: OTHER, validFrom: "2026-01-01" }).success, true)
  })

  test("takes the other place as null, which is what a form with both fields sends", () => {
    const atAProperty = { productId: THIRD, propertyId: THIRD, sharedCollectionPointId: null, validFrom: "2026-01-01" }
    assert.deepEqual(SubscriptionCreate.parse(atAProperty), { ...atAProperty, quantity: 1 })
    const atAPoint = { productId: THIRD, propertyId: null, sharedCollectionPointId: OTHER, validFrom: "2026-01-01" }
    assert.deepEqual(SubscriptionCreate.parse(atAPoint), { ...atAPoint, quantity: 1 })
    const onePlace = { path: "", message: "Give exactly one of propertyId and sharedCollectionPointId: a subscription is delivered at one place" }
    assert.deepEqual(refusal(SubscriptionCreate.safeParse({ ...atAProperty, propertyId: null })), [onePlace], "null and null is neither")
    assert.deepEqual(refusal(SubscriptionCreate.safeParse({ ...atAProperty, sharedCollectionPointId: OTHER })), [onePlace], "an id and an id is two")
  })

  test("needs a product and a first day, refuses a backwards period, and mints nothing", () => {
    for (const key of ["productId", "validFrom"]) {
      const without: Record<string, unknown> = { ...body }
      delete without[key]
      assert.deepEqual(refusal(SubscriptionCreate.safeParse(without)).map((issue) => issue.path), [key])
    }
    assert.deepEqual(refusal(SubscriptionCreate.safeParse({ ...body, validTo: "2026-01-01" })), [{ path: "validTo", message: BACKWARDS }])
    refusesWhatTheServerOwns(SubscriptionCreate, body)
  })
})

describe("SubscriptionPatch", () => {
  test("changes the quantity and the period, and nothing else: end a subscription and write a new one to move it", () => {
    assert.deepEqual(SubscriptionPatch.parse({ quantity: 3 }), { quantity: 3 })
    assert.deepEqual(SubscriptionPatch.parse({ validTo: "2027-01-01" }), { validTo: "2027-01-01" })
    refusesAnEmptyPatch(SubscriptionPatch)
    for (const key of ["productId", "propertyId", "sharedCollectionPointId", "agreementId"]) {
      assert.match(refusal(SubscriptionPatch.safeParse({ quantity: 1, [key]: THIRD }))[0].message, new RegExp(key))
    }
    assert.deepEqual(refusal(SubscriptionPatch.safeParse({ validFrom: "2026-02-01", validTo: "2026-02-01" })), [{ path: "validTo", message: BACKWARDS }])
  })
})

describe("AgreementListQuery and SubscriptionListQuery", () => {
  test("take a page, the project, the customer, the number and the day to read the period against", () => {
    assert.deepEqual(AgreementListQuery.parse({}), { limit: 50 })
    assert.deepEqual(AgreementListQuery.parse({ projectId: OTHER, customerId: THIRD, number: "AGR-2408", validOn: "2026-06-01", limit: "10" }), {
      projectId: OTHER,
      customerId: THIRD,
      number: "AGR-2408",
      validOn: "2026-06-01",
      limit: 10,
    })
    assert.equal(AgreementListQuery.safeParse({ validOn: "2026-06-01T00:00:00Z" }).success, false)
    assert.equal(AgreementListQuery.safeParse({ limit: "0" }).success, false)
  })

  test("ask a subscription list only for the day: the agreement in the path says the rest", () => {
    assert.deepEqual(SubscriptionListQuery.parse({ validOn: "2026-06-01" }), { validOn: "2026-06-01", limit: 50 })
    assert.equal(SubscriptionListQuery.safeParse({ projectId: OTHER }).success, true, "an unknown parameter is dropped, not refused: a query string is not a body")
  })
})
