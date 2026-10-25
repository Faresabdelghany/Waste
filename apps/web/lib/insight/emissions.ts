// The Dashboard's Emissions card (M10 of #293) in words: the planned CO₂e of
// the window's routes from `GET /reports/emissions`, the routes it could not
// measure and why, and the optimiser's saving. Grams on the wire; a person
// reads kilograms or tonnes. A route the report could not measure is never
// read as zero: it is counted beside the total, by its first gap.
import type { EmissionGap, EmissionsReport } from "@waste/contracts/emissions"

import { FUEL_LABELS } from "../data/fleet-emissions"

const oneDecimal = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 })
const whole = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 })

/** Grams as a person reads them: grams under a kilogram, kilograms to one decimal under a tonne, tonnes to one decimal above. */
export function massOf(grams: number): string {
  const size = Math.abs(grams)
  if (size < 1_000) return `${whole.format(grams)} g`
  if (size < 1_000_000) return `${oneDecimal.format(grams / 1_000)} kg`
  return `${oneDecimal.format(grams / 1_000_000)} t`
}

/** Metres as kilometres, whole. */
export const distanceOf = (metres: number): string => `${whole.format(metres / 1_000)} km`

/** Each gap as the sentence a route lacking it is told in. */
export const GAP_WORDS: Readonly<Record<EmissionGap, string>> = {
  "no-plan": "no Plan",
  "plan-unmeasured": "a Plan not yet measured",
  "no-vehicle": "no vehicle planned",
  "no-fuel": "a vehicle with no fuel",
  "no-consumption": "no consumption for its vehicle type and fuel",
  "no-factor": "no emission factor in force for its fuel",
}

const routes = (n: number) => (n === 1 ? "1 route" : `${whole.format(n)} routes`)

/** The planned total in a sentence: "1.2 t CO₂e over 34 routes and 812 km". */
export function plannedSentence(report: Pick<EmissionsReport, "planned">): string {
  if (report.planned.routes === 0) return "No route measured in this period"
  return `${massOf(report.planned.grams)} CO₂e over ${routes(report.planned.routes)} and ${distanceOf(report.planned.metres)}`
}

/** The unmeasured routes in a sentence, by gap: "3 routes unmeasured: 2 with no Plan, 1 with no emission factor in force for its fuel". Empty where every route was measured. */
export function unmeasuredSentence(report: Pick<EmissionsReport, "unmeasured">): string {
  const total = report.unmeasured.reduce((sum, gap) => sum + gap.routes, 0)
  if (total === 0) return ""
  return `${routes(total)} unmeasured: ${report.unmeasured.map((gap) => `${whole.format(gap.routes)} with ${GAP_WORDS[gap.gap]}`).join(", ")}`
}

/** The optimiser's saving in a sentence: "Optimising saved 2.4 kg CO₂e and 2 km on 1 route", or what it cost where it drove further. Empty where no route was optimised against a measured baseline. */
export function savingSentence(report: Pick<EmissionsReport, "saving">): string {
  const { saving } = report
  if (saving.routes === 0) return ""
  if (saving.grams >= 0) return `Optimising saved ${massOf(saving.grams)} CO₂e and ${distanceOf(saving.metres)} on ${routes(saving.routes)}`
  return `Optimising added ${massOf(-saving.grams)} CO₂e and ${distanceOf(-saving.metres)} on ${routes(saving.routes)}`
}

/** A vehicle's row label: its callsign and fuel. */
export const vehicleLabel = (row: EmissionsReport["byVehicle"][number]): string => `${row.callsign ?? "Unnamed vehicle"} · ${FUEL_LABELS[row.fuel]}`

/** A fraction's row label: its name, or the routes with no counted stop. */
export const fractionLabel = (row: EmissionsReport["byFraction"][number]): string => row.name ?? "Routes with no counted stop"

/** The share of the whole a row's grams are, for the card's bars: 0..1. */
export const shareOf = (grams: number, total: number): number => (total <= 0 ? 0 : Math.max(0, Math.min(1, grams / total)))
