// The fleet's emissions on the web (M10 of #293). A vehicle type's
// consumption is typed per fuel in the units a person reads off a fuel bill —
// litres, kilograms or kilowatt-hours per 100 km, to one decimal — and goes
// out in the wire's whole thousandths of the unit per kilometre, which is the
// same number times ten (`PUT /vehicle-types/:id/consumption`,
// @waste/contracts/emissions). The factors and the report are read and
// written by their own panes; the sentences they share live here.
import type { VehicleTypeConsumption } from "@waste/contracts/emissions"
import { FUEL_UNIT, MILLI_UNITS_PER_KM_MAX } from "@waste/domain/resources/emissions"
import { FUEL_TYPES, type EnergyUnit, type FuelType } from "@waste/domain/resources/vocabulary"

/** What a person calls each fuel. */
export const FUEL_LABELS: Readonly<Record<FuelType, string>> = { diesel: "Diesel", hvo: "HVO", biogas: "Biogas", electric: "Electric", hybrid: "Hybrid", other: "Other fuel" }

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
