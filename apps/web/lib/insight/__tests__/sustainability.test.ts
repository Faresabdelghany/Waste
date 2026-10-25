// What a Customer's sustainability report reads as on the web (M13 of #293):
// its figures in a person's words, a figure the report could not give said
// rather than shown as nought, the warnings in the domain's sentences, and
// the window and the file and print addresses the section asks with.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { SustainabilityLine, SustainabilityReport, SustainabilitySite } from "@waste/contracts/sustainability"
import { sustainabilityWarningSentence } from "@waste/domain/insight/sustainability"

import {
  basisOf,
  co2eOf,
  notAttributedOf,
  rateOf,
  reportShowsAny,
  stopsOf,
  sustainabilityFileName,
  sustainabilityPrintHref,
  sustainabilityReadable,
  totalsOf,
  treatmentOf,
  warningsOf,
  weighedKg,
  WINDOW_TOO_LONG,
  windowRefusal,
} from "../sustainability"

const line = (values: Partial<SustainabilityLine> = {}): SustainabilityLine => ({
  wasteFractionId: "fraction-1",
  name: "Residual waste",
  treatment: "energy-recovery",
  kg: { measured: 30, apportioned: 100, estimated: 0 },
  stops: { measured: 1, apportioned: 3, estimated: 0, unmeasured: 2 },
  footprintGrams: 13_600,
  avoidedGrams: 0,
  ...values,
})

const site = (values: Partial<SustainabilitySite> = {}): SustainabilitySite => ({ propertyId: "property-1", sharedCollectionPointId: null, name: "Parkvej 18", address: "Parkvej 18, 2100 København Ø", lines: [line()], notAttributedStops: 0, ...values })

const report = (values: Partial<SustainabilityReport> = {}): SustainabilityReport => ({
  window: { customerId: "customer-1", from: "2025-01-01", to: "2025-12-31" },
  sites: [site()],
  totals: { weighedKg: 1_300, recycledKg: 812, recyclingRate: 0.6246, footprintGrams: 2_400_000, avoidedGrams: 12_000, unmeasuredStops: 2 },
  warnings: [],
  ...values,
})

describe("a Customer's sustainability report on the web", () => {
  test("is read under the customers' grant and the stops', both", () => {
    const grant = (moduleKey: string) => ({ moduleKey, actions: ["view"] })
    assert.equal(sustainabilityReadable([grant("customers.contacts"), grant("route-studio.pickups")]), true)
    assert.equal(sustainabilityReadable([grant("customers.contacts")]), false)
    assert.equal(sustainabilityReadable(undefined), false)
  })

  test("says CO₂e in kilograms to one decimal, in tonnes from a tonne up, and not reported where a factor was missing", () => {
    assert.deepEqual([co2eOf(13_600), co2eOf(0), co2eOf(999_999), co2eOf(2_400_000), co2eOf(null)], ["13.6 kg CO₂e", "0 kg CO₂e", "1,000 kg CO₂e", "2.4 t CO₂e", "Not reported"])
  })

  test("says the rate to a tenth of a percent, and nothing weighed rather than nought", () => {
    assert.deepEqual([rateOf(0.6246), rateOf(1), rateOf(0), rateOf(null)], ["62.5%", "100%", "0%", "Nothing weighed"])
  })

  test("says how a line was weighed, best first, and counts its stops weighed or not", () => {
    assert.equal(basisOf(line()), "30 kg measured, 100 kg apportioned, 2 stops unmeasured")
    assert.equal(basisOf(line({ kg: { measured: 0, apportioned: 0, estimated: 1_500 }, stops: { measured: 0, apportioned: 0, estimated: 4, unmeasured: 1 } })), "1.5 t estimated, 1 stop unmeasured")
    assert.equal(basisOf(line({ kg: { measured: 0, apportioned: 0, estimated: 0 }, stops: { measured: 0, apportioned: 0, estimated: 0, unmeasured: 0 } })), "Nothing weighed")
    assert.deepEqual([weighedKg(line()), stopsOf(line())], [130, 6])
  })

  test("names a treatment, and a fraction with none as not recorded", () => {
    assert.deepEqual([treatmentOf(line()), treatmentOf(line({ treatment: null })), treatmentOf(line({ treatment: "reuse" }))], ["Energy recovery", "Not recorded", "Reuse"])
  })

  test("says what a site's stops without a container were, and nothing where there were none", () => {
    assert.equal(notAttributedOf(site()), null)
    assert.equal(notAttributedOf(site({ notAttributedStops: 1 })), "1 stop here had no container, so no agreement: not in these figures")
  })

  test("reads the headline figures, the unmeasured stops only where there were any", () => {
    assert.deepEqual(totalsOf(report()), { weighed: "1.3 t", rate: "62.5%", footprint: "2.4 t CO₂e", avoided: "12 kg CO₂e", unmeasured: "2 stops had no weight to report: counted, not weighed" })
    assert.equal(totalsOf(report({ totals: { ...report().totals, unmeasuredStops: 0, recyclingRate: null, footprintGrams: null } })).unmeasured, null)
  })

  test("words the warnings as the domain and the file do, in the report's order", () => {
    const warned = report({ warnings: [{ kind: "no-treatment", wasteFractionId: "glass", name: "Glass" }, { kind: "no-factor", wasteFractionId: "residual", name: "Residual waste" }] })
    assert.deepEqual(warningsOf(warned), [
      { key: "no-treatment-glass", sentence: sustainabilityWarningSentence("no-treatment", "Glass") },
      { key: "no-factor-residual", sentence: sustainabilityWarningSentence("no-factor", "Residual waste") },
    ])
  })

  test("shows a report with a line or an unattributed stop, and none for a window with nothing", () => {
    assert.equal(reportShowsAny(report()), true)
    assert.equal(reportShowsAny(report({ sites: [site({ lines: [], notAttributedStops: 2 })] })), true)
    assert.equal(reportShowsAny(report({ sites: [] })), false)
  })

  test("holds a window to the report's rule in a report's words, and spells the file's name and the printable page's address", () => {
    assert.equal(windowRefusal({ from: "2025-01-01", to: "2025-12-31" }), null)
    assert.equal(windowRefusal({ from: "2024-01-01", to: "2025-06-30" }), WINDOW_TOO_LONG)
    assert.equal(windowRefusal({ from: "2025-06-01", to: "2025-01-01" }), "The period's last day comes on or after its first")
    const query = { customerId: "0190-a", from: "2025-01-01", to: "2025-12-31" }
    assert.equal(sustainabilityFileName(null, query), "sustainability-2025-01-01-2025-12-31.csv")
    assert.equal(sustainabilityFileName("from-the-api.csv", query), "from-the-api.csv")
    assert.equal(sustainabilityPrintHref("0190-a", query), "/customers/0190-a/sustainability?from=2025-01-01&to=2025-12-31")
  })
})
