// Recycling-centre visits' words and bodies on the web (#393, M4 of #293):
// what the attendant's answer card says, the check-in's body, held against
// the contract's zod schema, the site a device remembers, a credential's
// status on a day, and a Visit Rule's form as the bodies the API takes —
// the ladder and the free fractions whole, the end as the first day out.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { SiteVisitCheckIn } from "@waste/contracts/site-visits"
import { VisitRuleCreate, VisitRulePatch, type VisitRule } from "@waste/contracts/visit-rules"

import { BLOCK_REASON_LABELS } from "../commercial"
import {
  answerHeadline,
  chargeSentence,
  checkInBodyOf,
  credentialStatusOf,
  householdSentence,
  isVisitRuleRefusal,
  newVisitRuleForm,
  NO_PRODUCT,
  ordinal,
  rememberedSite,
  toggled,
  tradeSentence,
  visitRuleCreateBodyOf,
  visitRuleFormOf,
  visitRulePatchBodyOf,
  type CheckInDraft,
} from "../site-visits"

const id = (n: number) => `01a0d2a4-a280-7061-8000-0000000000${String(n).padStart(2, "0")}`

describe("the answer card", () => {
  test("says the visit's place in its year and its price: '3rd visit this year: 70,00 kr'", () => {
    assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal), ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st", "111th"])
    const price = { unitPriceMinor: 5600, netMinor: 5600, vatPercent: 25, vatMinor: 1400, currency: "DKK" }
    assert.match(chargeSentence({ basis: "ladder", n: 3, productId: id(1), price, blockReason: null }, BLOCK_REASON_LABELS), /^3rd visit this year: .*70[.,]00/)
    assert.equal(chargeSentence({ basis: "free-quota", n: 1, productId: null, price: null, blockReason: null }, BLOCK_REASON_LABELS), "1st visit this year: included")
    assert.equal(chargeSentence({ basis: "free-fractions", n: null, productId: null, price: null, blockReason: null }, BLOCK_REASON_LABELS), "Free fractions only: not counted, charged nothing")
    assert.equal(chargeSentence({ basis: "no-rule", n: null, productId: null, price: null, blockReason: null }, BLOCK_REASON_LABELS), "No Visit Rule in force: logged, charged nothing")
    assert.equal(chargeSentence({ basis: "annual-access", n: null, productId: null, price: null, blockReason: null }, BLOCK_REASON_LABELS), "Business with annual access: included")
    assert.equal(chargeSentence({ basis: "per-visit", n: null, productId: id(1), price: null, blockReason: "no-price-row" }, BLOCK_REASON_LABELS), "Business visit: price not set yet (no price row)")
  })

  test("says a refused visitor is turned away, and why", () => {
    const visit = { outcome: "refused" as const, refusalReason: "credential-blocked" as const }
    const headline = answerHeadline({ visit: visit as never })
    assert.deepEqual([headline.tone, headline.title], ["refused", "Turned away: blocked"])
    assert.ok(headline.detail?.includes("blocked"))
    assert.deepEqual(answerHeadline({ visit: { outcome: "admitted", refusalReason: null } as never }), { tone: "admitted", title: "Admitted", detail: null })
  })
})

describe("the check-in's body", () => {
  const draft: CheckInDraft = { siteId: id(1), mode: "plate", value: "ab-12 345", propertyId: "", wasteFractionIds: [id(2)], note: "  " }

  test("a plate or a card normalised, a Property by its address, each the contract takes", () => {
    const byPlate = checkInBodyOf(draft)
    assert.deepEqual(byPlate, { siteId: id(1), identifier: { kind: "plate", value: "AB12345" }, wasteFractionIds: [id(2)] })
    assert.ok(SiteVisitCheckIn.safeParse(byPlate).success)
    const byAddress = checkInBodyOf({ ...draft, mode: "address", value: "", propertyId: id(3), note: "Trailer" })
    assert.deepEqual(byAddress, { siteId: id(1), identifier: { kind: "property", propertyId: id(3) }, wasteFractionIds: [id(2)], note: "Trailer" })
    assert.ok(SiteVisitCheckIn.safeParse(byAddress).success)
  })

  test("holds back a check-in with no site, no number or no address picked", () => {
    assert.equal(checkInBodyOf({ ...draft, siteId: "" }), "Pick the recycling centre you are at")
    assert.equal(checkInBodyOf({ ...draft, value: " - " }), "Type the plate")
    assert.equal(checkInBodyOf({ ...draft, mode: "card", value: "" }), "Type the card number")
    assert.equal(checkInBodyOf({ ...draft, mode: "address" }), "Find the visitor's address and pick it")
  })

  test("the device's remembered site while the project offers it, else the only one, else none; a chip toggles", () => {
    const sites = [{ id: id(1) }, { id: id(2) }]
    assert.equal(rememberedSite(sites, id(2)), id(2))
    assert.equal(rememberedSite(sites, id(9)), "")
    assert.equal(rememberedSite([{ id: id(1) }], null), id(1))
    assert.deepEqual(toggled([id(1)], id(2)), [id(1), id(2)])
    assert.deepEqual(toggled([id(1), id(2)], id(1)), [id(2)])
  })
})

describe("a credential's status", () => {
  test("blocked first, then ended on its first day out, upcoming before its start, else in force", () => {
    const credential = { blockedAt: null, validFrom: "2027-01-01", validTo: "2027-07-01" }
    assert.equal(credentialStatusOf(credential, "2027-03-04"), "In force")
    assert.equal(credentialStatusOf(credential, "2027-07-01"), "Ended")
    assert.equal(credentialStatusOf(credential, "2026-12-31"), "Upcoming")
    assert.equal(credentialStatusOf({ ...credential, blockedAt: "2027-02-01T00:00:00.000Z" }, "2027-03-04"), "Blocked")
  })
})

describe("a Visit Rule's form", () => {
  const rule: VisitRule = {
    id: id(10),
    createdAt: "2027-01-01T00:00:00.000Z",
    updatedAt: "2027-01-01T00:00:00.000Z",
    projectId: id(11),
    freeVisits: 1,
    ladder: [id(12), id(13)],
    freeFractionIds: [id(14)],
    businessVisitProductId: id(15),
    annualAccessProductId: null,
    tradeThreshold: 8,
    tradeWindowDays: 30,
    validFrom: "2027-01-01",
    validTo: null,
  }

  test("a new rule is the create the contract takes, the end as the first day out", () => {
    const form = { ...newVisitRuleForm("2027-03-04"), freeVisits: "2", ladder: [id(12)], freeFractionIds: [id(14)], businessVisitProductId: id(15), tradeThreshold: "8", tradeWindowDays: "30", lastDay: "2027-12-31" }
    const body = visitRuleCreateBodyOf(id(11), form)
    assert.deepEqual(body, {
      projectId: id(11),
      validFrom: "2027-03-04",
      freeVisits: 2,
      ladder: [id(12)],
      freeFractionIds: [id(14)],
      businessVisitProductId: id(15),
      annualAccessProductId: null,
      tradeThreshold: 8,
      tradeWindowDays: 30,
      validTo: "2028-01-01",
    })
    assert.ok(VisitRuleCreate.safeParse(body).success)
    const bare = visitRuleCreateBodyOf(id(11), newVisitRuleForm("2027-03-04"))
    assert.ok(VisitRuleCreate.safeParse(bare).success, "no step, no product, no threshold: every visit logged and included")
  })

  test("refuses at its field: a step with no product, a threshold without its window, a count out of range, an end before the start", () => {
    const form = newVisitRuleForm("2027-03-04")
    const at = (values: Partial<typeof form>) => {
      const body = visitRuleCreateBodyOf(id(11), { ...form, ...values })
      return isVisitRuleRefusal(body) ? body.field : null
    }
    assert.equal(at({ ladder: [NO_PRODUCT] }), "ladder")
    assert.equal(at({ tradeThreshold: "8" }), "tradeWindowDays")
    assert.equal(at({ freeVisits: "400" }), "freeVisits")
    assert.equal(at({ freeVisits: "1.5" }), "freeVisits")
    assert.equal(at({ lastDay: "2027-03-01" }), "lastDay")
  })

  test("an edit sends what moved, the ladder in its order and the free fractions whole; nothing moved is no patch", () => {
    const form = visitRuleFormOf(rule)
    assert.equal(visitRulePatchBodyOf(rule, form), null)
    assert.equal(visitRulePatchBodyOf(rule, { ...form, freeFractionIds: [id(14)] }), null, "the same set")
    const reordered = visitRulePatchBodyOf(rule, { ...form, ladder: [id(13), id(12)], tradeThreshold: "", tradeWindowDays: "", lastDay: "2027-06-30" })
    assert.deepEqual(reordered, { ladder: [id(13), id(12)], tradeThreshold: null, tradeWindowDays: null, validTo: "2027-07-01" })
    assert.ok(VisitRulePatch.safeParse(reordered).success)
    assert.deepEqual(visitRulePatchBodyOf(rule, { ...form, businessVisitProductId: NO_PRODUCT }), { businessVisitProductId: null })
  })

  test("reads a household's year and the likely-trade threshold in words", () => {
    const name = (productId: string) => (productId === id(12) ? "Visit 70" : "Visit 620")
    assert.equal(householdSentence(rule, name), "1 free visit a year, then Visit 70, then Visit 620 for every visit after")
    assert.equal(householdSentence({ freeVisits: 0, ladder: [] }, name), "Every visit included")
    assert.equal(householdSentence({ freeVisits: 2, ladder: [id(12)] }, name), "2 free visits a year, then Visit 70 for each visit after")
    assert.equal(tradeSentence(rule), "8 visits in 30 days")
    assert.equal(tradeSentence({ tradeThreshold: null, tradeWindowDays: null }), "Not flagged")
  })
})
