import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { MoveCreate, MoveOutcome } from "../moves"
import { refusal, refusesWhatTheServerOwns } from "./expect"

const OUT = "01a0d3a5-e5e0-7000-8000-000000000001"
const IN = "01a0d3a5-e5e0-7000-8000-000000000002"
const PAYER = "01a0d3a5-e5e0-7000-8000-000000000003"

const body = { on: "2026-11-01", outgoingCustomerId: OUT, incomingCustomerId: IN, agreementNumber: "AGR-3001" }

describe("MoveCreate", () => {
  test("names the day, who moves out and who moves in, the payer and the incoming agreement's number where it has them, and is no dry run unless it says so", () => {
    assert.deepEqual(MoveCreate.parse(body), { ...body, dryRun: false })
    assert.deepEqual(MoveCreate.parse({ ...body, payerCustomerId: PAYER, dryRun: true }), { ...body, payerCustomerId: PAYER, dryRun: true })
    const { agreementNumber: _number, ...withoutNumber } = body
    assert.equal(MoveCreate.safeParse(withoutNumber).success, true, "a property nobody subscribes at moves without an agreement; the route says when one is owed")
  })

  test("refuses a day that is not one, a customer moving in where they move out, and what the server owns", () => {
    assert.deepEqual(refusal(MoveCreate.safeParse({ ...body, on: "1 November" })).map((issue) => issue.path), ["on"])
    assert.deepEqual(refusal(MoveCreate.safeParse({ ...body, incomingCustomerId: OUT })), [{ path: "incomingCustomerId", message: "A customer does not move into the property they move out of" }])
    assert.deepEqual(refusal(MoveCreate.safeParse({ ...body, propertyId: OUT })).map((issue) => issue.path), [""])
    refusesWhatTheServerOwns(MoveCreate, body)
  })
})

describe("MoveOutcome", () => {
  test("is what ended, what began, the containers carried over and the charges the office has to look at, as a dry run says them too", () => {
    const outcome = {
      dryRun: true,
      on: "2026-11-01",
      property: null,
      outgoing: { agreement: null, subscriptions: [] },
      incoming: { agreement: null, subscriptions: [] },
      containersCarried: [OUT],
      chargesToCredit: [],
    }
    assert.equal(MoveOutcome.safeParse(outcome).success, false, "the property is always answered")
  })
})
