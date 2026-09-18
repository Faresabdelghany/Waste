// The planning map's collection window (2026-09-16): which containers have a
// collection coming up. A container's next collection is read from generated
// routes first — the Pickups a dated Route generated for it, on the date the
// route actually runs — and from the registry's "Next collection" display
// fact second, when that date is not already in the past. Pure data logic.

import type { BusinessRecord } from "../prototype-record"
import { typedString } from "../record-values"
import { isSoftDeleted } from "../record-visibility"
import { addDays, isIsoDate } from "../route-schemes/recurrence"

export type CollectionWindow = "any" | "today" | "next-7" | "next-14" | "next-30"

export const COLLECTION_WINDOWS: readonly CollectionWindow[] = [
  "any",
  "today",
  "next-7",
  "next-14",
  "next-30",
]

export const COLLECTION_WINDOW_LABELS: Readonly<Record<CollectionWindow, string>> = {
  any: "Any date",
  today: "Today",
  "next-7": "Next 7 days",
  "next-14": "Next 14 days",
  "next-30": "Next 30 days",
}

export const DEFAULT_COLLECTION_WINDOW: CollectionWindow = "any"

export const isCollectionWindow = (value: unknown): value is CollectionWindow =>
  typeof value === "string" && (COLLECTION_WINDOWS as readonly string[]).includes(value)

const WINDOW_DAYS: Readonly<Record<Exclude<CollectionWindow, "any">, number>> = {
  today: 0,
  "next-7": 7,
  "next-14": 14,
  "next-30": 30,
}

/** Inclusive ISO range for a window, or null for "any". */
export function collectionWindowRange(
  window: CollectionWindow,
  today: string,
): { from: string; to: string } | null {
  if (window === "any") return null
  return { from: today, to: addDays(today, WINDOW_DAYS[window]) }
}

/** Route and pickup states that no longer promise a collection. */
const DEAD_STATUSES: ReadonlySet<string> = new Set(["Cancelled", "Skipped", "Failed"])

/**
 * Container id → sorted ISO dates on which a generated route collects it.
 * The date is the route's actual (possibly shifted) date, falling back to
 * the pickup's own service date.
 */
export function routeStopIndex(
  routes: readonly BusinessRecord[],
  pickups: readonly BusinessRecord[],
): Map<string, string[]> {
  const routeDates = new Map<string, string>()
  for (const route of routes) {
    if (isSoftDeleted(route) || DEAD_STATUSES.has(route.status)) continue
    const date = typedString(route.submittedValues, "actualDate") ?? typedString(route.submittedValues, "serviceDate")
    if (date && isIsoDate(date)) routeDates.set(route.id, date)
  }
  const index = new Map<string, Set<string>>()
  for (const pickup of pickups) {
    if (isSoftDeleted(pickup) || DEAD_STATUSES.has(pickup.status)) continue
    const containerId = typedString(pickup.submittedValues, "containerId")
    const routeId = typedString(pickup.submittedValues, "routeId")
    if (!containerId || !routeId) continue
    const date = routeDates.get(routeId)
    if (!date) continue
    const dates = index.get(containerId) ?? new Set<string>()
    dates.add(date)
    index.set(containerId, dates)
  }
  return new Map(
    Array.from(index.entries()).map(([containerId, dates]) => [containerId, [...dates].sort()]),
  )
}

const MONTHS: Readonly<Record<string, string>> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
}

/** "28 Aug 2026" (optionally followed by " · …") → "2026-08-28"; anything else → null. */
export function parseDisplayDate(value: string | undefined): string | null {
  if (!value) return null
  const match = /^\s*(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/.exec(value)
  if (!match) return isIsoDate(value.trim()) ? value.trim() : null
  const month = MONTHS[match[2].toLowerCase()]
  if (!month) return null
  return `${match[3]}-${month}-${match[1].padStart(2, "0")}`
}

/**
 * The container's next collection on or after today: the earliest generated
 * date, else the registry's "Next collection" fact when it is not in the
 * past, else null (nothing scheduled that the map can vouch for).
 */
export function nextCollectionDate(
  container: BusinessRecord,
  index: ReadonlyMap<string, readonly string[]>,
  today: string,
): string | null {
  const generated = index.get(container.id)?.find((date) => date >= today)
  if (generated) return generated
  const fact = parseDisplayDate(container.facts["Next collection"])
  return fact && fact >= today ? fact : null
}

export function inCollectionWindow(
  next: string | null,
  window: CollectionWindow,
  today: string,
): boolean {
  const range = collectionWindowRange(window, today)
  if (!range) return true
  return next !== null && next >= range.from && next <= range.to
}
