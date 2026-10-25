// The fleet's emissions on the web (M10 of #293): a vehicle type's
// consumption typed per 100 km and sent in the wire's thousandths per km, and
// Settings › Operations › Emission factors' form — the bodies it becomes held
// to the contracts, refused where the API would refuse them, at the field.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { FuelEmissionFactorCreate, FuelEmissionFactorPatch, VehicleTypeConsumptionSet, type FuelEmissionFactor } from "@waste/contracts/emissions"
import { FUEL_TYPES } from "@waste/domain/resources/vocabulary"

import {
  CONSUMPTION_FIELDS,
  CONSUMPTION_REFUSAL,
  consumptionOf,
  consumptionSentence,
  consumptionValues,
  FACTOR_LAST_DAY_SENTENCE,
  factorAccessOf,
  factorCreateBodyOf,
  factorFormOf,
  factorPatchBodyOf,
  factorSentence,
  factorsInOrder,
  GRAMS_SENTENCE,
  milliUnitsOf,
  newFactorForm,
  perHundredOf,
  sameConsumption,
  SOURCE_SENTENCE,
} from "../fleet-emissions"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const STAMPS = { createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }
const diesel = (values: Partial<FuelEmissionFactor> = {}): FuelEmissionFactor => ({ id: ID, ...STAMPS, fuel: "diesel", unit: "litre", gramsPerUnit: 2658, source: "Energistyrelsen, 2025 list", validFrom: "2025-01-01", validTo: null, ...values })

describe("a vehicle type's consumption", () => {
  test("offers a field per fuel, in the vocabulary's order, each labelled with its unit per 100 km", () => {
    assert.deepEqual(CONSUMPTION_FIELDS.map((field) => field.fuel), [...FUEL_TYPES])
    assert.deepEqual(CONSUMPTION_FIELDS.map((field) => field.label), ["Diesel · l per 100 km", "HVO · l per 100 km", "Biogas · kg per 100 km", "Electric · kWh per 100 km", "Hybrid · l per 100 km", "Other fuel · l per 100 km"])
  })

  test("is typed per 100 km to one decimal, a comma read as a point, and sent as thousandths per km: ten times the number", () => {
    assert.equal(milliUnitsOf("45"), 450)
    assert.equal(milliUnitsOf("45.5"), 455)
    assert.equal(milliUnitsOf("45,5"), 455)
    assert.equal(milliUnitsOf("0.1"), 1)
    assert.equal(milliUnitsOf("1000"), 10_000)
    assert.equal(milliUnitsOf(""), null)
    assert.equal(milliUnitsOf(undefined), null)
    for (const typed of ["0", "0.0", "1000.1", "45.55", "-1", "45 l", "lots"]) assert.ok(Number.isNaN(milliUnitsOf(typed)), typed)
  })

  test("reads back as the form spells it, whole where it is", () => {
    assert.equal(perHundredOf(450), "45")
    assert.equal(perHundredOf(455), "45.5")
    assert.equal(perHundredOf(1), "0.1")
    assert.deepEqual(consumptionValues([{ fuel: "diesel", milliUnitsPerKm: 450 }, { fuel: "electric", milliUnitsPerKm: 1300 }]), { "consumption-diesel": "45", "consumption-electric": "130" })
  })

  test("is the set the contracts take, in fuel order, with each refusal at its field", () => {
    const { entries, errors } = consumptionOf({ "consumption-electric": "130", "consumption-diesel": "45.5", "consumption-hvo": "0" })
    assert.deepEqual(entries, [{ fuel: "diesel", milliUnitsPerKm: 455 }, { fuel: "electric", milliUnitsPerKm: 1300 }])
    assert.deepEqual(errors, { "consumption-hvo": CONSUMPTION_REFUSAL })
    assert.ok(VehicleTypeConsumptionSet.safeParse({ consumption: entries }).success)
    assert.deepEqual(consumptionOf({}), { entries: [], errors: {} })
  })

  test("is the same set whatever its order", () => {
    assert.equal(sameConsumption([{ fuel: "diesel", milliUnitsPerKm: 450 }, { fuel: "hvo", milliUnitsPerKm: 440 }], [{ fuel: "hvo", milliUnitsPerKm: 440 }, { fuel: "diesel", milliUnitsPerKm: 450 }]), true)
    assert.equal(sameConsumption([{ fuel: "diesel", milliUnitsPerKm: 450 }], [{ fuel: "diesel", milliUnitsPerKm: 451 }]), false)
    assert.equal(sameConsumption([], []), true)
  })

  test("is said in a sentence, or that its routes are unmeasured", () => {
    assert.equal(consumptionSentence([{ fuel: "diesel", milliUnitsPerKm: 455 }, { fuel: "biogas", milliUnitsPerKm: 400 }]), "Diesel 45.5 l · Biogas 40 kg per 100 km")
    assert.equal(consumptionSentence([]), "No consumption: its routes are unmeasured")
  })
})

describe("a factor's form", () => {
  test("a new one becomes the contracts' create, an open end left out", () => {
    const body = factorCreateBodyOf({ ...newFactorForm("2026-01-01"), gramsPerUnit: "2658", source: "  Energistyrelsen, 2025 list " })
    assert.deepEqual(body, { fuel: "diesel", gramsPerUnit: 2658, source: "Energistyrelsen, 2025 list", validFrom: "2026-01-01" })
    assert.ok(FuelEmissionFactorCreate.safeParse(body).success)
  })

  test("names zero, a fuel counted as nothing burnt, and an end as the first day out", () => {
    const body = factorCreateBodyOf({ fuel: "hvo", gramsPerUnit: "0", source: "Demo value", validFrom: "2026-01-01", lastDay: "2026-12-31" })
    assert.deepEqual(body, { fuel: "hvo", gramsPerUnit: 0, source: "Demo value", validFrom: "2026-01-01", validTo: "2027-01-01" })
    assert.ok(FuelEmissionFactorCreate.safeParse(body).success)
  })

  test("refuses at the field what the contracts refuse", () => {
    const form = { ...newFactorForm("2026-01-01"), gramsPerUnit: "2658", source: "List" }
    for (const gramsPerUnit of ["", "-1", "2.5", "10001", "lots"]) assert.deepEqual(factorCreateBodyOf({ ...form, gramsPerUnit }), { field: "gramsPerUnit", message: GRAMS_SENTENCE }, gramsPerUnit)
    assert.deepEqual(factorCreateBodyOf({ ...form, source: "  " }), { field: "source", message: SOURCE_SENTENCE })
    assert.deepEqual(factorCreateBodyOf({ ...form, lastDay: "2025-12-31" }), { field: "lastDay", message: FACTOR_LAST_DAY_SENTENCE })
    assert.equal(FuelEmissionFactorCreate.safeParse({ fuel: "diesel", gramsPerUnit: 10_001, source: "List", validFrom: "2026-01-01" }).success, false)
  })

  test("an edit opens on the factor, its end as the last day in, and patches the end and the source alone", () => {
    const ended = diesel({ validTo: "2026-01-01" })
    assert.deepEqual(factorFormOf(ended), { fuel: "diesel", gramsPerUnit: "2658", source: "Energistyrelsen, 2025 list", validFrom: "2025-01-01", lastDay: "2025-12-31" })
    assert.equal(factorPatchBodyOf(ended, factorFormOf(ended)), null)
    const reopened = factorPatchBodyOf(ended, { ...factorFormOf(ended), lastDay: "" })
    assert.deepEqual(reopened, { validTo: null })
    assert.ok(FuelEmissionFactorPatch.safeParse(reopened).success)
    const resourced = factorPatchBodyOf(diesel(), { ...factorFormOf(diesel()), source: "Energistyrelsen, corrected", lastDay: "2025-12-31" })
    assert.deepEqual(resourced, { source: "Energistyrelsen, corrected", validTo: "2026-01-01" })
    assert.ok(FuelEmissionFactorPatch.safeParse(resourced).success)
    // The number is the period's own: a form that typed another one patches nothing of it.
    assert.equal(factorPatchBodyOf(diesel(), { ...factorFormOf(diesel()), gramsPerUnit: "2700" }), null)
    assert.deepEqual(factorPatchBodyOf(diesel(), { ...factorFormOf(diesel()), lastDay: "2024-12-31" }), { field: "lastDay", message: FACTOR_LAST_DAY_SENTENCE })
  })

  test("reads its number with its fuel's unit, and lists by fuel then the latest start", () => {
    assert.equal(factorSentence(diesel()), "2,658 g CO₂e per l")
    assert.equal(factorSentence({ fuel: "electric", gramsPerUnit: 120 }), "120 g CO₂e per kWh")
    const older = diesel({ id: "01a0d3a5-e5e0-7000-8000-000000000002", validFrom: "2024-01-01", validTo: "2025-01-01" })
    const hvo = diesel({ id: "01a0d3a5-e5e0-7000-8000-000000000003", fuel: "hvo", unit: "litre", gramsPerUnit: 0 })
    assert.deepEqual(factorsInOrder([hvo, older, diesel()]).map((factor) => factor.id), [ID, older.id, hvo.id])
  })

  test("is read and written under master data's grants", () => {
    assert.deepEqual(factorAccessOf([{ moduleKey: "configure.master", actions: ["view", "edit"] }]), { view: true, create: false, edit: true })
    assert.deepEqual(factorAccessOf(undefined), { view: false, create: false, edit: false })
  })
})
