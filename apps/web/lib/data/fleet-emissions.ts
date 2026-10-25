// The fleet's emissions on the web (M10 of #293). A vehicle type's
// consumption is typed per fuel in the units a person reads off a fuel bill —
// litres, kilograms or kilowatt-hours per 100 km, to one decimal — and goes
// out in the wire's whole thousandths of the unit per kilometre, which is the
// same number times ten (`PUT /vehicle-types/:id/consumption`,
// @waste/contracts/emissions). The factors and the report are read and
// written by their own panes; the sentences they share live here.
import type { FuelEmissionFactor, FuelEmissionFactorCreate, FuelEmissionFactorPatch, VehicleTypeConsumption } from "@waste/contracts/emissions"
import { FUEL_UNIT, GRAMS_PER_UNIT_MAX, MILLI_UNITS_PER_KM_MAX } from "@waste/domain/resources/emissions"
import { FUEL_TYPES, type EnergyUnit, type FuelType } from "@waste/domain/resources/vocabulary"

import { allows, type Grants } from "../api/grants"
import { fuelLabel } from "./resources-vocabulary"
import { firstDayOut, lastDayIn } from "../api/records/planning"

/** What a person calls each fuel: the vehicle form's own words (`fuelLabel`). */
export const FUEL_LABELS: Readonly<Record<FuelType, string>> = Object.fromEntries(FUEL_TYPES.map((fuel) => [fuel, fuelLabel(fuel)])) as Record<FuelType, string>

/** The unit a fuel's factor and consumption are given in, as it is written after a number: `l`, `kg`, `kWh`. */
export const unitWordOf = (fuel: FuelType): string => UNIT_WORDS[FUEL_UNIT[fuel]]

/** A unit as it is written after a number. */
export const UNIT_WORDS: Readonly<Record<EnergyUnit, string>> = { litre: "l", kg: "kg", kwh: "kWh" }

/** One consumption field of a vehicle type's form: its fuel, its id and its label with the unit. */
export type ConsumptionField = { fuel: FuelType; id: string; label: string }

export const CONSUMPTION_FIELDS: readonly ConsumptionField[] = FUEL_TYPES.map((fuel) => ({ fuel, id: `consumption-${fuel}`, label: `${FUEL_LABELS[fuel]} · ${UNIT_WORDS[FUEL_UNIT[fuel]]} per 100 km` }))

/** The most a type may burn per 100 km, the wire's bound in the form's units. */
const PER_HUNDRED_MAX = MILLI_UNITS_PER_KM_MAX / 10

export const CONSUMPTION_REFUSAL = `Give what it burns per 100 km as a number from 0.1 to ${PER_HUNDRED_MAX.toLocaleString("en-GB")}, to one decimal place`

/** A typed amount per 100 km as the wire's thousandths per km, null for blank, NaN for anything the wire would refuse. A comma decimal reads as a point. */
export function milliUnitsOf(typed: string | undefined): number | null {
  const text = (typed ?? "").trim().replace(",", ".")
  if (text === "") return null
  if (!/^\d+(\.\d)?$/.test(text)) return Number.NaN
  const milli = Math.round(Number(text) * 10)
  return milli >= 1 && milli <= MILLI_UNITS_PER_KM_MAX ? milli : Number.NaN
}

/** The wire's thousandths per km as the form spells it per 100 km: `45`, `45.5`. */
export const perHundredOf = (milliUnitsPerKm: number): string => (milliUnitsPerKm % 10 === 0 ? String(milliUnitsPerKm / 10) : (milliUnitsPerKm / 10).toFixed(1))

/** The form's text per fuel field, from a type's consumption: what the edit form opens on. */
export function consumptionValues(consumption: readonly Pick<VehicleTypeConsumption, "fuel" | "milliUnitsPerKm">[]): Record<string, string> {
  return Object.fromEntries(consumption.map((entry) => [`consumption-${entry.fuel}`, perHundredOf(entry.milliUnitsPerKm)]))
}

/** The set the fields spell, in fuel order, and the fields the wire would refuse. */
export function consumptionOf(values: Readonly<Record<string, unknown>> | undefined): { entries: { fuel: FuelType; milliUnitsPerKm: number }[]; errors: Record<string, string> } {
  const entries: { fuel: FuelType; milliUnitsPerKm: number }[] = []
  const errors: Record<string, string> = {}
  for (const field of CONSUMPTION_FIELDS) {
    const typed = values?.[field.id]
    const milli = milliUnitsOf(typeof typed === "string" ? typed : undefined)
    if (milli === null) continue
    if (Number.isNaN(milli)) errors[field.id] = CONSUMPTION_REFUSAL
    else entries.push({ fuel: field.fuel, milliUnitsPerKm: milli })
  }
  return { entries, errors }
}

/** Whether two sets name the same amount per fuel, whatever their order. */
export const sameConsumption = (a: readonly { fuel: string; milliUnitsPerKm: number }[], b: readonly { fuel: string; milliUnitsPerKm: number }[]): boolean => {
  const spell = (set: readonly { fuel: string; milliUnitsPerKm: number }[]) =>
    set
      .map((entry) => `${entry.fuel}:${entry.milliUnitsPerKm}`)
      .sort()
      .join(",")
  return spell(a) === spell(b)
}

/** A type's consumption in a sentence: "Diesel 45 l · Electric 130 kWh per 100 km". */
export function consumptionSentence(consumption: readonly { fuel: FuelType; milliUnitsPerKm: number }[]): string {
  if (consumption.length === 0) return "No consumption: its routes are unmeasured"
  return `${consumption.map((entry) => `${FUEL_LABELS[entry.fuel]} ${perHundredOf(entry.milliUnitsPerKm)} ${UNIT_WORDS[FUEL_UNIT[entry.fuel]]}`).join(" · ")} per 100 km`
}

// ---------------------------------------------------------------------------
// Settings › Operations › Emission factors
// ---------------------------------------------------------------------------

/** The pane, offered on the Pilot alone: the factors are the API's. */
export const EMISSION_FACTORS_SETTINGS_PANE_ID = "emission-factors"

/** A factor as the form holds it: the fuel, the grams per unit and the source as typed, the period's two ends, the last day in force for the end. */
export type FactorForm = { fuel: FuelType; gramsPerUnit: string; source: string; validFrom: string; lastDay: string }

export type FactorField = keyof FactorForm
export type FactorRefusal = { field: FactorField; message: string }
export const isFactorRefusal = (value: object): value is FactorRefusal => "field" in value && "message" in value

export const GRAMS_SENTENCE = `Give the grams of CO₂e per unit as a whole number from 0 to ${GRAMS_PER_UNIT_MAX.toLocaleString("en-GB")}`
export const SOURCE_SENTENCE = "Say where the number comes from: the published list and its year, or that it is a demo value"
export const FACTOR_START_SENTENCE = "Give the first day the factor is in force"
export const FACTOR_LAST_DAY_SENTENCE = "The last day in force comes on or after the first"

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

/** A new factor's form: diesel from the day given, its number and its source to be typed. */
export const newFactorForm = (today: string): FactorForm => ({ fuel: "diesel", gramsPerUnit: "", source: "", validFrom: today, lastDay: "" })

/** A factor's form as it stands, for its edit. */
export const factorFormOf = (factor: FuelEmissionFactor): FactorForm => ({
  fuel: factor.fuel,
  gramsPerUnit: String(factor.gramsPerUnit),
  source: factor.source,
  validFrom: factor.validFrom,
  lastDay: factor.validTo === null ? "" : lastDayIn(factor.validTo),
})

/** The end a factor's form spells by its last day in force, as the wire's first day out: null for none, undefined where the day will not do. The waste fractions' factors read it too (waste-emission-factors.ts). */
export function factorEndOf(lastDay: string, validFrom: string): string | null | undefined {
  const day = lastDay.trim()
  if (day === "") return null
  if (!ISO_DAY.test(day) || day < validFrom) return undefined
  return firstDayOut(day)
}

/** The end a form spells, as the wire's first day out, or the refusal. */
function endOf(form: FactorForm, validFrom: string): string | null | FactorRefusal {
  const end = factorEndOf(form.lastDay, validFrom)
  return end === undefined ? { field: "lastDay", message: FACTOR_LAST_DAY_SENTENCE } : end
}

/** A factor's period as a pane's table reads it: "From 2025-01-01", or its first and last day in force. */
export const factorPeriodLabel = (factor: { validFrom: string; validTo: string | null }): string => (factor.validTo === null ? `From ${factor.validFrom}` : `${factor.validFrom} to ${lastDayIn(factor.validTo)}`)

/** The body a new factor's form becomes, or the first field the API would refuse. */
export function factorCreateBodyOf(form: FactorForm): FuelEmissionFactorCreate | FactorRefusal {
  const typed = form.gramsPerUnit.trim()
  const grams = /^\d+$/.test(typed) ? Number(typed) : Number.NaN
  if (!(grams >= 0 && grams <= GRAMS_PER_UNIT_MAX)) return { field: "gramsPerUnit", message: GRAMS_SENTENCE }
  const source = form.source.trim()
  if (source === "") return { field: "source", message: SOURCE_SENTENCE }
  const validFrom = form.validFrom.trim()
  if (!ISO_DAY.test(validFrom)) return { field: "validFrom", message: FACTOR_START_SENTENCE }
  const validTo = endOf(form, validFrom)
  if (validTo !== null && typeof validTo === "object") return validTo
  return { fuel: form.fuel, gramsPerUnit: grams, source, validFrom, ...(validTo === null ? {} : { validTo }) }
}

/** The patch an edited form becomes — the end and the source alone, where they moved — null where nothing moved, or the refusal. */
export function factorPatchBodyOf(factor: FuelEmissionFactor, form: FactorForm): FuelEmissionFactorPatch | FactorRefusal | null {
  const source = form.source.trim()
  if (source === "") return { field: "source", message: SOURCE_SENTENCE }
  const validTo = endOf(form, factor.validFrom)
  if (validTo !== null && typeof validTo === "object") return validTo
  const patch: FuelEmissionFactorPatch = { ...(source === factor.source ? {} : { source }), ...(validTo === factor.validTo ? {} : { validTo }) }
  return Object.keys(patch).length === 0 ? null : patch
}

/** A factor's number as a person reads it: "2,658 g CO₂e per l". */
export const factorSentence = (factor: Pick<FuelEmissionFactor, "fuel" | "gramsPerUnit">): string => `${factor.gramsPerUnit.toLocaleString("en-GB")} g CO₂e per ${UNIT_WORDS[FUEL_UNIT[factor.fuel]]}`

/** The factors in the order the pane lists them: by fuel as the vocabulary orders them, the latest start first. */
export const factorsInOrder = (factors: readonly FuelEmissionFactor[]): FuelEmissionFactor[] =>
  [...factors].sort((a, b) => FUEL_TYPES.indexOf(a.fuel) - FUEL_TYPES.indexOf(b.fuel) || (a.validFrom === b.validFrom ? a.id.localeCompare(b.id) : a.validFrom < b.validFrom ? 1 : -1))

/** What the role lets a person do with the factors: master data's grants, the API's for them. */
export const factorAccessOf = (grants: Grants | undefined) => ({
  view: allows(grants, "configure.master", "view"),
  create: allows(grants, "configure.master", "create"),
  edit: allows(grants, "configure.master", "edit"),
})
