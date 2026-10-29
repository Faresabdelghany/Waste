import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { MoveOutcome } from "@waste/contracts/moves"
import type { Grants } from "@/lib/api/grants"
import { formatMinor } from "@/lib/commercial/money"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { moveBodyOf, moveOffered, moveReview, movingOutOf, type MoveTyped } from "@/lib/data/property-moves"

const OUT = "01a0d2a4-a280-7006-8000-000000000001"
const IN = "01a0d2a4-a280-7006-8000-000000000002"
const PAYER = "01a0d2a4-a280-7006-8000-000000000003"
const SERVER = new Map([
  ["customer-ida", OUT],
  ["customer-bo", IN],
  ["company-admin", PAYER],
])
const serverIdOf = (webId: string) => SERVER.get(webId)

const typed: MoveTyped = { on: "2026-11-01", outgoing: "customer-ida", incoming: "customer-bo", payer: "", agreementNumber: " AGR-3001 " }

describe("moveOffered", () => {
  test("asks edit on the properties and on the agreements, since a move writes both", () => {
    const grants = (keys: Record<string, string[]>): Grants => Object.entries(keys).map(([moduleKey, actions]) => ({ moduleKey, actions }))
    assert.equal(moveOffered(grants({ "customers.properties": ["view", "edit"], "customers.agreements": ["view", "edit"] })), true)
    assert.equal(moveOffered(grants({ "customers.properties": ["view", "edit"], "customers.agreements": ["view"] })), false)
    assert.equal(moveOffered(undefined), false)
  })
})

describe("movingOutOf", () => {
  test("is every customer the record names today, in any role, each once in the order the roles are listed", () => {
    const record = { submittedValues: { ownerIds: "company-landlord", payerIds: "customer-ida", tenantIds: "customer-ida,customer-jens", administratorIds: "", serviceContactIds: "" } } as unknown as BusinessRecord
    assert.deepEqual(movingOutOf(record), ["company-landlord", "customer-ida", "customer-jens"])
  })
})

describe("moveBodyOf", () => {
  test("names the two customers by server id, trims the number, leaves the payer to the incoming customer where none is picked, and says whether it is a dry run", () => {
    assert.deepEqual(moveBodyOf(typed, serverIdOf, true), { on: "2026-11-01", outgoingCustomerId: OUT, incomingCustomerId: IN, agreementNumber: "AGR-3001", dryRun: true })
    assert.deepEqual(moveBodyOf({ ...typed, payer: "company-admin", agreementNumber: "" }, serverIdOf, false), { on: "2026-11-01", outgoingCustomerId: OUT, incomingCustomerId: IN, payerCustomerId: PAYER, dryRun: false })
    assert.deepEqual(moveBodyOf({ ...typed, payer: "customer-bo" }, serverIdOf, false), { on: "2026-11-01", outgoingCustomerId: OUT, incomingCustomerId: IN, agreementNumber: "AGR-3001", dryRun: false }, "the incoming customer picked as payer is the default, not a payer of its own")
  })

  test("refuses before the API what it can say itself, at the field: no day, nobody moving, the same customer both ways, a customer the API does not hold", () => {
    assert.deepEqual(moveBodyOf({ ...typed, on: "" }, serverIdOf, true), { path: "on", message: "Pick the day the incoming customer moves in" })
    assert.deepEqual(moveBodyOf({ ...typed, outgoing: "" }, serverIdOf, true), { path: "outgoing", message: "Pick who moves out" })
    assert.deepEqual(moveBodyOf({ ...typed, incoming: "" }, serverIdOf, true), { path: "incoming", message: "Pick who moves in" })
    assert.deepEqual(moveBodyOf({ ...typed, incoming: "customer-ida" }, serverIdOf, true), { path: "incoming", message: "A customer does not move into the property they move out of" })
    assert.deepEqual(moveBodyOf({ ...typed, incoming: "customer-new" }, serverIdOf, true), { path: "incoming", message: "This customer is not one the API holds yet" })
  })
})

describe("moveReview", () => {
  const STAMPS = { createdAt: "2026-10-28T09:00:00.000Z", updatedAt: "2026-10-28T09:00:00.000Z" }
  const agreement = (number: string, customerId: string, validFrom: string, validTo: string | null) => ({
    id: `${number}-id`,
    ...STAMPS,
    projectId: "p",
    number,
    customerId,
    payerCustomerId: customerId === IN ? PAYER : customerId,
    status: "active",
    billingCadence: "monthly",
    currency: "DKK",
    notes: null,
    priceListId: null,
    serviceWindow: null,
    validFrom,
    validTo,
  })
  const outcome = (outgoingTo: string | null): MoveOutcome =>
    ({
      dryRun: true,
      on: "2026-11-01",
      property: { parties: [{ customerId: IN, role: "tenant", validFrom: "2026-11-01", validTo: null }, { customerId: IN, role: "payer", validFrom: "2026-11-01", validTo: null }] },
      outgoing: { agreement: agreement("AGR-3000", OUT, "2026-01-01", outgoingTo), subscriptions: [{ id: "s1" }, { id: "s2" }] },
      incoming: { agreement: agreement("AGR-3001", IN, "2026-11-01", null), subscriptions: [{ id: "n1" }, { id: "n2" }] },
      containersCarried: ["c1"],
      chargesToCredit: [
        { id: "e1", status: "invoiced", netMinor: 31_000, currency: "DKK", charge: { periodFrom: "2026-11-01", periodTo: "2026-12-01", chargedDays: 30, periodDays: 30 } },
        { id: "e2", status: "ready", netMinor: 31_000, currency: "DKK", charge: { periodFrom: "2026-12-01", periodTo: "2027-01-01", chargedDays: 31, periodDays: 31 } },
      ],
    }) as unknown as MoveOutcome
  const names = new Map([
    [OUT, "Ida Leaving"],
    [IN, "Bo Arriving"],
    [PAYER, "Housing administrator"],
  ])
  const nameOf = (serverId: string) => names.get(serverId) ?? serverId

  test("says what ends, what begins and what stays in service, in the office's words", () => {
    const review = moveReview(outcome("2026-11-01"), nameOf, OUT)
    assert.deepEqual(review.lines, [
      "From 2026-11-01 Bo Arriving is the property's payer and tenant.",
      "AGR-3000 of Ida Leaving ends on 2026-11-01, its 2 subscriptions here with it.",
      "AGR-3001 begins on 2026-11-01 for Bo Arriving, invoicing Housing administrator, with 2 subscriptions.",
      "1 container stays in service under AGR-3001.",
    ])
    assert.match(moveReview(outcome(null), nameOf, OUT).lines[1], /^AGR-3000 of Ida Leaving goes on at its other places; its 2 subscriptions here end on 2026-11-01\.$/)
  })

  test("lists each charge left past the day by its period and amount, and what the office does with it: credit an invoiced one, cancel or reprice one not invoiced", () => {
    assert.deepEqual(
      moveReview(outcome("2026-11-01"), nameOf, OUT).charges.map((charge) => [charge.label, charge.invoiced, charge.advice]),
      [
        [`2026-11-01 – 2026-11-30 · ${formatMinor(31_000, "DKK")}`, true, "Invoiced: credit it from its invoice"],
        [`2026-12-01 – 2026-12-31 · ${formatMinor(31_000, "DKK")}`, false, "Not invoiced: cancel or reprice it before the next run"],
      ],
    )
  })

  test("a move of the parties alone says so", () => {
    const alone = { ...outcome(null), outgoing: { agreement: null, subscriptions: [] }, incoming: { agreement: null, subscriptions: [] }, containersCarried: [], chargesToCredit: [] } as MoveOutcome
    assert.deepEqual(moveReview(alone, nameOf, OUT).lines, ["From 2026-11-01 Bo Arriving is the property's payer and tenant.", "Ida Leaving subscribes at this property under no agreement, so only the parties move."])
  })
})
