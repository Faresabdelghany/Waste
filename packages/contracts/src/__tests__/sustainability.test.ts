// The sustainability report on the wire (M13 of #293): a fraction's emission
// factor, kilograms per tonne within the domain's bound, with its source and
// an ordered period, its patch the end and the source alone; the report's
// query, one Customer over a bounded window of operating days, and its file's
// separator; and the report's shape, CO₂e null where it is unknown and the
// rate null where nothing was weighed.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { KG_PER_TONNE_MAX } from "@waste/domain/insight/sustainability"

import { SustainabilityFileQuery, SustainabilityReport, SustainabilityReportQuery, WasteFractionEmissionFactor, WasteFractionEmissionFactorCreate, WasteFractionEmissionFactorPatch, WeightBasis } from "../sustainability"
import { refusal, refusesAnEmptyPatch, refusesWhatTheServerOwns } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const STAMPS = { createdAt: "2026-10-25T09:00:00.000Z", updatedAt: "2026-10-25T09:00:00.000Z" }
const SOURCE = "A national register of waste emission factors, 2025 edition"
const create = { wasteFractionId: ID, footprintKgPerTonne: 30, avoidedKgPerTonne: 120, source: SOURCE, validFrom: "2026-01-01" }

describe("a fraction's emission factor", () => {
  test("takes whole kilograms per tonne from zero to the domain's bound, the avoided figure optional, and a source", () => {
    assert.deepEqual(WasteFractionEmissionFactorCreate.parse(create), create)
    assert.equal(WasteFractionEmissionFactorCreate.parse({ ...create, footprintKgPerTonne: 0, avoidedKgPerTonne: null }).footprintKgPerTonne, 0, "zero is a factor")
    for (const footprintKgPerTonne of [-1, KG_PER_TONNE_MAX + 1, 1.5]) assert.equal(WasteFractionEmissionFactorCreate.safeParse({ ...create, footprintKgPerTonne }).success, false, String(footprintKgPerTonne))
    assert.deepEqual(refusal(WasteFractionEmissionFactorCreate.safeParse({ ...create, source: undefined }))[0]?.path, "source")
    assert.equal(WasteFractionEmissionFactorCreate.safeParse({ ...create, validTo: "2026-01-01" }).success, false, "the end comes after the start")
    refusesWhatTheServerOwns(WasteFractionEmissionFactorCreate, create)
  })

  test("a patch moves the end and the source alone: the fraction, the figures and the start are the period's own", () => {
    assert.deepEqual(WasteFractionEmissionFactorPatch.parse({ validTo: "2027-01-01" }), { validTo: "2027-01-01" })
    assert.deepEqual(WasteFractionEmissionFactorPatch.parse({ validTo: null }), { validTo: null })
    refusesAnEmptyPatch(WasteFractionEmissionFactorPatch)
    assert.equal(WasteFractionEmissionFactorPatch.safeParse({ footprintKgPerTonne: 31 }).success, false)
  })

  test("reads back as stored, the avoided figure null where nothing is displaced", () => {
    const factor = { id: ID, ...STAMPS, ...create, avoidedKgPerTonne: null, validTo: null }
    assert.deepEqual(WasteFractionEmissionFactor.parse(factor), factor)
  })
})

describe("the report's query", () => {
  test("is one Customer over an ordered window of operating days within the reports' bound", () => {
    assert.deepEqual(SustainabilityReportQuery.parse({ customerId: ID, from: "2026-01-01", to: "2026-12-31" }), { customerId: ID, from: "2026-01-01", to: "2026-12-31" })
    assert.equal(SustainabilityReportQuery.safeParse({ from: "2026-01-01", to: "2026-12-31" }).success, false, "a Customer is named")
    assert.deepEqual(refusal(SustainabilityReportQuery.safeParse({ customerId: ID, from: "2026-02-01", to: "2026-01-31" }))[0]?.path, "to")
    assert.equal(SustainabilityReportQuery.safeParse({ customerId: ID, from: "2026-01-01", to: "2028-01-01" }).success, false, "a year at a time")
  })

  test("the file's takes a separator, commas when absent", () => {
    assert.equal(SustainabilityFileQuery.parse({ customerId: ID, from: "2026-01-01", to: "2026-01-31" }).separator, "comma")
    assert.equal(SustainabilityFileQuery.parse({ customerId: ID, from: "2026-01-01", to: "2026-01-31", separator: "semicolon" }).separator, "semicolon")
  })
})

describe("the report", () => {
  test("names the bases best first, and carries a line's CO₂e and the rate as null where unknown", () => {
    assert.deepEqual([...WeightBasis.options], ["measured", "apportioned", "estimated", "unmeasured"])
    const report = {
      window: { customerId: ID, from: "2026-01-01", to: "2026-12-31" },
      sites: [
        {
          propertyId: ID,
          sharedCollectionPointId: null,
          name: "Parkvej 18",
          address: "Parkvej 18, 2100 København Ø",
          lines: [{ wasteFractionId: ID, name: "Glass", treatment: null, kg: { measured: 40, apportioned: 0, estimated: 0 }, stops: { measured: 1, apportioned: 0, estimated: 0, unmeasured: 2 }, footprintGrams: null, avoidedGrams: null }],
          notAttributedStops: 1,
        },
      ],
      totals: { weighedKg: 40, recycledKg: 0, recyclingRate: 0, footprintGrams: 0, avoidedGrams: 0, unmeasuredStops: 2 },
      warnings: [{ kind: "no-treatment", wasteFractionId: ID, name: "Glass" }],
    }
    assert.deepEqual(SustainabilityReport.parse(report), report)
    assert.equal(SustainabilityReport.parse({ ...report, sites: [], totals: { ...report.totals, weighedKg: 0, recyclingRate: null } }).totals.recyclingRate, null)
    assert.equal(SustainabilityReport.safeParse({ ...report, totals: { ...report.totals, recyclingRate: 1.2 } }).success, false)
    assert.equal(SustainabilityReport.parse({ ...report, totals: { ...report.totals, footprintGrams: null, avoidedGrams: null } }).totals.footprintGrams, null, "unknown where a line's is")
  })
})
