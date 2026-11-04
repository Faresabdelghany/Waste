import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { linesIssue, netOf, registeredTare, SCALE_TICKET_LINES_MAX, tareKeyOf } from "../rules"

describe("a ticket's net", () => {
  test("is the gross less the tare, and nothing where the tare is not less", () => {
    assert.equal(netOf(12_340, 8_120), 4_220)
    assert.equal(netOf(8_120, 8_120), null)
    assert.equal(netOf(8_000, 8_120), null)
  })
})

describe("a ticket's lines", () => {
  const line = (wasteFractionId: string, netKg: number, originMunicipality: string | null = null) => ({ wasteFractionId, netKg, originMunicipality })

  test("hold where they sum to the net, each fraction and origin once", () => {
    assert.equal(linesIssue([line("a", 3_000, "0101"), line("a", 1_220, "0147")], 4_220), null)
    assert.equal(linesIssue([line("a", 4_220)], 4_220), null)
  })

  test("are refused empty, repeated, off the net, or from an origin that is not a kommunekode", () => {
    assert.deepEqual(linesIssue([], 4_220), { kind: "no-lines" })
    assert.deepEqual(linesIssue([line("a", 2_000, "0101"), line("a", 2_220, "0101")], 4_220), { kind: "repeated", index: 1 })
    assert.deepEqual(linesIssue([line("a", 2_000), line("b", 2_000)], 4_220), { kind: "sum", sum: 4_000, netKg: 4_220 })
    assert.deepEqual(linesIssue([line("a", 4_220, "101")], 4_220), { kind: "bad-origin", index: 0 })
  })

  test("are bounded", () => {
    assert.equal(SCALE_TICKET_LINES_MAX, 20)
  })
})

describe("a registered tare", () => {
  const register = [
    { id: "lorry", plate: "CN 42 018", trailerPlate: null, containerRef: null },
    { id: "lorry-skip", plate: "CN 42 018", trailerPlate: null, containerRef: "SK-7" },
    { id: "lorry-trailer", plate: "CN 42 018", trailerPlate: "TR 11 002", containerRef: null },
  ]

  test("is found by the plate, the trailer and the container together, as the match reads a plate", () => {
    assert.equal(registeredTare(register, { plate: "cn 42-018", trailerPlate: null, containerRef: null })?.id, "lorry")
    assert.equal(registeredTare(register, { plate: "CN42018", trailerPlate: null, containerRef: "sk 7" })?.id, "lorry-skip")
    assert.equal(registeredTare(register, { plate: "CN42018", trailerPlate: "tr11002", containerRef: null })?.id, "lorry-trailer")
  })

  test("is not another combination's", () => {
    assert.equal(registeredTare(register, { plate: "CN42018", trailerPlate: "TR11002", containerRef: "SK7" }), undefined)
    assert.equal(registeredTare(register, { plate: "XY 1", trailerPlate: null, containerRef: null }), undefined)
  })

  test("keys an empty reference as none", () => {
    assert.equal(tareKeyOf(" - "), null)
    assert.equal(tareKeyOf(undefined), null)
    assert.equal(tareKeyOf("sk-7"), "SK7")
  })
})
