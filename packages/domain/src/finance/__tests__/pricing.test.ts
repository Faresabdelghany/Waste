// resolvePrice is RESOLUTION_RULE run as code over the rows of one list on
// one day: the row matching the most conditions wins, a negotiated row for
// the customer always wins, a tie goes to the later start and then to the
// lower id — every tie decided, which the prototype left to array order. The
// web's price-resolution.test.ts cases are ported here so the two resolvers
// agree until #81 retires the web's; the ones it lacked follow, and every
// losing sentence is pinned. priceOccurrence beside it is the whole pricing of
// one occurrence, answering the one block reason in the order reprice mends
// them.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { CONDITION_NAMES, PRICE_CONDITIONS, priceListIdFor, priceOccurrence, RESOLUTION_RULE, resolvePrice, scoreOf, type PriceInput, type PriceRow } from "../pricing"

const HARBOR = "018f7c34-a000-7000-8000-000000000001"
const CENTRAL = "018f7c34-a000-7000-8000-000000000002"
const BIN_240 = "018f7c34-a000-7000-8000-000000000003"
const BIN_660 = "018f7c34-a000-7000-8000-000000000004"
const RESIDUAL = "018f7c34-a000-7000-8000-000000000005"
const GLASS = "018f7c34-a000-7000-8000-000000000006"
const COWORK = "018f7c34-a000-7000-8000-000000000007"
const OTHER_CUSTOMER = "018f7c34-a000-7000-8000-000000000008"

/** A row of the list, but for what a test overrides: the default row, no conditions, from the start of 2026, ten kroner. */
const row = (id: string, values: Partial<PriceRow> = {}): PriceRow => ({
  id,
  unitPriceMinor: 1_000,
  planningAreaId: null,
  customerKind: null,
  containerTypeId: null,
  wasteFractionId: null,
  customerId: null,
  validFrom: "2026-01-01",
  validTo: null,
  ...values,
})

/** The prototype's input: a commercial customer in the harbour zone on 20 August 2026. */
const input: PriceInput = { on: "2026-08-20", planningAreaId: HARBOR, customerKind: "organisation", customerId: OTHER_CUSTOMER }

/** How the ids read in a sentence, as the route would hand them in. */
const labels = {
  planningAreaId: (id: string) => (id === HARBOR ? "Harbor" : "Central"),
  containerTypeId: (id: string) => (id === BIN_240 ? "240 L" : "660 L"),
  wasteFractionId: (id: string) => (id === RESIDUAL ? "Residual" : "Glass"),
  customerId: (id: string) => (id === COWORK ? "Nørrebro CoWork ApS" : "another customer"),
}

const winnerOf = (rows: PriceRow[], on: PriceInput = input) => resolvePrice(rows, on, labels).winner?.row.id

describe("resolvePrice follows RESOLUTION_RULE", () => {
  test("the sentence is the web's, verbatim", () => {
    assert.equal(RESOLUTION_RULE, "The row matching the most conditions wins. A negotiated row for the specific customer always wins. Remaining ties go to the row with the newest effective-from date.")
  })

  // The web's four cases, ported.
  test("the row matching the most conditions wins", () => {
    const rows = [row("everyone"), row("harbor", { planningAreaId: HARBOR, unitPriceMinor: 1_200 }), row("harbor-commercial", { planningAreaId: HARBOR, customerKind: "organisation", unitPriceMinor: 1_400 })]
    const resolution = resolvePrice(rows, input, labels)
    assert.equal(resolution.winner?.row.id, "harbor-commercial")
    assert.equal(resolution.winner?.row.unitPriceMinor, 1_400)
    assert.deepEqual(resolution.winner?.matched, ["Planning area Harbor", "Customer kind organisation"])
    assert.deepEqual(resolution.verdicts.map((verdict) => [verdict.row.id, verdict.score, verdict.winner]), [
      ["harbor-commercial", 2, true],
      ["harbor", 1, false],
      ["everyone", 0, false],
    ])
  })

  test("a negotiated row for the customer wins over any conditions, and is not eligible for anyone else", () => {
    const rows = [row("harbor-commercial", { planningAreaId: HARBOR, customerKind: "organisation", unitPriceMinor: 1_400 }), row("deal", { customerId: COWORK, unitPriceMinor: 900 })]
    const deal = resolvePrice(rows, { ...input, customerId: COWORK }, labels)
    assert.equal(deal.winner?.row.id, "deal")
    assert.equal(deal.winner?.score, 100)
    assert.deepEqual(deal.winner?.matched, ["Negotiated · Nørrebro CoWork ApS"])
    const other = resolvePrice(rows, input, labels)
    assert.equal(other.winner?.row.id, "harbor-commercial")
    assert.deepEqual(other.verdicts.find((verdict) => verdict.row.id === "deal"), {
      row: rows[1],
      eligible: false,
      reason: "Negotiated for Nørrebro CoWork ApS, not this customer",
      matched: [],
      score: -1,
      winner: false,
    })
    // A negotiated row with conditions scores them on top of the hundred, and is judged for the customer alone.
    const conditioned = row("deal-harbor", { customerId: COWORK, planningAreaId: HARBOR })
    assert.equal(scoreOf(conditioned), 101)
    assert.equal(winnerOf([rows[1], conditioned], { ...input, customerId: COWORK }), "deal-harbor")
    // An input without a customer meets no negotiated row.
    assert.equal(resolvePrice([rows[1]], { on: "2026-08-20" }).winner, null)
  })

  test("a tie goes to the row with the newest effective-from date", () => {
    const rows = [row("older", { planningAreaId: HARBOR, validFrom: "2026-01-01", unitPriceMinor: 1_200 }), row("newer", { planningAreaId: HARBOR, validFrom: "2026-03-01", unitPriceMinor: 1_300 })]
    assert.equal(winnerOf(rows), "newer")
    assert.equal(winnerOf([...rows].reverse()), "newer", "whatever order the rows came in")
  })

  test("a row outside its effective period does not compete, with the sentence saying which way", () => {
    const rows = [row("everyone"), row("expired", { planningAreaId: HARBOR, validTo: "2026-07-01", unitPriceMinor: 1_200 }), row("scheduled", { planningAreaId: HARBOR, validFrom: "2027-01-01", unitPriceMinor: 1_300 })]
    const resolution = resolvePrice(rows, input, labels)
    assert.equal(resolution.winner?.row.id, "everyone")
    assert.deepEqual(
      resolution.verdicts.map((verdict) => [verdict.row.id, verdict.reason]),
      [
        ["everyone", null],
        ["expired", "Expired on 2026-07-01"],
        ["scheduled", "Not effective until 2027-01-01"],
      ],
    )
  })

  // The cases the web lacked.
  test("the third tie-break is the lower id: two rows of one score and one start are decided, whatever order they came in", () => {
    const first = row("018f7c34-a000-7000-8000-0000000000a1", { planningAreaId: HARBOR })
    const second = row("018f7c34-a000-7000-8000-0000000000a2", { planningAreaId: HARBOR })
    assert.equal(winnerOf([second, first]), first.id)
    assert.equal(winnerOf([first, second]), first.id)
    // A later start still beats a lower id: the id decides only what the start could not.
    assert.equal(winnerOf([first, { ...second, validFrom: "2026-02-01" }]), second.id)
  })

  test("a default row loses to a zone row for the zone and wins where the zone differs, and a row naming a zone the input lacks is not eligible", () => {
    const rows = [row("everyone"), row("central", { planningAreaId: CENTRAL, unitPriceMinor: 1_100 })]
    const inHarbor = resolvePrice(rows, input, labels)
    assert.equal(inHarbor.winner?.row.id, "everyone")
    assert.equal(inHarbor.verdicts[1].reason, "Planning area is Central, not Harbor")
    assert.equal(winnerOf(rows, { ...input, planningAreaId: CENTRAL }), "central")
    const noZone = resolvePrice(rows, { ...input, planningAreaId: null }, labels)
    assert.equal(noZone.winner?.row.id, "everyone")
    assert.equal(noZone.verdicts[1].reason, "Requires planning area Central")
  })

  test("every losing sentence, in the prototype's words, judged in the prototype's order: the customer, the period, then each condition", () => {
    const rows = [
      row("bin", { containerTypeId: BIN_660 }),
      row("glass", { wasteFractionId: GLASS }),
      row("person", { customerKind: "person" }),
      row("ended", { planningAreaId: HARBOR, validTo: "2026-08-20" }),
      row("later", { validFrom: "2026-08-21" }),
      row("deal", { customerId: COWORK, validFrom: "2027-01-01", containerTypeId: BIN_660 }),
    ]
    const on: PriceInput = { ...input, containerTypeId: BIN_240, wasteFractionId: RESIDUAL }
    const resolution = resolvePrice(rows, on, labels)
    const reasons = Object.fromEntries(resolution.verdicts.map((verdict) => [verdict.row.id, verdict.reason]))
    assert.deepEqual(reasons, {
      bin: "Container type is 660 L, not 240 L",
      glass: "Waste fraction is Glass, not Residual",
      person: "Customer kind is person, not organisation",
      // The period is half-open: a row ending on the day is out of force on it.
      ended: "Expired on 2026-08-20",
      later: "Not effective until 2026-08-21",
      // The customer is judged before the period and the period before the conditions.
      deal: "Negotiated for Nørrebro CoWork ApS, not this customer",
    })
    assert.equal(resolution.winner, null, "no row is eligible")
    assert.deepEqual(
      resolution.verdicts.map((verdict) => verdict.row.id),
      ["bin", "deal", "ended", "glass", "later", "person"],
      "ineligible rows read by id, so a list of verdicts is stable",
    )
    // Without a container type the sentence asks for one; without labels the id stands.
    assert.equal(resolvePrice([rows[0]], { ...input, wasteFractionId: RESIDUAL }, labels).verdicts[0].reason, "Requires container type 660 L")
    assert.equal(resolvePrice([rows[0]], { ...input, containerTypeId: BIN_240 }).verdicts[0].reason, `Container type is ${BIN_660}, not ${BIN_240}`)
    // A row on its first day is in force; one whose end is tomorrow is too.
    assert.equal(winnerOf([row("today", { validFrom: "2026-08-20" })]), "today")
    assert.equal(winnerOf([row("until-tomorrow", { validTo: "2026-08-21" })]), "until-tomorrow")
  })

  test("the conditions are the four the prototype had, in the order judged, each with the name a sentence reads", () => {
    assert.deepEqual([...PRICE_CONDITIONS], ["planningAreaId", "customerKind", "containerTypeId", "wasteFractionId"])
    assert.deepEqual(CONDITION_NAMES, { planningAreaId: "Planning area", customerKind: "Customer kind", containerTypeId: "Container type", wasteFractionId: "Waste fraction" })
    assert.equal(scoreOf(row("all", { planningAreaId: HARBOR, customerKind: "organisation", containerTypeId: BIN_240, wasteFractionId: RESIDUAL, customerId: COWORK })), 104)
    assert.equal(scoreOf(row("none")), 0)
  })

  test("no rows is no winner and no verdicts; the verdicts answered are every row, the winner first", () => {
    assert.deepEqual(resolvePrice([], input), { verdicts: [], winner: null })
    const rows = [row("a"), row("b", { planningAreaId: CENTRAL }), row("c", { planningAreaId: HARBOR })]
    const resolution = resolvePrice(rows, input, labels)
    assert.deepEqual(resolution.verdicts.map((verdict) => verdict.row.id), ["c", "a", "b"], "eligible rows by score, then the ineligible")
    assert.equal(resolution.verdicts.filter((verdict) => verdict.winner).length, 1)
    assert.equal(resolution.verdicts[0], resolution.winner)
  })
})

describe("priceListIdFor", () => {
  test("is the agreement's own list when it names one, the project's default otherwise, and none when neither", () => {
    assert.equal(priceListIdFor({ priceListId: "own" }, "default"), "own")
    assert.equal(priceListIdFor({ priceListId: null }, "default"), "default")
    assert.equal(priceListIdFor({ priceListId: null }, null), null)
  })
})

describe("priceOccurrence", () => {
  const list = { id: "list", currency: "DKK", rows: [row("everyone", { unitPriceMinor: 12_345 }), row("harbor", { planningAreaId: HARBOR, unitPriceMinor: 15_000 })] }
  const occurrence = { agreement: { status: "active" as const }, priceList: list, product: { vatPercent: 25 }, quantity: 1, input }

  test("prices an occurrence under a signed agreement with a list, a row and a rate: the winner's unit price times the quantity, the VAT rounded per line, the list's currency, the row traceable", () => {
    assert.deepEqual(priceOccurrence(occurrence, labels), {
      blockReason: null,
      price: { priceListRowId: "harbor", unitPriceMinor: 15_000, netMinor: 15_000, vatPercent: 25, vatMinor: 3_750, currency: "DKK" },
      resolution: resolvePrice(list.rows, input, labels),
    })
    const three = priceOccurrence({ ...occurrence, quantity: 3, input: { ...input, planningAreaId: CENTRAL } }, labels)
    assert.deepEqual(three.price, { priceListRowId: "everyone", unitPriceMinor: 12_345, netMinor: 37_035, vatPercent: 25, vatMinor: 9_259, currency: "DKK" }, "37 035 × 25 % = 9 258.75, rounded away from zero")
  })

  test("answers the one block reason that stands in the way, in the order reprice mends them", () => {
    assert.deepEqual(priceOccurrence({ ...occurrence, agreement: { status: "draft" } }), { blockReason: "agreement-draft", price: null, resolution: null })
    assert.deepEqual(priceOccurrence({ ...occurrence, priceList: null }), { blockReason: "no-price-list", price: null, resolution: null })
    const noRow = priceOccurrence({ ...occurrence, priceList: { ...list, rows: [row("later", { validFrom: "2027-01-01" })] } })
    assert.equal(noRow.blockReason, "no-price-row")
    assert.equal(noRow.price, null)
    assert.equal(noRow.resolution?.verdicts[0].reason, "Not effective until 2027-01-01", "the resolution travels with the block, so the office reads why")
    const noRate = priceOccurrence({ ...occurrence, product: { vatPercent: null } })
    assert.equal(noRate.blockReason, "no-vat-rate")
    assert.equal(noRate.price, null)
    assert.equal(noRate.resolution?.winner?.row.id, "harbor")
    // A draft agreement is judged before the list: mending the list does not unblock it.
    assert.equal(priceOccurrence({ ...occurrence, agreement: { status: "draft" }, priceList: null }).blockReason, "agreement-draft")
    // A cancelled agreement whose placement was valid on the day is priced: the work happened under it.
    assert.equal(priceOccurrence({ ...occurrence, agreement: { status: "cancelled" } }).blockReason, null)
    // A price of zero is a price, not a missing row.
    assert.deepEqual(priceOccurrence({ ...occurrence, priceList: { ...list, rows: [row("free", { unitPriceMinor: 0 })] } }).price, { priceListRowId: "free", unitPriceMinor: 0, netMinor: 0, vatPercent: 25, vatMinor: 0, currency: "DKK" })
  })
})
