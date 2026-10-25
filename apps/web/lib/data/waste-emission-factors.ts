// The waste fractions' emission factors on the web (M13 of #293): the
// kilograms of CO₂e a tonne of a fraction emits once treated, and those it
// avoids where its treatment displaces anything, each over a period, which a
// Customer's sustainability report is measured by — read and written through
// `/waste-fraction-emission-factors` under master data's grants, as the
// fuels' factors beside them are (fleet-emissions.ts, whose period rules and
// sentences these share). A factor's fraction, its numbers and its start are
// its period's own: the edit moves its end and its source, and a revised
// number is the next period's factor.
import type { WasteFractionEmissionFactor, WasteFractionEmissionFactorCreate, WasteFractionEmissionFactorPatch } from "@waste/contracts/sustainability"
import { KG_PER_TONNE_MAX } from "@waste/domain/insight/sustainability"

import { lastDayIn } from "../api/records/planning"
import { FACTOR_LAST_DAY_SENTENCE, FACTOR_START_SENTENCE, factorEndOf, SOURCE_SENTENCE } from "./fleet-emissions"

/** A factor as the form holds it: the fraction by server id, the two numbers and the source as typed, the period's two ends, the last day in force for the end. */
export type WasteFactorForm = { wasteFractionId: string; footprint: string; avoided: string; source: string; validFrom: string; lastDay: string }

export type WasteFactorField = keyof WasteFactorForm
export type WasteFactorRefusal = { field: WasteFactorField; message: string }
export const isWasteFactorRefusal = (value: object): value is WasteFactorRefusal => "field" in value && "message" in value

export const FRACTION_SENTENCE = "Pick the waste fraction the factor is for"
export const FOOTPRINT_SENTENCE = `Give the kilograms of CO₂e a tonne emits as a whole number from 0 to ${KG_PER_TONNE_MAX.toLocaleString("en-GB")}`
export const AVOIDED_SENTENCE = `Give the kilograms of CO₂e a tonne avoids as a whole number from 0 to ${KG_PER_TONNE_MAX.toLocaleString("en-GB")}, or leave it blank where its treatment displaces nothing`

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

/** A typed whole number of kilograms per tonne, NaN for anything else. */
const kgPerTonneOf = (typed: string): number => (/^\d+$/.test(typed.trim()) ? Number(typed.trim()) : Number.NaN)
const inRange = (value: number): boolean => value >= 0 && value <= KG_PER_TONNE_MAX

/** A new factor's form: the fraction given, from the day given, its numbers and its source to be typed. */
export const newWasteFactorForm = (today: string, wasteFractionId = ""): WasteFactorForm => ({ wasteFractionId, footprint: "", avoided: "", source: "", validFrom: today, lastDay: "" })

/** A factor's form as it stands, for its edit. */
export const wasteFactorFormOf = (factor: WasteFractionEmissionFactor): WasteFactorForm => ({
  wasteFractionId: factor.wasteFractionId,
  footprint: String(factor.footprintKgPerTonne),
  avoided: factor.avoidedKgPerTonne === null ? "" : String(factor.avoidedKgPerTonne),
  source: factor.source,
  validFrom: factor.validFrom,
  lastDay: factor.validTo === null ? "" : lastDayIn(factor.validTo),
})

/** The end a form spells, as the wire's first day out, or the refusal: the fuels' rule (`factorEndOf`). */
function endOf(form: WasteFactorForm, validFrom: string): string | null | WasteFactorRefusal {
  const end = factorEndOf(form.lastDay, validFrom)
  return end === undefined ? { field: "lastDay", message: FACTOR_LAST_DAY_SENTENCE } : end
}

/** The body a new factor's form becomes, or the first field the API would refuse. */
export function wasteFactorCreateBodyOf(form: WasteFactorForm): WasteFractionEmissionFactorCreate | WasteFactorRefusal {
  if (form.wasteFractionId.trim() === "") return { field: "wasteFractionId", message: FRACTION_SENTENCE }
  const footprint = kgPerTonneOf(form.footprint)
  if (!inRange(footprint)) return { field: "footprint", message: FOOTPRINT_SENTENCE }
  const avoided = form.avoided.trim() === "" ? null : kgPerTonneOf(form.avoided)
  if (avoided !== null && !inRange(avoided)) return { field: "avoided", message: AVOIDED_SENTENCE }
  const source = form.source.trim()
  if (source === "") return { field: "source", message: SOURCE_SENTENCE }
  const validFrom = form.validFrom.trim()
  if (!ISO_DAY.test(validFrom)) return { field: "validFrom", message: FACTOR_START_SENTENCE }
  const validTo = endOf(form, validFrom)
  if (validTo !== null && typeof validTo === "object") return validTo
  return { wasteFractionId: form.wasteFractionId, footprintKgPerTonne: footprint, avoidedKgPerTonne: avoided, source, validFrom, ...(validTo === null ? {} : { validTo }) }
}

/** The patch an edited form becomes — the end and the source alone, where they moved — null where nothing moved, or the refusal. */
export function wasteFactorPatchBodyOf(factor: WasteFractionEmissionFactor, form: WasteFactorForm): WasteFractionEmissionFactorPatch | WasteFactorRefusal | null {
  const source = form.source.trim()
  if (source === "") return { field: "source", message: SOURCE_SENTENCE }
  const validTo = endOf(form, factor.validFrom)
  if (validTo !== null && typeof validTo === "object") return validTo
  const patch: WasteFractionEmissionFactorPatch = { ...(source === factor.source ? {} : { source }), ...(validTo === factor.validTo ? {} : { validTo }) }
  return Object.keys(patch).length === 0 ? null : patch
}

/** A factor's numbers as a person reads them: "460 kg CO₂e per t", and what it avoids where it says. */
export const wasteFactorSentence = (factor: Pick<WasteFractionEmissionFactor, "footprintKgPerTonne" | "avoidedKgPerTonne">): string =>
  `${factor.footprintKgPerTonne.toLocaleString("en-GB")} kg CO₂e per t${factor.avoidedKgPerTonne === null ? "" : `, ${factor.avoidedKgPerTonne.toLocaleString("en-GB")} kg avoided`}`

/** The factors in the order the pane lists them: by fraction name, the latest start first. */
export const wasteFactorsInOrder = (factors: readonly WasteFractionEmissionFactor[], nameOf: (wasteFractionId: string) => string): WasteFractionEmissionFactor[] =>
  [...factors].sort((a, b) => nameOf(a.wasteFractionId).localeCompare(nameOf(b.wasteFractionId)) || (a.validFrom === b.validFrom ? a.id.localeCompare(b.id) : a.validFrom < b.validFrom ? 1 : -1))
