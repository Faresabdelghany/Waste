import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { AccessCredentialCreate, CREDENTIAL_VALUE_SHAPE, ONE_HOLDER, SiteVisitCheckIn, SiteVisitListQuery } from "../site-visits"
import { TRADE_TOGETHER, VisitRuleCreate, VisitRulePatch } from "../visit-rules"

const ID = "01a0d2a4-a280-7001-8000-000000000001"
const OTHER = "01a0d2a4-a280-7001-8000-000000000002"

const messages = (result: { success: boolean; error?: { issues: { message: string }[] } }) => result.error?.issues.map((issue) => issue.message) ?? []

describe("AccessCredentialCreate", () => {
  test("a business's credential names its customer and agreement, a household's its Property, exactly one", () => {
    const base = { projectId: ID, kind: "plate", value: "ab 12 345", validFrom: "2027-01-01" }
    assert.equal(AccessCredentialCreate.safeParse({ ...base, customerId: ID, agreementId: OTHER }).success, true)
    assert.equal(AccessCredentialCreate.safeParse({ ...base, propertyId: ID }).success, true)
    for (const holder of [{}, { customerId: ID }, { propertyId: ID, customerId: ID, agreementId: OTHER }]) assert.deepEqual(messages(AccessCredentialCreate.safeParse({ ...base, ...holder })), [ONE_HOLDER])
  })

  test("a value normalises to letters, digits and hyphens", () => {
    assert.deepEqual(messages(AccessCredentialCreate.safeParse({ projectId: ID, kind: "card", value: "ab/12", validFrom: "2027-01-01", propertyId: ID })), [CREDENTIAL_VALUE_SHAPE])
    assert.deepEqual(messages(AccessCredentialCreate.safeParse({ projectId: ID, kind: "card", value: "   ", validFrom: "2027-01-01", propertyId: ID })), [CREDENTIAL_VALUE_SHAPE])
  })
})

describe("SiteVisitCheckIn", () => {
  test("a plate, a card or a Property, the fractions each once, the instant optional", () => {
    assert.equal(SiteVisitCheckIn.safeParse({ siteId: ID, identifier: { kind: "plate", value: "AB12345" } }).success, true)
    assert.equal(SiteVisitCheckIn.safeParse({ siteId: ID, identifier: { kind: "property", propertyId: ID }, wasteFractionIds: [ID, OTHER] }).success, true)
    assert.equal(SiteVisitCheckIn.safeParse({ siteId: ID, identifier: { kind: "property", value: "AB12345" } }).success, false)
    assert.equal(SiteVisitCheckIn.safeParse({ siteId: ID, identifier: { kind: "card", value: "1" }, wasteFractionIds: [ID, ID] }).success, false)
    assert.equal(SiteVisitCheckIn.safeParse({ siteId: ID, identifier: { kind: "card", value: "1" }, recordedBy: ID }).success, false, "the person is the server's")
  })

  test("a list's window ends on or after it starts", () => {
    assert.equal(SiteVisitListQuery.safeParse({ from: "2027-03-04", to: "2027-03-03" }).success, false)
  })
})

describe("VisitRuleCreate", () => {
  test("a threshold and a window together, or neither; the ladder may be empty", () => {
    assert.equal(VisitRuleCreate.safeParse({ projectId: ID, validFrom: "2027-01-01" }).success, true)
    assert.deepEqual(messages(VisitRuleCreate.safeParse({ projectId: ID, validFrom: "2027-01-01", tradeThreshold: 12 })), [TRADE_TOGETHER])
    assert.equal(VisitRuleCreate.safeParse({ projectId: ID, validFrom: "2027-01-01", freeVisits: 1, ladder: [ID, OTHER], tradeThreshold: 12, tradeWindowDays: 30 }).success, true)
    assert.equal(VisitRulePatch.safeParse({}).success, false)
    assert.equal(VisitRulePatch.safeParse({ projectId: ID }).success, false, "the project is the rule's")
  })
})
