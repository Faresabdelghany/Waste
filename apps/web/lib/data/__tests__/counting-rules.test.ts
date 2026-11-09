// Settings › Counting rules (#547 of #544): who may do what, a rule's draft
// and the body or the patch it becomes, refused at its field in the API's
// sentence, a simulation's body and window, and a rule as a sentence.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { CountingRuleCreate, CountingRulePatch, CountingSimulationBody, type CountingRule } from "@waste/contracts/counting-rules"
import { SIMULATION_DAYS_MAX, windowDays } from "@waste/domain/resolution/counting-rules"

import type { Grants } from "@/lib/modules/grants"
import {
  countingRuleBodyOf,
  countingRuleDraftOf,
  countingRulePatchOf,
  countingRuleSentence,
  countingRulesAccessOf,
  isCountingRuleRefusal,
  simulatedPeriod,
  SIMULATION_WINDOWS,
  simulationBodyOf,
  simulationSentence,
  simulationWindowOf,
} from "../counting-rules"

const TYPE = "01a0d3a5-e5e0-7000-8000-000000000001"
const TEAM = "01a0d3a5-e5e0-7000-8000-000000000002"
const GLASS = "01a0d3a5-e5e0-7000-8000-000000000003"

const RULE: CountingRule = {
  id: "01a0d3a5-e5e0-7000-8000-0000000000aa",
  name: "Emptied often",
  status: "inactive",
  period: "month",
  limit: 3,
  wasteFractionId: null,
  containerTypeId: null,
  ticketTypeId: TYPE,
  teamId: TEAM,
  notifiesTeam: false,
  createdAt: "2026-11-01T08:00:00.000Z",
  updatedAt: "2026-11-01T08:00:00.000Z",
}

describe("who may do what", () => {
  test("the templates' grant reads and writes, and the stops' beside it simulates", () => {
    const grants: Grants = [{ moduleKey: "configure.templates", actions: ["view", "create", "edit"] }]
    assert.deepEqual(countingRulesAccessOf(grants), { view: true, create: true, edit: true, delete: false, simulate: false })
    assert.equal(countingRulesAccessOf([...grants, { moduleKey: "route-studio.pickups", actions: ["view"] }]).simulate, true)
    assert.equal(countingRulesAccessOf(undefined).view, false)
  })
})

describe("a rule's draft", () => {
  test("a new one counts monthly, inactive, nobody told", () => {
    assert.deepEqual(countingRuleDraftOf(), { name: "", active: false, period: "month", limit: "", wasteFractionId: null, containerTypeId: null, ticketTypeId: null, teamId: null, notifiesTeam: false })
  })

  test("becomes the body the API takes, every field said", () => {
    const body = countingRuleBodyOf({ ...countingRuleDraftOf(RULE), name: "  Emptied often ", active: true, limit: "12", wasteFractionId: GLASS })
    assert.ok(!isCountingRuleRefusal(body))
    assert.deepEqual(CountingRuleCreate.parse(body), { name: "Emptied often", status: "active", period: "month", limit: 12, wasteFractionId: GLASS, containerTypeId: null, ticketTypeId: TYPE, teamId: TEAM, notifiesTeam: false })
  })

  test("is refused at its first wrong field, in the API's words", () => {
    const draft = countingRuleDraftOf(RULE)
    assert.deepEqual(countingRuleBodyOf({ ...draft, name: " " }), { field: "name", message: "Name the rule" })
    for (const limit of ["", "0", "2.5", "1001", "twelve"]) assert.deepEqual(countingRuleBodyOf({ ...draft, limit }), { field: "limit", message: "A limit is a whole number from 1 to 1000" }, limit)
    assert.deepEqual(countingRuleBodyOf({ ...draft, ticketTypeId: null }), { field: "ticketTypeId", message: "Pick the type of the ticket it opens" })
    assert.deepEqual(countingRuleBodyOf({ ...draft, teamId: null }), { field: "teamId", message: "Pick the team the ticket waits with" })
  })

  test("patches what changed alone, and nothing where nothing did", () => {
    assert.equal(countingRulePatchOf(RULE, countingRuleDraftOf(RULE)), null)
    const patch = countingRulePatchOf(RULE, { ...countingRuleDraftOf(RULE), active: true, limit: "4", notifiesTeam: true })
    assert.deepEqual(patch, { status: "active", limit: 4, notifiesTeam: true })
    assert.deepEqual(CountingRulePatch.parse(patch), patch)
    assert.deepEqual(countingRulePatchOf(RULE, { ...countingRuleDraftOf(RULE), limit: "x" }), { field: "limit", message: "A limit is a whole number from 1 to 1000" })
  })
})

describe("a simulation", () => {
  test("takes the draft's terms over a window, refused at a limit that will not do", () => {
    const window = simulationWindowOf("2026-11-06", 12)
    const body = simulationBodyOf({ ...countingRuleDraftOf(RULE), period: "quarter", limit: "5", containerTypeId: GLASS }, window)
    assert.deepEqual(CountingSimulationBody.parse(body), { period: "quarter", limit: 5, wasteFractionId: null, containerTypeId: GLASS, from: "2025-11-07", to: "2026-11-07" })
    assert.ok(isCountingRuleRefusal(simulationBodyOf({ ...countingRuleDraftOf(RULE), limit: "" }, window)))
  })

  test("looks back a year, two or three from today, today included and inside the API's bound", () => {
    assert.deepEqual(simulationWindowOf("2026-11-06", 12), { from: "2025-11-07", to: "2026-11-07" })
    for (const option of SIMULATION_WINDOWS) {
      const window = simulationWindowOf("2028-02-29", Number(option.value))
      assert.ok(windowDays(window) <= SIMULATION_DAYS_MAX, option.label)
      assert.equal(window.to, "2028-03-01")
    }
  })

  test("names each ticket's period as a person reads it", () => {
    assert.equal(simulatedPeriod("2026-04-01", "quarter"), "Q2 2026")
  })

  test("says its window through its last day, never the first day not counted", () => {
    const window = { from: "2025-11-01", to: "2026-12-01" }
    assert.equal(simulationSentence({ ...window, tickets: 0, properties: 0, shown: [] }), "No property would have received a ticket from 2025-11-01 through 2026-11-30.")
    const one = { propertyId: GLASS, propertyName: "Harbour 1", projectId: TEAM, periodFrom: "2026-03-01", reachedOn: "2026-03-20", count: 3 }
    assert.equal(simulationSentence({ ...window, tickets: 1, properties: 1, shown: [one] }), "1 ticket at 1 property from 2025-11-01 through 2026-11-30.")
    assert.equal(simulationSentence({ ...window, tickets: 3, properties: 2, shown: [one] }), "3 tickets at 2 properties from 2025-11-01 through 2026-11-30. The first 1 are listed.")
  })
})

describe("a rule as a sentence", () => {
  test("says the limit, what is counted and the period", () => {
    assert.equal(countingRuleSentence({ limit: 12, period: "month" }, { wasteFraction: "Glass", containerType: null }), "12 completed emptyings of Glass a month")
    assert.equal(countingRuleSentence({ limit: 1, period: "year" }, { wasteFraction: null, containerType: "240 L bin" }), "1 completed emptying in 240 L bin containers a year")
  })
})
