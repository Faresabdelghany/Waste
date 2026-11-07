import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../../prototype-record"
import {
  CONTAINER_DRIFT_THRESHOLD_PERCENT,
  LAST_GENERATION_MATCHES_KEY,
  PREVIOUS_GENERATION_MATCHES_KEY,
  containerDriftBetween,
  containerDriftWarning,
  generationMatchHistoryOf,
  parseGenerationMatches,
  serializeGenerationMatches,
  type GenerationMatches,
} from "../container-drift"
import { COLLECTION_GROUPS_KEY, collectionGroupsOf } from "../groups"
import { schemeAttention } from "../lifecycle"

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

/* ------------------------------- the badge -------------------------------- */

describe("the Attention badge reads the two stamps the scheme carries", () => {
  const rule = `${AREA}|Residual||`
  const thirty = containersOf(30)
  const DRIFT_PREFIX = "Matched containers shifted"
  /** The scheme as the API's adapter hands it over: the run before and the last run, stored as `serializeGenerationMatches` writes them. */
  const stamped = (scheme: BusinessRecord, previous: GenerationMatches, last: GenerationMatches): BusinessRecord => ({
    ...scheme,
    submittedValues: {
      ...scheme.submittedValues,
      [PREVIOUS_GENERATION_MATCHES_KEY]: serializeGenerationMatches(previous),
      [LAST_GENERATION_MATCHES_KEY]: serializeGenerationMatches(last),
    },
  })
  const attentionOf = (scheme: BusinessRecord, containers: readonly BusinessRecord[]) => schemeAttention(scheme, { schemes: [scheme], containers })
  const driftWarnings = (warnings: readonly string[]) => warnings.filter((warning) => warning.startsWith(DRIFT_PREFIX))

  test("a shift past the threshold is the badge's last sentence, joined and left counted against the run before; within the threshold, or with no run before, there is none", () => {
    const grown = [...thirty, ...["d01", "d02", "d03", "d04"].map((id) => container(id))]
    const joined = stamped(ruleScheme(), stamp(rule, ids(thirty)), stamp(rule, ids(grown)))
    const sentence = "Matched containers shifted 13 % between generation runs: 4 joined, 0 left of 30"
    const attention = attentionOf(joined, grown)
    assert.deepEqual(driftWarnings(attention), [sentence])
    assert.equal(attention[attention.length - 1], sentence, "the drift sentence follows validation's warnings")

    // 3 of 34 leave (9 %): the most recent change is no drift.
    const settled = grown.slice(0, 31)
    assert.deepEqual(driftWarnings(attentionOf(stamped(ruleScheme(), stamp(rule, ids(grown)), stamp(rule, ids(settled))), settled)), [])
    // The first run has nothing to compare with.
    assert.deepEqual(driftWarnings(attentionOf(stamped(ruleScheme(), {}, stamp(rule, ids(thirty))), thirty)), [])
  })

  test("containers leaving count too: 4 of 30 out of the set is a drift", () => {
    const shrunk = thirty.slice(4)
    const left = stamped(ruleScheme(), stamp(rule, ids(thirty)), stamp(rule, ids(shrunk)))
    assert.deepEqual(driftWarnings(attentionOf(left, shrunk)), [
      "Matched containers shifted 13 % between generation runs: 0 joined, 4 left of 30",
    ])
  })

  test("named collection groups are reported one clause each", () => {
    const explicit = ruleScheme({
      stopSelection: "",
      matchFractions: "",
      [COLLECTION_GROUPS_KEY]: JSON.stringify([
        { id: "g-residual", name: "Residual run", days: ["monday", "tuesday", "wednesday", "thursday", "friday"], fractions: ["Residual"], vehicleId: "vehicle-wh24", driverId: "driver-mads", stopSource: "rule", containerIds: [] },
        { id: "g-organic", name: "Organic run", days: ["monday", "tuesday", "wednesday", "thursday", "friday"], fractions: ["Organic"], vehicleId: "vehicle-wh25", driverId: "driver-lars", stopSource: "rule", containerIds: [] },
      ]),
    })
    const organic = containersOf(5, "Organic").map((record) => ({ ...record, id: `o-${record.id}` }))
    const moved = [...thirty, ...["d01", "d02", "d03", "d04"].map((id) => container(id)), ...organic, container("o-d01", "Organic"), container("o-d02", "Organic")]
    const organicRule = `${AREA}|Organic||`
    const previous: GenerationMatches = {
      "g-residual": { rule, containerIds: ids(thirty) },
      "g-organic": { rule: organicRule, containerIds: ids(organic) },
    }
    const last: GenerationMatches = {
      "g-residual": { rule, containerIds: [...ids(thirty), "d01", "d02", "d03", "d04"] },
      "g-organic": { rule: organicRule, containerIds: [...ids(organic), "o-d01", "o-d02"] },
    }
    const sentence = "Matched containers shifted between generation runs: Residual run 13 % (4 joined, 0 left of 30); Organic run 40 % (2 joined, 0 left of 5)"
    const scheme = stamped(explicit, previous, last)
    assert.deepEqual(driftWarnings(attentionOf(scheme, moved)), [sentence])
    assert.equal(containerDriftWarning(containerDriftBetween(previous, last, collectionGroupsOf(explicit.submittedValues, { facts: {} }))), sentence)
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
