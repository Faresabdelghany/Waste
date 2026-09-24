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
import { applySchemeGeneration, planSchemeGeneration } from "../generation"
import { COLLECTION_GROUPS_KEY, collectionGroupsOf } from "../groups"
import {
  recordGenerationRun,
  schemeAttention,
  schemeGenerationRecorded,
  schemeLiveAssessment,
} from "../lifecycle"
import { runPlanAhead } from "../plan-ahead"

/* --------------------------------- fixtures -------------------------------- */

const AREA = "area-indreby"
const DRIFT_PREFIX = "Matched containers shifted"

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

const window = { from: "2026-09-28", to: "2026-10-02" }

/** One generation run: plan, apply, and the scheme record the run leaves behind. */
function run(scheme: BusinessRecord, containers: readonly BusinessRecord[], generatedAt: string) {
  const plan = planSchemeGeneration({ scheme, window, existingRoutes: [], containers })
  assert.ok(plan, "the fixture scheme must plan")
  const result = applySchemeGeneration({
    plan,
    existingPickups: [],
    containers,
    actorName: "Test",
    generatedAt,
  })
  return { plan, result, scheme: recordGenerationRun(scheme, generatedAt, plan.matches) }
}

const related = (scheme: BusinessRecord, containers: readonly BusinessRecord[]) => ({
  schemes: [scheme],
  containers,
})

const driftWarnings = (warnings: readonly string[]) =>
  warnings.filter((warning) => warning.startsWith(DRIFT_PREFIX))

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

/* ------------------------------- run to run -------------------------------- */

describe("generation runs stamp what they matched and compare with the run before", () => {
  const thirty = containersOf(30)

  test("the first run has nothing to compare: no drift, and the stamp carries the set under its rule", () => {
    const first = run(ruleScheme(), thirty, "2026-09-24T06:00:00.000Z")
    assert.deepEqual(first.plan.containerDrift, [])
    assert.deepEqual(first.result.summary.containerDrift, [])
    assert.deepEqual(first.plan.matches, {
      default: { rule: `${AREA}|Residual||`, containerIds: ids(thirty) },
    })
    // The first-generation event still promotes and marks the scheme (D25).
    assert.equal(first.scheme.status, "Scheduled")
    assert.ok(schemeGenerationRecorded(first.scheme))
    const history = generationMatchHistoryOf(first.scheme.submittedValues)
    assert.deepEqual(history.previous, {})
    assert.deepEqual(history.last, first.plan.matches)
    assert.deepEqual(driftWarnings(schemeAttention(first.scheme, related(first.scheme, thirty))), [])
  })

  test("an unchanged set is no drift, and the third identical run writes nothing", () => {
    const first = run(ruleScheme(), thirty, "2026-09-24T06:00:00.000Z")
    const second = run(first.scheme, thirty, "2026-09-25T06:00:00.000Z")
    assert.deepEqual(second.plan.containerDrift, [])
    // The history advances (the previous stamp is now filled)…
    assert.notEqual(second.scheme, first.scheme)
    assert.deepEqual(generationMatchHistoryOf(second.scheme.submittedValues).previous, first.plan.matches)
    // …and once both stamps agree, a run of the same set returns its input.
    const third = run(second.scheme, thirty, "2026-09-26T06:00:00.000Z")
    assert.equal(third.scheme, second.scheme)
    assert.deepEqual(driftWarnings(schemeAttention(third.scheme, related(third.scheme, thirty))), [])
  })

  test("a shift past the threshold is reported by the plan, the run summary and the Attention badge, and clears when the next run matches again", () => {
    const first = run(ruleScheme(), thirty, "2026-09-24T06:00:00.000Z")
    // Four containers join the area: 4 of 30 = 13 %.
    const grown = [...thirty, ...["d01", "d02", "d03", "d04"].map((id) => container(id))]

    // The badge reports runs, not the live base: before the next run it is quiet.
    assert.deepEqual(driftWarnings(schemeAttention(first.scheme, related(first.scheme, grown))), [])

    const second = run(first.scheme, grown, "2026-09-25T06:00:00.000Z")
    assert.equal(second.plan.containerDrift.length, 1)
    assert.deepEqual(second.plan.containerDrift[0].joined, ["d01", "d02", "d03", "d04"])
    assert.deepEqual(second.plan.containerDrift[0].left, [])
    assert.deepEqual(second.result.summary.containerDrift, second.plan.containerDrift)
    const sentence = "Matched containers shifted 13 % since the previous generation run: 4 joined, 0 left of 30"
    assert.equal(containerDriftWarning(second.plan.containerDrift), sentence)

    // The stamped record derives the same sentence from its two stamps alone.
    const attention = schemeAttention(second.scheme, related(second.scheme, grown))
    assert.deepEqual(driftWarnings(attention), [sentence])
    assert.equal(attention[attention.length - 1], sentence, "the drift sentence follows validation's warnings")
    const assessment = schemeLiveAssessment(second.scheme, related(second.scheme, grown))
    assert.deepEqual(assessment?.containerDrift, second.plan.containerDrift)

    // The next run matches the same set again: the Attention clears.
    const third = run(second.scheme, grown, "2026-09-26T06:00:00.000Z")
    assert.deepEqual(third.plan.containerDrift, [])
    assert.deepEqual(driftWarnings(schemeAttention(third.scheme, related(third.scheme, grown))), [])
  })

  test("containers leaving count too: 4 of 30 taken out of service is a drift", () => {
    const first = run(ruleScheme(), thirty, "2026-09-24T06:00:00.000Z")
    const shrunk = thirty.map((record, index) =>
      index < 4 ? { ...record, status: "Defect" } : record,
    )
    const second = run(first.scheme, shrunk, "2026-09-25T06:00:00.000Z")
    assert.equal(
      containerDriftWarning(second.plan.containerDrift),
      "Matched containers shifted 13 % since the previous generation run: 0 joined, 4 left of 30",
    )
  })

  test("a rule edit starts the comparison over: the set matched under the new rule is not drift", () => {
    const first = run(ruleScheme(), thirty, "2026-09-24T06:00:00.000Z")
    const base = [...thirty, ...containersOf(5, "Organic").map((record) => ({ ...record, id: `o-${record.id}` }))]
    const edited: BusinessRecord = {
      ...first.scheme,
      submittedValues: { ...first.scheme.submittedValues, matchFractions: "Organic" },
    }
    const second = run(edited, base, "2026-09-25T06:00:00.000Z")
    assert.deepEqual(second.plan.matches.default.containerIds, base.slice(30).map((record) => record.id).sort())
    assert.deepEqual(second.plan.containerDrift, [])
    assert.deepEqual(driftWarnings(schemeAttention(second.scheme, related(second.scheme, base))), [])
    // Under the new rule, the next run compares normally: 5 → 4 is 20 %.
    const third = run(second.scheme, base.slice(0, 34), "2026-09-26T06:00:00.000Z")
    assert.equal(third.plan.containerDrift.length, 1)
  })

  test("named collection groups are reported one clause each", () => {
    const explicit = ruleScheme({
      stopSelection: "",
      matchFractions: "",
      [COLLECTION_GROUPS_KEY]: JSON.stringify([
        {
          id: "g-residual",
          name: "Residual run",
          days: ["monday", "tuesday", "wednesday", "thursday", "friday"],
          fractions: ["Residual"],
          vehicleId: "vehicle-wh24",
          driverId: "driver-mads",
          stopSource: "rule",
          containerIds: [],
        },
        {
          id: "g-organic",
          name: "Organic run",
          days: ["monday", "tuesday", "wednesday", "thursday", "friday"],
          fractions: ["Organic"],
          vehicleId: "vehicle-wh25",
          driverId: "driver-lars",
          stopSource: "rule",
          containerIds: [],
        },
      ]),
    })
    const organic = containersOf(5, "Organic").map((record) => ({ ...record, id: `o-${record.id}` }))
    const first = run(explicit, [...thirty, ...organic], "2026-09-24T06:00:00.000Z")
    assert.deepEqual(Object.keys(first.plan.matches).sort(), ["g-organic", "g-residual"])
    const moved = [
      ...thirty,
      ...["d01", "d02", "d03", "d04"].map((id) => container(id)),
      ...organic,
      container("o-d01", "Organic"),
      container("o-d02", "Organic"),
    ]
    const second = run(first.scheme, moved, "2026-09-25T06:00:00.000Z")
    assert.equal(
      containerDriftWarning(second.plan.containerDrift),
      "Matched containers shifted since the previous generation run: Residual run 13 % (4 joined, 0 left of 30); Organic run 40 % (2 joined, 0 left of 5)",
    )
  })

  test("a manual scheme has nothing to stamp: no matches, and a recorded scheme is returned as it was", () => {
    const manual = ruleScheme({
      stopSelection: "manual",
      matchFractions: "",
      containerIds: "c01, c02",
      lastGeneratedAt: "2026-09-01T06:00:00.000Z",
    }, "Scheduled")
    const first = run(manual, thirty, "2026-09-24T06:00:00.000Z")
    assert.deepEqual(first.plan.matches, {})
    assert.deepEqual(first.plan.containerDrift, [])
    assert.equal(first.scheme, manual)
    assert.equal(first.scheme.submittedValues?.[LAST_GENERATION_MATCHES_KEY], undefined)
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

/* -------------------------------- Plan Ahead -------------------------------- */

describe("Plan Ahead stamps every run and reports drifted schemes in its summary", () => {
  const thirty = containersOf(30)
  const today = "2026-09-24"
  const armed = ruleScheme(
    { planAhead: true, lastGeneratedAt: "2026-09-01T06:00:00.000Z" },
    "Scheduled",
  )
  const auto = (scheme: BusinessRecord, containers: readonly BusinessRecord[], at: string) =>
    runPlanAhead({
      schemes: [scheme],
      today,
      existingRoutes: [],
      existingPickups: [],
      containers,
      actorName: "Plan Ahead",
      generatedAt: at,
    })

  test("an already-recorded scheme comes back stamped on the first run, drifted on the second, and quiet once the history agrees", () => {
    const first = auto(armed, thirty, "2026-09-24T06:00:00.000Z")
    assert.equal(first.schemes.length, 1)
    assert.deepEqual(first.summary.containerDrift, [])
    assert.deepEqual(
      generationMatchHistoryOf(first.schemes[0].submittedValues).last.default.containerIds,
      ids(thirty),
    )

    const grown = [...thirty, ...["d01", "d02", "d03", "d04"].map((id) => container(id))]
    const second = auto(first.schemes[0], grown, "2026-09-25T06:00:00.000Z")
    assert.equal(second.schemes.length, 1)
    assert.deepEqual(second.summary.containerDrift, [
      {
        schemeId: "scheme-drift",
        schemeName: "RS-Drift",
        warning: "Matched containers shifted 13 % since the previous generation run: 4 joined, 0 left of 30",
      },
    ])

    // The matching run advances the history (one write), then nothing moves.
    const third = auto(second.schemes[0], grown, "2026-09-26T06:00:00.000Z")
    assert.equal(third.schemes.length, 1)
    assert.deepEqual(third.summary.containerDrift, [])
    const fourth = auto(third.schemes[0], grown, "2026-09-27T06:00:00.000Z")
    assert.equal(fourth.schemes.length, 0)
  })
})
