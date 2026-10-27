import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { businessAgreementOf, feePayingAgreement, householdPropertyOf, identifyVisit, isCounted, likelyTrades, normaliseCredentialValue, ruleOn, visitCharge, type CredentialFacts, type VisitFacts, type VisitRuleFacts } from "../charges"

const PARKVEJ = "property-parkvej"
const GARDEN = "fraction-garden"
const MIXED = "fraction-mixed"
const AGREEMENT = "agreement-parkvej"

const household = (id: string, values: Partial<VisitFacts> = {}): VisitFacts => ({
  id,
  occurredAt: "2027-03-04T09:00:00.000Z",
  serviceDate: "2027-03-04",
  fractionIds: [MIXED],
  holder: { kind: "household", propertyId: PARKVEJ, agreementId: AGREEMENT },
  ...values,
})
const business = (id: string): VisitFacts => ({ ...household(id), holder: { kind: "business", customerId: "customer-byg", agreementId: "agreement-byg" } })
const rule = (values: Partial<VisitRuleFacts> = {}): VisitRuleFacts => ({
  id: "rule-2027",
  validFrom: "2027-01-01",
  validTo: null,
  freeVisits: 1,
  ladder: ["visit-70", "visit-620"],
  freeFractionIds: [GARDEN],
  businessVisitProductId: "visit-business",
  annualAccessProductId: "annual-access",
  tradeThreshold: 3,
  tradeWindowDays: 30,
  ...values,
})
const credential = (values: Partial<CredentialFacts> = {}): CredentialFacts => ({ id: "credential-ab12345", blocked: false, holder: { kind: "household", propertyId: PARKVEJ }, ...values })

describe("identifyVisit", () => {
  test("a plate or a card with no credential in force is unknown, whom it reached nobody", () => {
    assert.deepEqual(identifyVisit({ by: "plate", credential: null }, null), { outcome: "refused", refusalReason: "unknown-identifier", credentialId: null, holder: null })
    assert.equal(identifyVisit({ by: "card", credential: null }, AGREEMENT).refusalReason, "unknown-identifier")
  })

  test("a business's credential is admitted under the Agreement it names while that Agreement pays", () => {
    const holder = { kind: "business", customerId: "customer-byg", agreementId: "agreement-byg" } as const
    assert.deepEqual(identifyVisit({ by: "plate", credential: credential({ holder }) }, "agreement-byg"), { outcome: "admitted", refusalReason: null, credentialId: "credential-ab12345", holder })
    assert.equal(businessAgreementOf({ by: "plate", credential: credential({ holder }) }), "agreement-byg")
    assert.equal(businessAgreementOf({ by: "plate", credential: credential() }), null)
  })

  test("a household is admitted under its fee-paying Agreement, and refused not-fee-paying without one", () => {
    assert.deepEqual(identifyVisit({ by: "plate", credential: credential() }, AGREEMENT).holder, { kind: "household", propertyId: PARKVEJ, agreementId: AGREEMENT })
    assert.equal(identifyVisit({ by: "plate", credential: credential() }, null).refusalReason, "not-fee-paying")
    assert.equal(identifyVisit({ by: "property", propertyId: PARKVEJ }, AGREEMENT).outcome, "admitted")
    assert.deepEqual(identifyVisit({ by: "property", propertyId: PARKVEJ }, null), { outcome: "refused", refusalReason: "not-fee-paying", credentialId: null, holder: { kind: "household", propertyId: PARKVEJ, agreementId: null } })
  })

  test("a household that no longer pays is not-fee-paying before its blocked credential is asked about, in the design's order", () => {
    assert.equal(identifyVisit({ by: "card", credential: credential({ blocked: true }) }, null).refusalReason, "not-fee-paying")
    const blocked = identifyVisit({ by: "card", credential: credential({ blocked: true }) }, AGREEMENT)
    assert.equal(blocked.refusalReason, "credential-blocked")
    assert.equal(blocked.credentialId, "credential-ab12345")
  })

  test("a business's credential whose Agreement no longer pays — cancelled, or out of force on the day — is not-fee-paying, its customer and agreement recorded", () => {
    const holder = { kind: "business", customerId: "customer-byg", agreementId: "agreement-byg" } as const
    assert.deepEqual(identifyVisit({ by: "plate", credential: credential({ holder }) }, null), { outcome: "refused", refusalReason: "not-fee-paying", credentialId: "credential-ab12345", holder })
    assert.equal(identifyVisit({ by: "plate", credential: credential({ holder, blocked: true }) }, null).refusalReason, "not-fee-paying")
    assert.equal(identifyVisit({ by: "plate", credential: credential({ holder, blocked: true }) }, "agreement-byg").refusalReason, "credential-blocked")
  })

  test("the household asked of is the address's Property or the credential's, never a business's", () => {
    assert.equal(householdPropertyOf({ by: "property", propertyId: PARKVEJ }), PARKVEJ)
    assert.equal(householdPropertyOf({ by: "plate", credential: credential() }), PARKVEJ)
    assert.equal(householdPropertyOf({ by: "plate", credential: credential({ holder: { kind: "business", customerId: "c", agreementId: "a" } }) }), null)
    assert.equal(householdPropertyOf({ by: "plate", credential: null }), null)
  })
})

describe("feePayingAgreement", () => {
  test("the lowest id of the signed Agreements, none of a draft or a cancelled one", () => {
    assert.equal(feePayingAgreement([]), null)
    assert.equal(feePayingAgreement([{ agreementId: "b", status: "active" }, { agreementId: "a", status: "draft" }, { agreementId: "c", status: "active" }]), "b")
    assert.equal(feePayingAgreement([{ agreementId: "a", status: "cancelled" }]), null)
  })
})

describe("visitCharge for a household", () => {
  test("no rule in force charges nothing, and counts nothing", () => {
    assert.deepEqual(visitCharge(household("v1"), null, []), { ruleId: null, basis: "no-rule", counted: false, n: null, productId: null })
  })

  test("1st free, then 70, then 620, repeating: one free visit and two steps", () => {
    const visits = ["v1", "v2", "v3", "v4"].map((id, index) => household(id, { occurredAt: `2027-0${index + 3}-01T09:00:00.000Z`, serviceDate: `2027-0${index + 3}-01` }))
    const charged = visits.map((visit) => visitCharge(visit, rule(), visits))
    assert.deepEqual(
      charged.map((charge) => [charge.basis, charge.n, charge.productId]),
      [
        ["free-quota", 1, null],
        ["ladder", 2, "visit-70"],
        ["ladder", 3, "visit-620"],
        ["ladder", 4, "visit-620"],
      ],
    )
  })

  test("a visit of free fractions alone is neither counted nor charged, and does not step a later one", () => {
    const garden = household("v1", { fractionIds: [GARDEN], occurredAt: "2027-03-01T09:00:00.000Z" })
    assert.deepEqual(visitCharge(garden, rule(), []), { ruleId: "rule-2027", basis: "free-fractions", counted: false, n: null, productId: null })
    assert.equal(visitCharge(household("v2"), rule(), [garden]).n, 1)
    assert.equal(isCounted({ fractionIds: [GARDEN, MIXED] }, rule()), true, "a free fraction beside another is counted")
  })

  test("a visit with no fractions recorded, a gate's read, counts", () => {
    assert.equal(visitCharge(household("v1", { fractionIds: [] }), rule(), []).counted, true)
  })

  test("the count is the Property's in the calendar year, by instant and then id", () => {
    const lastYear = household("v0", { serviceDate: "2026-12-30", occurredAt: "2026-12-30T09:00:00.000Z" })
    const elsewhere = household("v1", { holder: { kind: "household", propertyId: "property-other", agreementId: "x" }, occurredAt: "2027-01-01T09:00:00.000Z" })
    const sameInstant = household("va")
    const visit = household("vb")
    assert.equal(visitCharge(visit, rule(), [lastYear, elsewhere, sameInstant]).n, 2)
    assert.equal(visitCharge(sameInstant, rule(), [visit]).n, 1, "the lower id first at one instant")
  })

  test("an empty ladder includes every visit", () => {
    assert.equal(visitCharge(household("v2"), rule({ freeVisits: 0, ladder: [] }), []).productId, null)
  })
})

describe("visitCharge for a business", () => {
  test("included under the annual-access product, else the per-visit product; free fractions are a household's rule", () => {
    assert.equal(visitCharge(business("v1"), rule(), [], true).basis, "annual-access")
    assert.equal(visitCharge(business("v1"), rule(), [], true).productId, null)
    const perVisit = visitCharge({ ...business("v1"), fractionIds: [GARDEN] }, rule(), [])
    assert.deepEqual([perVisit.basis, perVisit.productId], ["per-visit", "visit-business"])
    assert.equal(visitCharge(business("v1"), rule({ annualAccessProductId: null }), [], true).basis, "per-visit", "no annual product, no annual access")
  })
})

describe("ruleOn", () => {
  test("the rule in force on the day, half-open", () => {
    const old = rule({ id: "rule-2026", validFrom: "2026-01-01", validTo: "2027-01-01" })
    assert.equal(ruleOn([old, rule()], "2026-12-31")?.id, "rule-2026")
    assert.equal(ruleOn([old, rule()], "2027-01-01")?.id, "rule-2027")
    assert.equal(ruleOn([old], "2025-12-31"), null)
  })
})

describe("likelyTrades", () => {
  test("the Properties with the threshold of counted visits in the window, most first", () => {
    const at = (id: string, day: string, propertyId = PARKVEJ, fractionIds = [MIXED]) => household(id, { serviceDate: day, fractionIds, holder: { kind: "household", propertyId, agreementId: AGREEMENT } })
    const visits = [at("1", "2027-03-01"), at("2", "2027-03-10"), at("3", "2027-03-30"), at("4", "2027-01-31"), at("5", "2027-03-02", "other"), at("6", "2027-03-03", "other"), at("7", "2027-03-04", "other", [GARDEN]), at("8", "2027-03-31", "other")]
    assert.deepEqual(likelyTrades(visits, rule(), "2027-03-30"), [{ propertyId: PARKVEJ, visits: 3 }])
    assert.deepEqual(likelyTrades(visits, rule({ tradeThreshold: 2 }), "2027-03-31"), [
      { propertyId: "other", visits: 3 },
      { propertyId: PARKVEJ, visits: 2 },
    ])
    assert.deepEqual(likelyTrades(visits, rule({ tradeThreshold: null, tradeWindowDays: null }), "2027-03-30"), [])
  })
})

describe("normaliseCredentialValue", () => {
  test("upper case, no spaces and no hyphens: one plate is one value however it is written", () => {
    assert.equal(normaliseCredentialValue(" ab 12 345 "), "AB12345")
    assert.equal(normaliseCredentialValue("AB-12 345"), "AB12345")
  })
})
