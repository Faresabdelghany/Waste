// The fleet's emissions on the wire (M10 of #293): a factor's and a
// consumption's whole-number bounds, the factor's period and its patch, the
// consumption set's one entry per fuel, and the report's window.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { GRAMS_PER_UNIT_MAX, MILLI_UNITS_PER_KM_MAX } from "@waste/domain/resources/emissions"
import { EMISSION_GAPS, ENERGY_UNITS, FUEL_TYPES } from "@waste/domain/resources/vocabulary"

import {
  EACH_FUEL_ONCE,
  EmissionGap,
  EmissionsReport,
  EmissionsReportQuery,
  EnergyUnit,
  FuelEmissionFactor,
  FuelEmissionFactorCreate,
  FuelEmissionFactorListQuery,
  FuelEmissionFactorPatch,
  VehicleTypeConsumptionSet,
} from "../emissions"
import { REPORT_WINDOW_TOO_LONG } from "../reports"
import { ENDS_AFTER_IT_STARTS } from "../validity"
import { VehicleType } from "../vehicle-types"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const STAMPS = { id: ID, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }
const DIESEL = { fuel: "diesel", gramsPerUnit: 2658, source: "Energistyrelsen, standard factors for 2025", validFrom: "2025-01-01" } as const

const issues = (result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) => (result.error?.issues ?? []).map((issue) => [issue.path.join("."), issue.message])

describe("the vocabularies", () => {
  test("the units and the gaps are the domain's", () => {
    assert.deepEqual(EnergyUnit.options, [...ENERGY_UNITS])
    assert.deepEqual(EmissionGap.options, [...EMISSION_GAPS])
  })
})

describe("a factor", () => {
  test("is created with its fuel, its grams, its source and its period, the end left open", () => {
    assert.deepEqual(FuelEmissionFactorCreate.parse(DIESEL), DIESEL)
    assert.equal(FuelEmissionFactorCreate.safeParse({ ...DIESEL, validTo: "2026-01-01" }).success, true)
  })

  test("is whole grams from zero to the domain's bound: zero is a fuel counted as nothing burnt", () => {
    assert.equal(FuelEmissionFactorCreate.safeParse({ ...DIESEL, gramsPerUnit: 0 }).success, true)
    assert.equal(FuelEmissionFactorCreate.safeParse({ ...DIESEL, gramsPerUnit: GRAMS_PER_UNIT_MAX }).success, true)
    for (const gramsPerUnit of [-1, GRAMS_PER_UNIT_MAX + 1, 2.5]) assert.equal(FuelEmissionFactorCreate.safeParse({ ...DIESEL, gramsPerUnit }).success, false, String(gramsPerUnit))
  })

  test("names a fuel of the vocabulary, gives a source, and ends after it starts", () => {
    assert.equal(FuelEmissionFactorCreate.safeParse({ ...DIESEL, fuel: "petrol" }).success, false)
    assert.equal(FuelEmissionFactorCreate.safeParse({ ...DIESEL, source: " " }).success, false)
    assert.deepEqual(issues(FuelEmissionFactorCreate.safeParse({ ...DIESEL, validTo: "2025-01-01" })), [["validTo", ENDS_AFTER_IT_STARTS]])
  })

  test("refuses a member the server owns, the unit among them", () => {
    assert.equal(FuelEmissionFactorCreate.safeParse({ ...DIESEL, unit: "litre" }).success, false)
  })

  test("is patched in its end and its source alone: the fuel, the number and the start are the period's", () => {
    assert.equal(FuelEmissionFactorPatch.safeParse({ validTo: "2026-01-01" }).success, true)
    assert.equal(FuelEmissionFactorPatch.safeParse({ validTo: null }).success, true)
    assert.equal(FuelEmissionFactorPatch.safeParse({ source: "Corrected citation" }).success, true)
    for (const body of [{ gramsPerUnit: 2700 }, { fuel: "hvo" }, { validFrom: "2025-02-01" }]) assert.equal(FuelEmissionFactorPatch.safeParse(body).success, false, JSON.stringify(body))
    assert.equal(FuelEmissionFactorPatch.safeParse({}).success, false)
  })

  test("reads back with the fuel's unit, and lists by fuel and by the day in force", () => {
    assert.equal(FuelEmissionFactor.safeParse({ ...STAMPS, ...DIESEL, unit: "litre", validTo: null }).success, true)
    assert.equal(FuelEmissionFactorListQuery.safeParse({ fuel: "diesel", validOn: "2025-06-01" }).success, true)
  })
})

describe("a vehicle type's consumption", () => {
  test("is a set of one entry per fuel, whole thousandths of the unit per kilometre from one to the bound", () => {
    assert.equal(VehicleTypeConsumptionSet.safeParse({ consumption: [{ fuel: "diesel", milliUnitsPerKm: 450 }, { fuel: "electric", milliUnitsPerKm: 1300 }] }).success, true)
    assert.equal(VehicleTypeConsumptionSet.safeParse({ consumption: [] }).success, true)
    for (const milliUnitsPerKm of [0, MILLI_UNITS_PER_KM_MAX + 1, 1.5]) assert.equal(VehicleTypeConsumptionSet.safeParse({ consumption: [{ fuel: "diesel", milliUnitsPerKm }] }).success, false, String(milliUnitsPerKm))
  })

  test("names each fuel once", () => {
    const twice = VehicleTypeConsumptionSet.safeParse({ consumption: [{ fuel: "diesel", milliUnitsPerKm: 450 }, { fuel: "diesel", milliUnitsPerKm: 460 }] })
    assert.deepEqual(issues(twice), [["consumption", EACH_FUEL_ONCE]])
  })

  test("is at most one entry for every fuel there is", () => {
    const every = FUEL_TYPES.map((fuel) => ({ fuel, milliUnitsPerKm: 400 }))
    assert.equal(VehicleTypeConsumptionSet.safeParse({ consumption: every }).success, true)
    assert.equal(VehicleTypeConsumptionSet.safeParse({ consumption: [...every, every[0]] }).success, false)
  })

  test("rides on the vehicle type, each entry with its fuel's unit", () => {
    const type = { ...STAMPS, key: "rear-loader", name: "Rear loader", description: null, containerTypeIds: [], consumption: [{ fuel: "diesel", unit: "litre", milliUnitsPerKm: 450 }], checklist: [] }
    assert.equal(VehicleType.safeParse(type).success, true)
  })
})

describe("the report", () => {
  test("is asked over a window of operating days, one project's or every one of the caller's, with no series", () => {
    assert.equal(EmissionsReportQuery.safeParse({ from: "2026-01-01", to: "2026-12-31" }).success, true)
    assert.equal(EmissionsReportQuery.safeParse({ projectId: ID, from: "2026-01-01", to: "2026-01-31" }).success, true)
    assert.equal(EmissionsReportQuery.safeParse({ from: "2026-01-01", to: "2026-01-31", interval: "day" }).success, false)
  })

  test("refuses a window running backwards or longer than a year", () => {
    assert.equal(EmissionsReportQuery.safeParse({ from: "2026-02-01", to: "2026-01-31" }).success, false)
    assert.deepEqual(issues(EmissionsReportQuery.safeParse({ from: "2025-01-01", to: "2026-01-02" })), [["to", REPORT_WINDOW_TOO_LONG]])
  })

  test("answers the planned totals, the unmeasured by gap, the groups, the split by stops and the saving, the actual null until O8", () => {
    const report = {
      window: { projectId: null, from: "2026-01-01", to: "2026-01-31" },
      planned: { routes: 2, metres: 30_000, grams: 35_883 },
      actualGrams: null,
      unmeasured: [{ gap: "no-consumption", routes: 1 }],
      byVehicle: [{ vehicleId: ID, callsign: "WH-31", fuel: "diesel", routes: 2, metres: 30_000, grams: 35_883 }],
      byProject: [{ projectId: ID, name: "Copenhagen Central", routes: 2, metres: 30_000, grams: 35_883 }],
      byFraction: [{ wasteFractionId: ID, name: "Glass", grams: 35_883 }],
      saving: { routes: 1, metres: -500, grams: -598 },
    }
    assert.equal(EmissionsReport.safeParse(report).success, true)
  })
})
