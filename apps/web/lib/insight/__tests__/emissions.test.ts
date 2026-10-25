// The Dashboard's Emissions card in words (M10 of #293): the masses a person
// reads, the unmeasured routes by gap, never as zero, and the saving.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { EmissionsReport } from "@waste/contracts/emissions"
import { EMISSION_GAPS } from "@waste/domain/resources/vocabulary"

import { emissionsKey } from "../../api/reports"
import { distanceOf, fractionLabel, GAP_WORDS, massOf, plannedSentence, savingSentence, shareOf, unmeasuredSentence, vehicleLabel } from "../emissions"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"

const report = (values: Partial<EmissionsReport> = {}): EmissionsReport => ({
  window: { projectId: null, from: "2026-11-02", to: "2026-11-08" },
  planned: { routes: 2, metres: 20_000, grams: 23_922 },
  actualGrams: null,
  unmeasured: [],
  byVehicle: [{ vehicleId: ID, callsign: "WH-31", fuel: "diesel", routes: 2, metres: 20_000, grams: 23_922 }],
  byProject: [{ projectId: ID, name: "Copenhagen Central", routes: 2, metres: 20_000, grams: 23_922 }],
  byFraction: [{ wasteFractionId: ID, name: "Glass", grams: 23_922 }],
  saving: { routes: 0, metres: 0, grams: 0 },
  ...values,
})

describe("the masses", () => {
  test("read in grams under a kilogram, kilograms under a tonne, tonnes above, to one decimal", () => {
    assert.equal(massOf(0), "0 g")
    assert.equal(massOf(999), "999 g")
    assert.equal(massOf(23_922), "23.9 kg")
    assert.equal(massOf(1_234_567), "1.2 t")
    // The unit is chosen after the rounding: never "1,000 g" or "1,000 kg".
    assert.equal(massOf(999.4), "999 g")
    assert.equal(massOf(999.6), "1 kg")
    assert.equal(massOf(999_949), "999.9 kg")
    assert.equal(massOf(999_960), "1 t")
    assert.equal(distanceOf(20_000), "20 km")
  })
})

describe("the sentences", () => {
  test("say the planned total, or that no route was measured", () => {
    assert.equal(plannedSentence(report()), "23.9 kg CO₂e over 2 routes and 20 km")
    assert.equal(plannedSentence(report({ planned: { routes: 0, metres: 0, grams: 0 } })), "No route measured in this period")
  })

  test("count the unmeasured by gap in the report's order, never as zero", () => {
    assert.equal(unmeasuredSentence(report()), "")
    assert.equal(
      unmeasuredSentence(report({ unmeasured: [{ gap: "no-plan", routes: 2 }, { gap: "no-factor", routes: 1 }] })),
      "3 routes unmeasured: 2 with no Plan, 1 with no emission factor in force for its fuel",
    )
    assert.deepEqual(Object.keys(GAP_WORDS), [...EMISSION_GAPS], "every gap has its words")
  })

  test("say the saving, or what optimising added where it drove further", () => {
    assert.equal(savingSentence(report()), "")
    assert.equal(savingSentence(report({ saving: { routes: 1, metres: 2_000, grams: 2_392 } })), "Optimising saved 2.4 kg CO₂e and drove 2 km less on 1 route")
    assert.equal(savingSentence(report({ saving: { routes: 2, metres: -1_500, grams: -598 } })), "Optimising added 598 g CO₂e and drove 2 km more on 2 routes")
    // Routes on different fuels: grams saved while the distance grew, each told by its own sign.
    assert.equal(savingSentence(report({ saving: { routes: 2, metres: -3_000, grams: 400 } })), "Optimising saved 400 g CO₂e and drove 3 km more on 2 routes")
  })

  test("label a vehicle by callsign and fuel, and the routes with no counted stop", () => {
    assert.equal(vehicleLabel(report().byVehicle[0]), "WH-31 · Diesel")
    assert.equal(vehicleLabel({ ...report().byVehicle[0], callsign: null, fuel: "hvo" }), "Unnamed vehicle · HVO")
    assert.equal(fractionLabel({ wasteFractionId: null, name: null, grams: 5 }), "Routes with no counted stop")
    assert.equal(shareOf(5, 10), 0.5)
    assert.equal(shareOf(5, 0), 0)
  })

  test("the report the card reads parses as the contracts', and is asked without the window's interval", () => {
    assert.equal(EmissionsReport.safeParse(report()).success, true)
    assert.equal(emissionsKey({ projectId: ID, from: "2026-11-02", to: "2026-11-08", interval: "week" }), `/reports/emissions?projectId=${ID}&from=2026-11-02&to=2026-11-08`)
    assert.equal(emissionsKey({ from: "2026-11-02", to: "2026-11-08", interval: "day" }), "/reports/emissions?from=2026-11-02&to=2026-11-08")
  })
})
