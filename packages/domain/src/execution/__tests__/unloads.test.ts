// The weighbridge in the office (O9 of #290): a load the station refuses,
// with its reason; the fraction an accepted unload may be of; and the
// tolerance between what the stops weighed on board and what the weighbridge
// says.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { DEFAULT_WEIGHT_TOLERANCE_PERCENT, doesNotTake, loadReading, onBoardByUnload, refusalIssue, SAY_WHY_REFUSED, takesNoneSet, unloadNotAccepted } from "../unloads"
import { UNLOAD_REFUSAL_REASONS } from "../vocabulary"

describe("a refused load", () => {
  test("says why the station refused it, from a closed list", () => {
    assert.deepEqual([...UNLOAD_REFUSAL_REASONS], ["contamination", "fraction-not-accepted", "hazardous", "overweight", "other"])
  })

  test("says it in words where the reason is other, and may anywhere; a note goes with a reason", () => {
    assert.equal(refusalIssue({ reason: "contamination", note: null }), undefined)
    assert.equal(refusalIssue({ reason: "contamination", note: "Plastic bags in the paper" }), undefined)
    assert.deepEqual(refusalIssue({ reason: "other", note: null }), { path: "note", message: SAY_WHY_REFUSED })
    assert.equal(SAY_WHY_REFUSED, "Say why the station refused the load")
    assert.deepEqual(refusalIssue({ reason: null, note: "Looked fine" }), { path: "reason", message: "A note goes with a refusal's reason" })
    assert.equal(refusalIssue({ reason: null, note: null }), undefined, "an accepted load")
  })
})

describe("an accepted unload's fraction", () => {
  test("is one the station takes, or it is told which it does not, or that the station names none", () => {
    assert.equal(doesNotTake("ARC Amager", "Glass"), "Station ARC Amager does not take Glass")
    assert.equal(takesNoneSet("Amager Bakke"), "Station Amager Bakke has no accepted fractions set")
  })

  test("recorded by the driver all the same: the load is tipped, so the office is given a task in the station's sentence", () => {
    assert.deepEqual(unloadNotAccepted({ stationName: "ARC Amager", fractionName: "Glass", routeLabel: "RC-1042", netKg: 8240, recordedAt: "10:12", stationTakesAny: true }), {
      kind: "internal-task",
      priority: "medium",
      subject: "Unload of Glass at ARC Amager on RC-1042 not accepted",
      description: "The driver recorded 8,240 kg of Glass at ARC Amager on route RC-1042 at 10:12, but Station ARC Amager does not take Glass. Check the station's accepted fractions, or review the unload in weight control.",
    })
    assert.match(unloadNotAccepted({ stationName: "Amager Bakke", fractionName: "Glass", routeLabel: "RC-1042", netKg: 900, recordedAt: "10:12", stationTakesAny: false }).description, /but Station Amager Bakke has no accepted fractions set\. Set them/)
  })
})

describe("the load on board against the weighbridge", () => {
  const at = (time: string) => `2026-10-05T${time}:00.000Z`

  test("each unload weighs what the stops of its fraction weighed since the route's previous unload of that fraction", () => {
    const unloads = [
      { id: "u1", wasteFractionId: "residual", occurredAt: at("10:00"), refused: false },
      { id: "u2", wasteFractionId: "residual", occurredAt: at("14:00"), refused: false },
      { id: "u3", wasteFractionId: "paper", occurredAt: at("14:30"), refused: false },
    ]
    const weights = [
      { wasteFractionId: "residual", occurredAt: at("08:00"), weightKg: 3000 },
      { wasteFractionId: "residual", occurredAt: at("09:59"), weightKg: 1000 },
      { wasteFractionId: "residual", occurredAt: at("10:00"), weightKg: 500 },
      { wasteFractionId: "residual", occurredAt: at("11:00"), weightKg: 2000 },
      { wasteFractionId: "paper", occurredAt: at("12:00"), weightKg: 800 },
      { wasteFractionId: "residual", occurredAt: at("15:00"), weightKg: 999 },
    ]
    assert.deepEqual(onBoardByUnload(unloads, weights), new Map([
      ["u1", 4500],
      ["u2", 2000],
      ["u3", 800],
    ]), "a weight at the unload's instant is in it; one after the last unload is in none")
  })

  test("a refused load stays on board: the next unload of the fraction carries it too", () => {
    const unloads = [
      { id: "refused", wasteFractionId: "paper", occurredAt: at("10:00"), refused: true },
      { id: "tipped", wasteFractionId: "paper", occurredAt: at("11:00"), refused: false },
    ]
    const weights = [{ wasteFractionId: "paper", occurredAt: at("09:00"), weightKg: 1200 }]
    assert.deepEqual(onBoardByUnload(unloads, weights), new Map([
      ["refused", 1200],
      ["tipped", 1200],
    ]))
  })

  test("a correction, made at the instant of the unload it corrects, reads the same load on board", () => {
    const unloads = [
      { id: "u1", wasteFractionId: "paper", occurredAt: at("10:00"), refused: false },
      { id: "u1-corrected", wasteFractionId: "paper", occurredAt: at("10:00"), refused: false },
      { id: "u2", wasteFractionId: "paper", occurredAt: at("12:00"), refused: false },
    ]
    const weights = [
      { wasteFractionId: "paper", occurredAt: at("09:00"), weightKg: 1200 },
      { wasteFractionId: "paper", occurredAt: at("11:00"), weightKg: 700 },
    ]
    assert.deepEqual(onBoardByUnload(unloads, weights), new Map([
      ["u1", 1200],
      ["u1-corrected", 1200],
      ["u2", 700],
    ]))
  })

  test("an unload with no stop weighed before it has no load on board to compare", () => {
    assert.deepEqual(onBoardByUnload([{ id: "u1", wasteFractionId: "glass", occurredAt: at("10:00"), refused: false }], []), new Map())
  })

  test("reads the difference from the on-board load, within the project's tolerance or above it", () => {
    assert.equal(DEFAULT_WEIGHT_TOLERANCE_PERCENT, 5)
    assert.deepEqual(loadReading({ netKg: 8240, onBoardKg: 7644 }, 5), { onBoardKg: 7644, deviationPercent: 7.8, withinTolerance: false })
    assert.deepEqual(loadReading({ netKg: 4810, onBoardKg: 4753 }, 5), { onBoardKg: 4753, deviationPercent: 1.2, withinTolerance: true })
    assert.deepEqual(loadReading({ netKg: 950, onBoardKg: 1000 }, 5), { onBoardKg: 1000, deviationPercent: -5, withinTolerance: true }, "the bound itself is within")
    assert.equal(loadReading({ netKg: 950, onBoardKg: undefined }, 5), null, "nothing weighed on board, nothing to compare")
    // The bound is judged on the weights themselves, never on the rounded figure, and the figure rounds half away from zero.
    assert.deepEqual(loadReading({ netKg: 1899, onBoardKg: 2000 }, 5), { onBoardKg: 2000, deviationPercent: -5.1, withinTolerance: false }, "5.05% under is over the 5%")
    assert.deepEqual(loadReading({ netKg: 2101, onBoardKg: 2000 }, 5), { onBoardKg: 2000, deviationPercent: 5.1, withinTolerance: false }, "and 5.05% over, alike")
    assert.deepEqual(loadReading({ netKg: 2626, onBoardKg: 2500 }, 5), { onBoardKg: 2500, deviationPercent: 5, withinTolerance: false }, "5.04% shows as 5.0 and is still over")
  })
})
