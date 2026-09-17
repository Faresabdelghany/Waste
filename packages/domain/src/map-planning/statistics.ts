// What a map selection amounts to (2026-09-16): the Selected area panel's
// numbers, every one derived at render time from the selected container
// records and Settings' asset catalogue. Assumed weight and volume are one
// emptying of each container — per the container type's fraction weight,
// else its volume × the fraction's kg/L — multiplied by the collections
// expected in the quantities range: generated route stops when a Route has
// them, else the registry's next collection repeated at the container's
// service frequency. Collected weight sums the Weight of completed Pickups
// for those containers in the range. Pure data logic.

import type { BusinessRecord } from "../data/business-modules"
import { isSoftDeleted } from "@waste/domain/record-visibility"
import { addDays, isIsoDate } from "@waste/domain/route-schemes/recurrence"
import { containerFractions, rankFractions } from "./points"
import { containerPropertyKey } from "./positions"
import { nextCollectionDate, parseDisplayDate } from "./schedule"

export type QuantityRange = { from: string; to: string } | null

export type StatisticsInputs = {
  /** Settings › Asset management container types — the volume and per-fraction weights. */
  containerTypes: ReadonlyArray<{
    name: string
    volume: number
    volumeUnit: "L" | "m³"
    wasteFractionWeights: Record<string, number>
  }>
  /** Settings › Asset management waste fractions — the kg/L fallback. */
  wasteFractions: ReadonlyArray<{ id: string; name: string; weightToVolumeRatio: number }>
  /** Container id → generated collection dates (lib/map-planning/schedule.ts). */
  stopIndex: ReadonlyMap<string, readonly string[]>
  pickups: readonly BusinessRecord[]
  /** Inclusive ISO range, or null for "one collection of everything". */
  range: QuantityRange
  today: string
}

export type SelectionStatistics = {
  containers: number
  properties: number
  collectionPoints: number
  /** [fraction, container count], most frequent first. */
  byFraction: Array<[string, number]>
  /** Collections the quantities assume — one per container without a range. */
  collections: number
  assumedWeightKg: number
  collectedWeightKg: number
  assumedVolumeLitres: number
  activeAgreements: number
}

const EMPTY_FACT = "—"
/** kg per litre when neither the type nor the fraction says. */
const DEFAULT_KG_PER_LITRE = 0.12
/** Guard against runaway projections (daily over a long range is still < 400). */
const MAX_PROJECTED_COLLECTIONS = 400

const clean = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim()
  return trimmed && trimmed !== EMPTY_FACT ? trimmed : undefined
}

const stringOf = (record: BusinessRecord, key: string): string | undefined => {
  const value = record.submittedValues?.[key]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/** "Two-wheel bin · 240 L" / "Igloo · 3,000 L" / "2.5 m³ skip" → litres, or null. */
export function litresFromTypeName(name: string): number | null {
  const litres = /([\d,.]+)\s*L\b/i.exec(name)
  if (litres) return Number.parseFloat(litres[1].replace(/,/g, ""))
  const cubic = /([\d,.]+)\s*m³/i.exec(name)
  if (cubic) return Number.parseFloat(cubic[1].replace(/,/g, "")) * 1000
  return null
}

/** "148 kg" → 148, "8.2 t" → 8200, anything else → 0. */
export function parseWeightKg(value: string | undefined): number {
  const match = /([\d,.]+)\s*(kg|t)\b/i.exec(value ?? "")
  if (!match) return 0
  const amount = Number.parseFloat(match[1].replace(/,/g, ""))
  if (!Number.isFinite(amount)) return 0
  return match[2].toLowerCase() === "t" ? amount * 1000 : amount
}

/** Days between collections for a "Service frequency" display value, or null when it has no cadence. */
export function frequencyIntervalDays(value: string | undefined): number | null {
  const text = (value ?? "").toLowerCase()
  if (!text || text === EMPTY_FACT) return null
  if (text.startsWith("daily")) return 1
  if (text.startsWith("weekly") || text.startsWith("every week")) return 7
  const weeks = /every\s+(\d+)\s+weeks?/.exec(text)
  if (weeks) return Number.parseInt(weeks[1], 10) * 7
  if (text.includes("month")) return 28
  return null
}

function containerVolumeLitres(
  container: BusinessRecord,
  types: StatisticsInputs["containerTypes"],
): number {
  const typeName = clean(container.facts["Container type"])
  if (!typeName) return 0
  const type = types.find((candidate) => candidate.name.trim().toLowerCase() === typeName.toLowerCase())
  if (type) return type.volumeUnit === "m³" ? type.volume * 1000 : type.volume
  return litresFromTypeName(typeName) ?? 0
}

function containerUnitWeightKg(
  container: BusinessRecord,
  inputs: StatisticsInputs,
  volumeLitres: number,
): number {
  const typeName = clean(container.facts["Container type"])?.toLowerCase()
  const type = inputs.containerTypes.find((candidate) => candidate.name.trim().toLowerCase() === typeName)
  const primary = containerFractions(container)[0]
  const fraction = primary
    ? inputs.wasteFractions.find((candidate) => candidate.name.trim().toLowerCase() === primary.toLowerCase())
    : undefined
  const typed = fraction ? type?.wasteFractionWeights[fraction.id] : undefined
  if (typeof typed === "number" && typed > 0) return typed
  return volumeLitres * (fraction?.weightToVolumeRatio ?? DEFAULT_KG_PER_LITRE)
}

/** Collections expected for a container in the range — see the module comment. */
export function expectedCollections(
  container: BusinessRecord,
  inputs: Pick<StatisticsInputs, "stopIndex" | "range" | "today">,
): number {
  const { range } = inputs
  if (!range) return 1
  const generated = inputs.stopIndex.get(container.id) ?? []
  const inRange = generated.filter((date) => date >= range.from && date <= range.to)
  if (inRange.length > 0) return inRange.length
  const next = nextCollectionDate(container, inputs.stopIndex, inputs.today)
  if (!next || next > range.to) return 0
  const interval = frequencyIntervalDays(container.facts["Service frequency"])
  if (!interval) return next >= range.from ? 1 : 0
  let count = 0
  let date = next
  while (date <= range.to && count < MAX_PROJECTED_COLLECTIONS) {
    if (date >= range.from) count += 1
    date = addDays(date, interval)
  }
  return count
}

function pickupDate(
  pickup: BusinessRecord,
  routeDates: ReadonlyMap<string, string>,
): string | null {
  const own = stringOf(pickup, "serviceDate")
  if (own && isIsoDate(own)) return own
  const routeId = stringOf(pickup, "routeId")
  return (routeId && routeDates.get(routeId)) ?? parseDisplayDate(pickup.facts.Date)
}

function collectedWeight(
  containers: readonly BusinessRecord[],
  inputs: StatisticsInputs,
): number {
  const ids = new Set(containers.map((container) => container.id))
  const labels = new Set(
    containers.map((container) => clean(container.facts["Container ID"])?.toLowerCase()).filter(Boolean),
  )
  // The stop index already resolved route dates; invert it for the pickups
  // that name a route but no date of their own.
  const routeDates = new Map<string, string>()
  for (const pickup of inputs.pickups) {
    const routeId = stringOf(pickup, "routeId")
    const containerId = stringOf(pickup, "containerId")
    if (!routeId || !containerId) continue
    const dates = inputs.stopIndex.get(containerId)
    if (dates?.length === 1) routeDates.set(routeId, dates[0])
  }
  let total = 0
  for (const pickup of inputs.pickups) {
    if (isSoftDeleted(pickup) || pickup.status !== "Completed") continue
    const typedId = stringOf(pickup, "containerId")
    const label = clean(pickup.facts["Container ID"])?.toLowerCase()
    if (!(typedId && ids.has(typedId)) && !(label && labels.has(label))) continue
    if (inputs.range) {
      const date = pickupDate(pickup, routeDates)
      if (!date || date < inputs.range.from || date > inputs.range.to) continue
    }
    total += parseWeightKg(pickup.facts.Weight)
  }
  return total
}

const ACTIVE_AGREEMENT = /^(AGR-[\w-]+)\s*·\s*active\b/i

export function selectionStatistics(
  containers: readonly BusinessRecord[],
  inputs: StatisticsInputs,
): SelectionStatistics {
  const properties = new Set<string>()
  const collectionPoints = new Set<string>()
  const agreements = new Set<string>()
  const fractionCounts = new Map<string, number>()
  let collections = 0
  let assumedWeightKg = 0
  let assumedVolumeLitres = 0

  for (const container of containers) {
    const property = containerPropertyKey(container) ?? container.id
    properties.add(property)
    collectionPoints.add(`${property}|${clean(container.facts["Curb location"]) ?? ""}`)
    const agreement = ACTIVE_AGREEMENT.exec(container.facts.Agreement ?? "")
    if (agreement) agreements.add(agreement[1].toUpperCase())
    for (const fraction of containerFractions(container)) {
      fractionCounts.set(fraction, (fractionCounts.get(fraction) ?? 0) + 1)
    }
    const times = expectedCollections(container, inputs)
    const volume = containerVolumeLitres(container, inputs.containerTypes)
    collections += times
    assumedVolumeLitres += times * volume
    assumedWeightKg += times * containerUnitWeightKg(container, inputs, volume)
  }

  const ranked = rankFractions(containers.map((container) => containerFractions(container)))
  return {
    containers: containers.length,
    properties: properties.size,
    collectionPoints: collectionPoints.size,
    byFraction: ranked.map((fraction) => [fraction, fractionCounts.get(fraction) ?? 0]),
    collections,
    assumedWeightKg,
    collectedWeightKg: collectedWeight(containers, inputs),
    assumedVolumeLitres,
    activeAgreements: agreements.size,
  }
}
