import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../../prototype-record"
import {
  CONTAINER_DRIFT_THRESHOLD_PERCENT,
  LAST_GENERATION_MATCHES_KEY,
  PREVIOUS_GENERATION_MATCHES_KEY,
  containerDriftBetween,
  generationMatchHistoryOf,
  parseGenerationMatches,
  serializeGenerationMatches,
  type GenerationMatches,
} from "../container-drift"
import { collectionGroupsOf } from "../groups"

/* --------------------------------- fixtures -------------------------------- */

const AREA = "area-indreby"

/** An in-service 240 L residual bin inside the scheme's planning area. */
const container = (id: string, fraction = "Residual"): BusinessRecord => ({
  id,
  name: id.toUpperCase(),
  context: "",
  status: "Available",
  owner: "",
  value: "",
  updated: "",
  description: "",
  facts: { "Waste fractions": fraction, "Container type": "Two-wheel bin · 240 L" },
  related: [],
  source: "",
  freshness: "",
  allowedTransitions: [],
  submittedValues: { planningAreaId: AREA },
})

/** c01 … cNN — the container base one run resolves against. */
const containersOf = (n: number, fraction = "Residual"): BusinessRecord[] =>
  Array.from({ length: n }, (_, index) =>
    container(`c${String(index + 1).padStart(2, "0")}`, fraction),
  )

const ids = (records: readonly BusinessRecord[]) => records.map((record) => record.id).sort()

/** A weekly Mon–Fri rule scheme (one implicit shared group) matching Residual in the area. */
function ruleScheme(values: Record<string, string | boolean> = {}, status = "Validated"): BusinessRecord {
  return {
    id: "scheme-drift",
    name: "RS-Drift",
    context: "",
    status,
    owner: "",
    value: "",
    updated: "Now",
    description: "",
    facts: { Vehicle: "WH-24", Driver: "Mads Jensen" },
    related: [],
    source: "",
    freshness: "Now",
    allowedTransitions: [],
    submittedValues: {
      schemeName: "RS-Drift",
      planningAreaId: AREA,
      frequency: "weekly",
      serviceDays: "monday, tuesday, wednesday, thursday, friday",
      effectiveFrom: "2026-09-01",
      effectiveTo: "2027-08-31",
      holidayPolicy: "skip",
      plannedVehicleId: "vehicle-wh24",
      plannedDriverId: "driver-mads",
      stopSelection: "rule",
      sameAllDays: true,
      matchFractions: "Residual",
      matchRulesByDay: "{}",
      ...values,
    },
  }
}

const stamp = (rule: string, containerIds: string[]): GenerationMatches => ({
  default: { rule, containerIds },
})

const groups = collectionGroupsOf(ruleScheme().submittedValues, { facts: {} })

/* ------------------------------- the threshold ------------------------------ */

describe("the 10 % threshold", () => {
  const rule = `${AREA}|Residual||`
  const thirty = ids(containersOf(30))

  test("exactly 10 % of the previous set is not a drift; one container more is", () => {
    assert.equal(CONTAINER_DRIFT_THRESHOLD_PERCENT, 10)
    // 1 joined + 2 left of 30 = 3 of 30, exactly a tenth.
    const tenPercent = [...thirty.filter((id) => id !== "c29" && id !== "c30"), "d01"]
    assert.deepEqual(containerDriftBetween(stamp(rule, thirty), stamp(rule, tenPercent), groups), [])
    // 2 joined + 2 left of 30 = 4 of 30.
    const justAbove = [...tenPercent, "d02"]
    const [drift, ...rest] = containerDriftBetween(stamp(rule, thirty), stamp(rule, justAbove), groups)
    assert.equal(rest.length, 0)
    assert.deepEqual(
      { ...drift, shift: undefined },
      { groupId: "default", previous: 30, joined: ["d01", "d02"], left: ["c29", "c30"], shift: undefined },
    )
    assert.ok(drift.shift > 0.1 && drift.shift < 0.14)
    assert.equal(drift.groupName, undefined)
  })

  test("the boundary holds at other sizes: 1 of 10 is not a drift, 2 of 10 is", () => {
    const ten = ids(containersOf(10))
    const nine = ten.slice(0, 9)
    assert.deepEqual(containerDriftBetween(stamp(rule, ten), stamp(rule, nine), groups), [])
    const eight = ten.slice(0, 8)
    assert.equal(containerDriftBetween(stamp(rule, ten), stamp(rule, eight), groups).length, 1)
  })

  test("a previous set of nothing: anything matched now is a full shift, nothing is none", () => {
    const [drift] = containerDriftBetween(stamp(rule, []), stamp(rule, ["c01"]), groups)
    assert.equal(drift.shift, 1)
    assert.equal(drift.previous, 0)
    assert.deepEqual(containerDriftBetween(stamp(rule, []), stamp(rule, []), groups), [])
  })

  test("a set matched under another rule is not compared", () => {
    const [drift] = containerDriftBetween(stamp(rule, thirty), stamp(rule, thirty.slice(0, 10)), groups)
    assert.ok(drift)
    assert.deepEqual(
      containerDriftBetween(stamp(rule, thirty), stamp(`${AREA}|Organic||`, thirty.slice(0, 10)), groups),
      [],
    )
  })
})

/* --------------------------------- storage --------------------------------- */

describe("the stamp's storage", () => {
  test("serializes with sorted keys and ids, and the empty stamp as an absent value", () => {
    assert.equal(serializeGenerationMatches({}), "")
    const a = serializeGenerationMatches({
      z: { rule: "r", containerIds: ["c2", "c1"] },
      a: { rule: "r", containerIds: ["c9"] },
    })
    const b = serializeGenerationMatches({
      a: { rule: "r", containerIds: ["c9"] },
      z: { rule: "r", containerIds: ["c1", "c2"] },
    })
    assert.equal(a, b)
    assert.deepEqual(parseGenerationMatches(a), {
      a: { rule: "r", containerIds: ["c9"] },
      z: { rule: "r", containerIds: ["c1", "c2"] },
    })
  })

  test("a corrupted or malformed stamp reads as no history", () => {
    assert.deepEqual(parseGenerationMatches("{not json"), {})
    assert.deepEqual(parseGenerationMatches("[]"), {})
    assert.deepEqual(parseGenerationMatches(undefined), {})
    assert.deepEqual(
      parseGenerationMatches(
        JSON.stringify({
          ok: { rule: "r", containerIds: ["c1"] },
          noRule: { containerIds: ["c1"] },
          badIds: { rule: "r", containerIds: [1, 2] },
          notAnObject: "x",
        }),
      ),
      { ok: { rule: "r", containerIds: ["c1"] } },
    )
    const history = generationMatchHistoryOf({
      [PREVIOUS_GENERATION_MATCHES_KEY]: "{oops",
      [LAST_GENERATION_MATCHES_KEY]: "",
    })
    assert.deepEqual(history, { previous: {}, last: {} })
  })
})
