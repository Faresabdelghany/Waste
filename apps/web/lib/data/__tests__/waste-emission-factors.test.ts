// The waste fractions' emission factors as Settings › Emission factors
// types them (M13 of #293): a form becomes the body the contract takes, or
// the first field the API would refuse in the pane's own sentence; an edit
// moves the end and the source alone; the table's order and sentence.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { WasteFractionEmissionFactorCreate, WasteFractionEmissionFactorPatch, type WasteFractionEmissionFactor } from "@waste/contracts/sustainability"

import { FACTOR_LAST_DAY_SENTENCE, FACTOR_START_SENTENCE, SOURCE_SENTENCE } from "../fleet-emissions"
import {
  AVOIDED_SENTENCE,
  FOOTPRINT_SENTENCE,
  FRACTION_SENTENCE,
  newWasteFactorForm,
  wasteFactorCreateBodyOf,
  wasteFactorFormOf,
  wasteFactorPatchBodyOf,
  wasteFactorSentence,
  wasteFactorsInOrder,
} from "../waste-emission-factors"

const FRACTION = "018f7c35-a000-7000-8000-000000000005"
const filled = { ...newWasteFactorForm("2026-01-01", FRACTION), footprint: "460", avoided: "120", source: "Demo value" }

const factor = (values: Partial<WasteFractionEmissionFactor> = {}): WasteFractionEmissionFactor => ({
  id: "018f7c35-a000-7000-8000-0000000000f1",
  wasteFractionId: FRACTION,
  footprintKgPerTonne: 460,
  avoidedKgPerTonne: 120,
  source: "Demo value",
  validFrom: "2026-01-01",
  validTo: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...values,
})

describe("a waste fraction's emission factor as the pane types it", () => {
  test("becomes the body the contract takes: the fraction, the two numbers, the source and the period, the end the first day out", () => {
    const body = wasteFactorCreateBodyOf({ ...filled, lastDay: "2026-12-31" })
    assert.deepEqual(body, { wasteFractionId: FRACTION, footprintKgPerTonne: 460, avoidedKgPerTonne: 120, source: "Demo value", validFrom: "2026-01-01", validTo: "2027-01-01" })
    assert.ok(WasteFractionEmissionFactorCreate.safeParse(body).success)
    const open = wasteFactorCreateBodyOf({ ...filled, avoided: " " })
    assert.deepEqual(open, { wasteFractionId: FRACTION, footprintKgPerTonne: 460, avoidedKgPerTonne: null, source: "Demo value", validFrom: "2026-01-01" }, "a blank avoided is none, an open period no end")
    assert.ok(WasteFractionEmissionFactorCreate.safeParse(open).success)
  })

  test("is refused at the first field the API would refuse, in the pane's sentence", () => {
    assert.deepEqual(wasteFactorCreateBodyOf({ ...filled, wasteFractionId: "" }), { field: "wasteFractionId", message: FRACTION_SENTENCE })
    assert.deepEqual(wasteFactorCreateBodyOf({ ...filled, footprint: "10001" }), { field: "footprint", message: FOOTPRINT_SENTENCE })
    assert.deepEqual(wasteFactorCreateBodyOf({ ...filled, footprint: "4.6" }), { field: "footprint", message: FOOTPRINT_SENTENCE })
    assert.deepEqual(wasteFactorCreateBodyOf({ ...filled, avoided: "-1" }), { field: "avoided", message: AVOIDED_SENTENCE })
    assert.deepEqual(wasteFactorCreateBodyOf({ ...filled, source: "  " }), { field: "source", message: SOURCE_SENTENCE })
    assert.deepEqual(wasteFactorCreateBodyOf({ ...filled, validFrom: "" }), { field: "validFrom", message: FACTOR_START_SENTENCE })
    assert.deepEqual(wasteFactorCreateBodyOf({ ...filled, lastDay: "2025-12-31" }), { field: "lastDay", message: FACTOR_LAST_DAY_SENTENCE })
    assert.equal(WasteFractionEmissionFactorCreate.safeParse({ ...wasteFactorCreateBodyOf(filled), footprintKgPerTonne: 10_001 }).success, false, "the bound is the contract's")
  })

  test("an edit moves the end and the source alone, and nothing moved is no patch", () => {
    const form = wasteFactorFormOf(factor())
    assert.deepEqual(form, { wasteFractionId: FRACTION, footprint: "460", avoided: "120", source: "Demo value", validFrom: "2026-01-01", lastDay: "" })
    assert.equal(wasteFactorPatchBodyOf(factor(), form), null)
    const ended = wasteFactorPatchBodyOf(factor(), { ...form, lastDay: "2026-06-30", source: "Danish EPA 2026" })
    assert.deepEqual(ended, { source: "Danish EPA 2026", validTo: "2026-07-01" })
    assert.ok(WasteFractionEmissionFactorPatch.safeParse(ended).success)
    assert.deepEqual(wasteFactorPatchBodyOf(factor({ validTo: "2026-07-01" }), { ...wasteFactorFormOf(factor({ validTo: "2026-07-01" })), lastDay: "" }), { validTo: null }, "a cleared end reopens it")
    assert.deepEqual(wasteFactorPatchBodyOf(factor(), { ...form, source: "" }), { field: "source", message: SOURCE_SENTENCE })
  })

  test("reads as kilograms per tonne with what it avoids, and lists by fraction name, the latest start first", () => {
    assert.equal(wasteFactorSentence(factor()), "460 kg CO₂e per t, 120 kg avoided")
    assert.equal(wasteFactorSentence(factor({ footprintKgPerTonne: 1_200, avoidedKgPerTonne: null })), "1,200 kg CO₂e per t")
    const names: Record<string, string> = { a: "Residual waste", b: "Glass" }
    const ordered = wasteFactorsInOrder([factor({ id: "1", wasteFractionId: "a" }), factor({ id: "2", wasteFractionId: "b", validFrom: "2025-01-01" }), factor({ id: "3", wasteFractionId: "b", validFrom: "2026-01-01" })], (id) => names[id] ?? id)
    assert.deepEqual(ordered.map((row) => row.id), ["3", "2", "1"])
  })
})
