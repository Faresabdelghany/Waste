// A place's Pickup Exceptions as its details read them (M5 of #293): the
// paths the two histories are read under, the grants that read them, and the
// sentences a stop and the rules' judgement of it are told in.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { PickupExceptionHistory, type PickupException } from "@waste/contracts/pickup-exceptions"

import type { ApiClient } from "../../api/client"
import { chargeSentence, exceptionSentence, historyReadable, historySummary, placePickupExceptions } from "../pickup-exception-history"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const CODE = "01a0d3a5-e5e0-7000-8000-0000000000c1"
const FEE = "01a0d3a5-e5e0-7000-8000-0000000000f1"
const RULE = "01a0d3a5-e5e0-7000-8000-0000000000a1"

const item = (values: Partial<PickupException> = {}): PickupException => ({
  pickupId: ID,
  routeId: ID,
  projectId: ID,
  serviceDate: "2026-03-04",
  status: "skipped",
  reason: "contamination",
  contaminantCodeId: null,
  origin: "generation",
  service: "empty",
  propertyId: ID,
  sharedCollectionPointId: null,
  evidenceProofId: null,
  judgement: { ruleId: RULE, index: 1, free: false, productId: FEE },
  ...values,
})

const names: Record<string, string> = { [CODE]: "Glass in residual", [FEE]: "Contamination fee" }
const name = (id: string) => names[id] ?? id

describe("the read", () => {
  test("asks the property's and the shared point's history under their own paths, and answers it as one row", async () => {
    const asked: string[] = []
    const history: PickupExceptionHistory = { items: [item()], truncated: false }
    const client: ApiClient = {
      baseUrl: "http://api.test",
      token: "t",
      fetch: (async (url: string | URL | Request) => {
        asked.push(String(url))
        return new Response(JSON.stringify(history), { status: 200, headers: { "content-type": "application/json" } })
      }) as typeof fetch,
    }
    assert.deepEqual(await placePickupExceptions("property")(client, ID), [history])
    await placePickupExceptions("shared-point")(client, ID)
    assert.deepEqual(asked.map((url) => new URL(url).pathname), [`/properties/${ID}/pickup-exceptions`, `/shared-collection-points/${ID}/pickup-exceptions`])
    assert.equal(PickupExceptionHistory.safeParse(history).success, true)
  })

  test("is the role's where it views the place's module and the stops, the API's two grants", () => {
    const stops = { moduleKey: "route-studio.pickups", actions: ["view"] }
    assert.equal(historyReadable([{ moduleKey: "customers.properties", actions: ["view"] }, stops], "property"), true)
    assert.equal(historyReadable([{ moduleKey: "customers.properties", actions: ["view"] }], "property"), false)
    assert.equal(historyReadable([{ moduleKey: "customers.properties", actions: ["view"] }, stops], "shared-point"), false)
    assert.equal(historyReadable([{ moduleKey: "customers.shared", actions: ["view"] }, stops], "shared-point"), true)
    assert.equal(historyReadable(undefined, "property"), false)
  })
})

describe("the sentences", () => {
  test("say what happened at the stop", () => {
    assert.equal(exceptionSentence(item(), name), "Skipped: contamination")
    assert.equal(exceptionSentence(item({ status: "failed", reason: "not-presented" }), name), "Failed: not presented")
    assert.equal(exceptionSentence(item({ contaminantCodeId: CODE }), name), "Skipped: contamination, coded Glass in residual")
    assert.equal(exceptionSentence(item({ status: "completed", reason: null, contaminantCodeId: CODE }), name), "Collected, tagged Glass in residual")
    assert.equal(exceptionSentence(item({ reason: null }), name), "Skipped")
  })

  test("say what the rules in force charge it, by its place in the window", () => {
    assert.equal(chargeSentence(item(), name), "Contamination fee · 2nd in the window")
    assert.equal(chargeSentence(item({ judgement: { ruleId: RULE, index: 0, free: true, productId: null } }), name), "Free · 1st in the window")
    assert.equal(chargeSentence(item({ judgement: { ruleId: RULE, index: 10, free: false, productId: FEE } }), name), "Contamination fee · 11th in the window")
  })

  test("say why nothing is charged: the office's stop, a work order, or no rule", () => {
    assert.equal(chargeSentence(item({ judgement: null, origin: "office" }), name), "Not chargeable: the office's stop")
    assert.equal(chargeSentence(item({ judgement: null, service: "repair" }), name), "Not chargeable: a work order")
    assert.equal(chargeSentence(item({ judgement: null }), name), "No rule charges it")
  })

  test("count the history, and say where only the latest were read", () => {
    const free = item({ judgement: { ruleId: RULE, index: 0, free: true, productId: null } })
    assert.equal(historySummary({ items: [], truncated: false }), "No exceptions in the year before today.")
    assert.equal(historySummary({ items: [item()], truncated: false }), "One exception, 1 charged under the rules in force.")
    assert.equal(historySummary({ items: [item(), free], truncated: false }), "2 exceptions, 1 charged under the rules in force.")
    assert.equal(historySummary({ items: [item(), item()], truncated: false }), "2 exceptions, all charged under the rules in force.")
    assert.equal(historySummary({ items: [free], truncated: false }), "One exception, none charged under the rules in force.")
    assert.equal(historySummary({ items: [item(), free], truncated: true }), "2 exceptions, 1 charged under the rules in force: the latest 2 are shown.")
  })
})
