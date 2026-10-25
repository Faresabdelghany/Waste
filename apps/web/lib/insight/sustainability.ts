// A Customer's sustainability report on the web (M13 of #293): what the
// customer's details and the printable page read off `GET /reports/
// sustainability` — the collected waste of one Customer by site and fraction
// over a window of days, weighed best first, with the recycling rate and the
// CO₂e — so it is tested without a browser. The window is a Compliance
// period (compliance.ts: last year by default), held to what the report
// takes; the warnings are the domain's own sentences, the file's too.
//
// A figure the report could not give is said, never shown as nought: a rate
// where nothing was weighed, a CO₂e where a stop's fraction had no emission
// factor on its day.
import type { SustainabilityLine, SustainabilityReport, SustainabilitySite } from "@waste/contracts/sustainability"
import { sustainabilityWarningSentence } from "@waste/domain/insight/sustainability"

import { allows, type Grants } from "@/lib/api/grants"
import type { SustainabilityQuery } from "@/lib/api/reports"
import { TREATMENT_LABELS } from "@/lib/data/master-data"

import { periodRefusal, PERIOD_TOO_LONG, REPORT_WINDOW_MAX_DAYS } from "./compliance"
import { countedOf, countOf, weightOf, type DayWindow } from "./dashboard"

/** Whether the role reads the report: the customers' module and the stops', the API's two grants for it. */
export const sustainabilityReadable = (grants: Grants | undefined): boolean => allows(grants, "customers.contacts", "view") && allows(grants, "route-studio.pickups", "view")

/** What the section says of a window the report would refuse for its length. */
export const WINDOW_TOO_LONG = `A report's window is at most ${REPORT_WINDOW_MAX_DAYS} days; ask for a year at a time`

/** Why a window cannot be asked for, or null when it can: the Compliance period's rule, in a report's words. */
export function windowRefusal(window: DayWindow): string | null {
  const refusal = periodRefusal(window)
  return refusal === PERIOD_TOO_LONG ? WINDOW_TOO_LONG : refusal
}

const kilograms = new Intl.NumberFormat("en", { maximumFractionDigits: 1 })
const tonnes = new Intl.NumberFormat("en", { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const percent = new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 1 })

/** Grams CO₂e as a person reads them: kilograms to one decimal, tonnes from a tonne up; "Not reported" where a stop's fraction had no factor. */
export function co2eOf(grams: number | null): string {
  if (grams === null) return "Not reported"
  return grams >= 1_000_000 ? `${tonnes.format(grams / 1_000_000)} t CO₂e` : `${kilograms.format(grams / 1000)} kg CO₂e`
}

/** The recycling rate to a tenth of a percent; "Nothing weighed" where no kilogram was. */
export const rateOf = (rate: number | null): string => (rate === null ? "Nothing weighed" : percent.format(rate))

/** The kilograms a line weighed, however each was weighed. */
export const weighedKg = (line: SustainabilityLine): number => line.kg.measured + line.kg.apportioned + line.kg.estimated

/** The stops a line counts, weighed or not. */
export const stopsOf = (line: SustainabilityLine): number => line.stops.measured + line.stops.apportioned + line.stops.estimated + line.stops.unmeasured

/** How a line's kilograms were weighed, best first: "30 kg measured, 100 kg apportioned", and the stops nothing weighed. */
export function basisOf(line: SustainabilityLine): string {
  const parts = [
    line.kg.measured > 0 ? `${weightOf(line.kg.measured)} measured` : null,
    line.kg.apportioned > 0 ? `${weightOf(line.kg.apportioned)} apportioned` : null,
    line.kg.estimated > 0 ? `${weightOf(line.kg.estimated)} estimated` : null,
    line.stops.unmeasured > 0 ? `${countedOf(line.stops.unmeasured, "stop")} unmeasured` : null,
  ].filter((part): part is string => part !== null)
  return parts.length === 0 ? "Nothing weighed" : parts.join(", ")
}

/** A line's treatment as a person reads it; "Not recorded" counts as not recycled. */
export const treatmentOf = (line: Pick<SustainabilityLine, "treatment">): string => (line.treatment === null ? "Not recorded" : TREATMENT_LABELS[line.treatment])

/** What a site says beneath its lines: the stops there with no container, so no agreement of anyone's; null where there were none. */
export function notAttributedOf(site: SustainabilitySite): string | null {
  return site.notAttributedStops === 0 ? null : `${countedOf(site.notAttributedStops, "stop")} here had no container, so no agreement: not in these figures`
}

/** The report's headline figures, as the section's tiles read them. */
export function totalsOf(report: SustainabilityReport): { weighed: string; rate: string; footprint: string; avoided: string; unmeasured: string | null } {
  const { totals } = report
  return {
    weighed: weightOf(totals.weighedKg),
    rate: rateOf(totals.recyclingRate),
    footprint: co2eOf(totals.footprintGrams),
    avoided: co2eOf(totals.avoidedGrams),
    unmeasured: totals.unmeasuredStops === 0 ? null : `${countedOf(totals.unmeasuredStops, "stop")} had no weight to report: counted, not weighed`,
  }
}

/** The warnings to read before sending the report, in the domain's sentences, in the report's order, each keyed by its kind and fraction. */
export const warningsOf = (report: SustainabilityReport): { key: string; sentence: string }[] =>
  report.warnings.map((warning) => ({ key: `${warning.kind}-${warning.wasteFractionId}`, sentence: sustainabilityWarningSentence(warning.kind, warning.name) }))

/** Whether the report has anything to show: a site with a line. */
export const reportShowsAny = (report: SustainabilityReport): boolean => report.sites.some((site) => site.lines.length > 0 || site.notAttributedStops > 0)

/** The name a downloaded file is saved under: the API's, else the one it would give. */
export const sustainabilityFileName = (fileName: string | null, query: SustainabilityQuery): string => fileName ?? `sustainability-${query.from}-${query.to}.csv`

/** The printable report's page for a Customer by server id over a window, which the browser prints. */
export const sustainabilityPrintHref = (customerServerId: string, window: DayWindow): string =>
  `/customers/${encodeURIComponent(customerServerId)}/sustainability?from=${encodeURIComponent(window.from)}&to=${encodeURIComponent(window.to)}`

/** A count of stops as the table's cell reads it. */
export const stopsText = (line: SustainabilityLine): string => countOf(stopsOf(line))
