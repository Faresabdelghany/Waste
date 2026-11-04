import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { WEIGHBRIDGE_REFUSALS, WEIGHBRIDGE_TICKET_STATUSES, WEIGHBRIDGE_UNMATCHED_REASONS } from "../vocabulary"
import { fractionNamed, matchTicket, plateKey, possibleDuplicates, type DuplicateCandidate, type MatchFacts } from "../weighbridge"

const facts = (overrides: Partial<MatchFacts> = {}): MatchFacts => ({ vehicleId: "truck", sessionRouteIds: ["route"], dayRouteIds: ["route"], wasteFractionId: "residual", stationTakes: true, ...overrides })

describe("a weighbridge ticket's vocabulary", () => {
  test("is the three statuses, the five reasons a ticket waits for the office, and the two it is not kept for", () => {
    assert.deepEqual([...WEIGHBRIDGE_TICKET_STATUSES], ["matched", "unmatched", "dismissed"])
    assert.deepEqual([...WEIGHBRIDGE_UNMATCHED_REASONS], ["unknown-vehicle", "no-route", "several-routes", "unknown-fraction", "fraction-not-accepted"])
    assert.deepEqual([...WEIGHBRIDGE_REFUSALS], ["unknown-station", "ahead-of-clock"])
  })
})

describe("a plate as the match reads it", () => {
  test("is its letters and digits in upper case, whatever the weighbridge spaced or dashed", () => {
    assert.equal(plateKey("CN 42 018"), "CN42018")
    assert.equal(plateKey(" cn-42-018 "), "CN42018")
    assert.equal(plateKey("æb 12 345"), "ÆB12345")
  })
})

describe("the fraction a ticket names", () => {
  const fractions = [
    { id: "residual", key: "residual", wasteCode: "200301" },
    { id: "glass", key: "glass", wasteCode: "150107" },
    { id: "glass-bottles", key: "glass-bottles", wasteCode: "150107" },
  ]

  test("is the one of its key, else the one fraction filed under its code", () => {
    assert.equal(fractionNamed({ fractionKey: "glass", wasteCode: null }, fractions), "glass")
    assert.equal(fractionNamed({ fractionKey: null, wasteCode: "200301" }, fractions), "residual")
    assert.equal(fractionNamed({ fractionKey: "nothing-here", wasteCode: "200301" }, fractions), "residual", "a key not known falls back to the code")
  })

  test("is none where the code is two fractions' or nobody's", () => {
    assert.equal(fractionNamed({ fractionKey: null, wasteCode: "150107" }, fractions), null)
    assert.equal(fractionNamed({ fractionKey: null, wasteCode: "200108" }, fractions), null)
    assert.equal(fractionNamed({ fractionKey: null, wasteCode: null }, fractions), null)
  })
})

describe("a ticket matched", () => {
  test("is the session's route and the named fraction where the station takes it", () => {
    assert.deepEqual(matchTicket(facts()), { kind: "matched", routeId: "route", wasteFractionId: "residual" })
    assert.deepEqual(matchTicket(facts({ sessionRouteIds: [], dayRouteIds: ["day"] })), { kind: "matched", routeId: "day", wasteFractionId: "residual" }, "no session spans it: the day's one route")
    assert.deepEqual(matchTicket(facts({ sessionRouteIds: ["route"], dayRouteIds: ["route", "other"] })), { kind: "matched", routeId: "route", wasteFractionId: "residual" }, "the session decides over a day of several")
  })

  test("waits for the office with the first reason, in order: the vehicle, the route, the fraction, the station's acceptance", () => {
    const reason = (overrides: Partial<MatchFacts>) => {
      const decision = matchTicket(facts(overrides))
      return decision.kind === "unmatched" ? decision.reason : decision.kind
    }
    assert.equal(reason({ vehicleId: null, sessionRouteIds: [], wasteFractionId: null }), "unknown-vehicle")
    assert.equal(reason({ sessionRouteIds: [], dayRouteIds: [], wasteFractionId: null }), "no-route")
    assert.equal(reason({ sessionRouteIds: [], dayRouteIds: ["a", "b"] }), "several-routes")
    assert.equal(reason({ sessionRouteIds: ["a", "b"] }), "several-routes")
    assert.equal(reason({ wasteFractionId: null, stationTakes: false }), "unknown-fraction")
    assert.equal(reason({ stationTakes: false }), "fraction-not-accepted")
  })
})

describe("possible duplicates", () => {
  const unload = (id: string, overrides: Partial<DuplicateCandidate> = {}): DuplicateCandidate => ({ id, routeId: "route", wasteFractionId: "residual", source: "driver-app", refused: false, settled: false, ...overrides })

  test("are the weighbridge's Unload and one recorded by hand on the same route and fraction, each naming the other", () => {
    const found = possibleDuplicates([unload("driver"), unload("weighed", { source: "integration" }), unload("office", { source: "dispatch" })])
    assert.deepEqual(found.get("weighed"), ["driver", "office"])
    assert.deepEqual(found.get("driver"), ["weighed"])
    assert.deepEqual(found.get("office"), ["weighed"])
  })

  test("are none across routes or fractions, between two recorded by hand, or once one is refused or settled", () => {
    assert.equal(possibleDuplicates([unload("driver"), unload("weighed", { source: "integration", routeId: "other" })]).size, 0)
    assert.equal(possibleDuplicates([unload("driver"), unload("weighed", { source: "integration", wasteFractionId: "glass" })]).size, 0)
    assert.equal(possibleDuplicates([unload("driver"), unload("office", { source: "dispatch" })]).size, 0, "two by hand are two tips, the driver's and the office's capture of another")
    assert.equal(possibleDuplicates([unload("driver", { settled: true }), unload("weighed", { source: "integration" })]).size, 0)
    assert.equal(possibleDuplicates([unload("driver"), unload("weighed", { source: "integration", refused: true })]).size, 0)
  })
})
