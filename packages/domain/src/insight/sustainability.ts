// The customer sustainability report (M13 of #293): how much of a Customer's
// waste was collected over a window, at which of their sites and of which
// fraction, how it was weighed, how much of it was recycled, and what it
// emitted and avoided. Like every report it stores nothing; this module is
// its rules, the API reads the rows.
//
// A stop is weighed best first (`WEIGHT_BASES`): by its own weight proof
// where the driver weighed it; else by its share of its route's unloaded
// kilograms of its fraction, what the weighbridge saw less the measured
// stops' own, shared over the route's other completed stops of the fraction
// by container volume (M10's `splitByStops`, the largest remainder in whole
// numbers, so the shares sum to the kilograms exactly and a tie always goes
// to the earlier stop); a stop whose share comes to nothing is not weighed
// as zero but falls to the next basis; else by its container's volume times its
// fraction's density, where one is known (`expectedKg`, O10 of #290's
// expected weight); else not at all. An unmeasured stop is
// counted beside the figures and never weighed as zero.
//
// The recycling rate is the reused and recycled kilograms over every weighed
// kilogram: a fraction with no treatment set counts as not recycled, and the
// report says which (`no-treatment`). CO₂e is whole grams: a tonne's
// kilograms times kilograms per tonne is grams, exactly. A fraction with no
// factor in force on a stop's day is reported without CO₂e (`no-factor`),
// never as zero, and so are the totals: a sum missing a line would read as
// the whole.
import { expectedKg } from "../execution/workload"
import { csvField } from "../imports/csv"
import { splitByStops } from "../resources/emissions"
import type { WasteTreatment } from "../registry/vocabulary"
import { rate } from "./readings"
import type { SustainabilityWarningKind, WeightBasis } from "./vocabulary"

/** A completed stop as the report weighs it: its route and fraction, its container's volume, its own latest weight, and its fraction's density where one is known. */
export type StopToWeigh = {
  id: string
  routeId: string
  wasteFractionId: string
  volumeLitres: number | null
  measuredKg: number | null
  densityKgPerCubicMetre: number | null
}

/** The kilograms a route unloaded of a fraction, counted: neither rejected nor superseded by a correction. */
export type RouteUnloaded = { routeId: string; wasteFractionId: string; netKg: number }

/** A stop's weight and how it was found; `kg` is null exactly when it is unmeasured. */
export type StopWeight = { kg: number | null; basis: WeightBasis }

/**
 * Every stop's weight, by the bases best first. A route's unloaded
 * kilograms of a fraction, less its measured stops' own, are shared over
 * its other stops of the fraction by container volume — equally where any
 * of them has no volume recorded. Where the measured stops account for all
 * the weighbridge saw, nothing is left to share, and the others are not
 * apportioned a zero: they fall to the next basis.
 */
export function weighStops(stops: readonly StopToWeigh[], unloaded: readonly RouteUnloaded[]): Map<string, StopWeight> {
  const weights = new Map<string, StopWeight>()
  const unloadedKg = new Map<string, number>()
  for (const row of unloaded) unloadedKg.set(keyOf(row), (unloadedKg.get(keyOf(row)) ?? 0) + row.netKg)
  const groups = new Map<string, StopToWeigh[]>()
  for (const stop of stops) {
    const group = groups.get(keyOf(stop))
    if (group === undefined) groups.set(keyOf(stop), [stop])
    else group.push(stop)
  }
  for (const [key, group] of groups) {
    const measured = group.filter((stop) => stop.measuredKg !== null)
    for (const stop of measured) weights.set(stop.id, { kg: stop.measuredKg, basis: "measured" })
    const others = group.filter((stop) => stop.measuredKg === null)
    const left = (unloadedKg.get(key) ?? 0) - measured.reduce((acc, stop) => acc + (stop.measuredKg ?? 0), 0)
    const byVolume = others.every((stop) => stop.volumeLitres !== null && stop.volumeLitres > 0)
    const shares = unloadedKg.has(key) && left > 0 ? splitByStops(left, new Map(others.map((stop) => [stop.id, byVolume ? (stop.volumeLitres as number) : 1]))) : new Map<string, number>()
    for (const stop of others) {
      const share = shares.get(stop.id) ?? 0
      if (share > 0) {
        weights.set(stop.id, { kg: share, basis: "apportioned" })
        continue
      }
      const kg = expectedKg(stop)
      weights.set(stop.id, kg === null ? { kg: null, basis: "unmeasured" } : { kg, basis: "estimated" })
    }
  }
  return weights
}

const keyOf = (row: { routeId: string; wasteFractionId: string }) => `${row.routeId}|${row.wasteFractionId}`

/** The bound on a factor, kilograms CO₂e per tonne: ten tonnes of CO₂e per tonne of waste is beyond any published figure, so a larger number is a typing slip. */
export const KG_PER_TONNE_MAX = 10_000

/** A fraction's emission factor over its half-open period (ADR-0005): kilograms CO₂e per tonne its treatment emits, and per tonne it avoids where it avoids any. */
export type FractionFactor = { wasteFractionId: string; footprintKgPerTonne: number; avoidedKgPerTonne: number | null; validFrom: string; validTo: string | null }

/** The factor in force for the fraction on the day, or undefined; periods of one fraction never overlap, which the database holds. */
export function fractionFactorInForce(factors: readonly FractionFactor[], wasteFractionId: string, day: string): FractionFactor | undefined {
  return factors.find((factor) => factor.wasteFractionId === wasteFractionId && factor.validFrom <= day && (factor.validTo === null || day < factor.validTo))
}

/** Grams CO₂e of `kg` kilograms at `kgPerTonne` kilograms per tonne: exact, since a kilogram is a thousandth of a tonne and a gram a thousandth of a kilogram. */
export const gramsOf = (kg: number, kgPerTonne: number): number => kg * kgPerTonne

/** Whether a treatment counts towards the recycling rate: reuse and recycling, composting and digestion among it. */
export const recycles = (treatment: WasteTreatment | null): boolean => treatment === "reuse" || treatment === "recycling"

/** A Customer's stop as the report sums it: where it was, what it held, on which day, and its weight. */
export type CustomerStop = { siteKey: string; wasteFractionId: string; day: string; weight: StopWeight }

/** One site's fraction in the report. */
export type FractionLine = {
  siteKey: string
  wasteFractionId: string
  treatment: WasteTreatment | null
  kg: Record<Exclude<WeightBasis, "unmeasured">, number>
  stops: Record<WeightBasis, number>
  footprintGrams: number | null
  avoidedGrams: number | null
}

export type SustainabilityWarning = { kind: SustainabilityWarningKind; wasteFractionId: string }

/** The report's totals; the CO₂e null where any line's is, since a sum missing a line would read as the whole. */
export type SustainabilityTotals = { weighedKg: number; recycledKg: number; recyclingRate: number | null; footprintGrams: number | null; avoidedGrams: number | null; unmeasuredStops: number }

/**
 * The report's lines, one per site and fraction in the order first met, its
 * totals and its warnings. A line's CO₂e is null where any of its weighed
 * stops had no factor in force on its day, since a partial sum would read as
 * the whole; the totals' CO₂e is null likewise where any line's is, and the
 * warning names the fraction.
 */
export function sustainabilityLines(stops: readonly CustomerStop[], treatments: ReadonlyMap<string, WasteTreatment | null>, factors: readonly FractionFactor[]): { lines: FractionLine[]; totals: SustainabilityTotals; warnings: SustainabilityWarning[] } {
  const lines = new Map<string, FractionLine>()
  const unfactored = new Set<string>()
  for (const stop of stops) {
    const key = `${stop.siteKey}|${stop.wasteFractionId}`
    let line = lines.get(key)
    if (line === undefined) {
      line = { siteKey: stop.siteKey, wasteFractionId: stop.wasteFractionId, treatment: treatments.get(stop.wasteFractionId) ?? null, kg: { measured: 0, apportioned: 0, estimated: 0 }, stops: { measured: 0, apportioned: 0, estimated: 0, unmeasured: 0 }, footprintGrams: 0, avoidedGrams: 0 }
      lines.set(key, line)
    }
    line.stops[stop.weight.basis] += 1
    if (stop.weight.basis === "unmeasured" || stop.weight.kg === null) continue
    line.kg[stop.weight.basis] += stop.weight.kg
    const factor = fractionFactorInForce(factors, stop.wasteFractionId, stop.day)
    if (factor === undefined) {
      unfactored.add(stop.wasteFractionId)
      line.footprintGrams = null
      line.avoidedGrams = null
      continue
    }
    if (line.footprintGrams !== null) line.footprintGrams += gramsOf(stop.weight.kg, factor.footprintKgPerTonne)
    if (line.avoidedGrams !== null) line.avoidedGrams += gramsOf(stop.weight.kg, factor.avoidedKgPerTonne ?? 0)
  }
  const all = [...lines.values()]
  const weighed = (line: FractionLine) => line.kg.measured + line.kg.apportioned + line.kg.estimated
  const weighedKg = all.reduce((acc, line) => acc + weighed(line), 0)
  const recycledKg = all.filter((line) => recycles(line.treatment)).reduce((acc, line) => acc + weighed(line), 0)
  const totals: SustainabilityTotals = {
    weighedKg,
    recycledKg,
    recyclingRate: rate(recycledKg, weighedKg),
    footprintGrams: all.some((line) => line.footprintGrams === null) ? null : all.reduce((acc, line) => acc + (line.footprintGrams ?? 0), 0),
    avoidedGrams: all.some((line) => line.avoidedGrams === null) ? null : all.reduce((acc, line) => acc + (line.avoidedGrams ?? 0), 0),
    unmeasuredStops: all.reduce((acc, line) => acc + line.stops.unmeasured, 0),
  }
  const fractions = [...new Set(all.map((line) => line.wasteFractionId))]
  const warnings: SustainabilityWarning[] = [
    ...fractions.filter((id) => all.some((line) => line.wasteFractionId === id && line.treatment === null && weighed(line) > 0)).map((wasteFractionId) => ({ kind: "no-treatment" as const, wasteFractionId })),
    ...fractions.filter((id) => unfactored.has(id)).map((wasteFractionId) => ({ kind: "no-factor" as const, wasteFractionId })),
  ]
  return { lines: all, totals, warnings }
}

/** Grams as kilograms with their three decimals, exactly: `12500` is `12.500`. */
export function kilogramsOf(grams: number): string {
  return `${Math.floor(grams / 1000)}.${String(grams % 1000).padStart(3, "0")}`
}

/** What a warning says, naming the fraction. */
export function sustainabilityWarningSentence(kind: SustainabilityWarningKind, fractionName: string): string {
  return kind === "no-treatment"
    ? `${fractionName} has no treatment set, so its kilograms count as not recycled: set it under Master data`
    : `${fractionName} has no emission factor in force on some of its days, so its CO₂e is not reported: add one under Emission factors`
}

/** The columns of the report's file, in order. */
export const SUSTAINABILITY_COLUMNS = ["period_from", "period_to", "site", "address", "fraction", "treatment", "kg_measured", "kg_apportioned", "kg_estimated", "stops_unmeasured", "co2e_footprint_kg", "co2e_avoided_kg", "note"] as const

/** The report as its file reads it: names, not ids. */
export type SustainabilityFile = {
  from: string
  to: string
  sites: readonly { name: string; address: string; notAttributedStops: number; lines: readonly { fractionName: string; treatment: WasteTreatment | null; kg: FractionLine["kg"]; stops: FractionLine["stops"]; footprintGrams: number | null; avoidedGrams: number | null }[] }[]
  warnings: readonly { kind: SustainabilityWarningKind; fractionName: string }[]
}

/**
 * The report as a CSV file's text, UTF-8 behind a byte-order mark with CRLF
 * records as the waste-data file is: a row per site and fraction, CO₂e in
 * kilograms with three decimals and blank where unknown; a row per site with
 * stops that had no container, saying so in `note`; and a row per warning.
 */
export function sustainabilityCsv(file: SustainabilityFile, separator: "," | ";" = ","): string {
  const line = (fields: readonly string[]) => fields.map((field) => csvField(field, separator)).join(separator)
  const period = [file.from, file.to]
  const grams = (value: number | null) => (value === null ? "" : kilogramsOf(value))
  const records = [
    line(SUSTAINABILITY_COLUMNS),
    ...file.sites.flatMap((site) => [
      ...site.lines.map((row) =>
        line([...period, site.name, site.address, row.fractionName, row.treatment ?? "", String(row.kg.measured), String(row.kg.apportioned), String(row.kg.estimated), String(row.stops.unmeasured), grams(row.footprintGrams), grams(row.avoidedGrams), ""]),
      ),
      ...(site.notAttributedStops > 0 ? [line([...period, site.name, site.address, "", "", "", "", "", "", "", "", `${site.notAttributedStops} completed ${site.notAttributedStops === 1 ? "stop" : "stops"} with no container, so no agreement's, not counted`])] : []),
    ]),
    ...file.warnings.map((warning) => line([...period, "", "", warning.fractionName, "", "", "", "", "", "", "", sustainabilityWarningSentence(warning.kind, warning.fractionName)])),
  ]
  return `\uFEFF${records.map((record) => `${record}\r\n`).join("")}`
}
