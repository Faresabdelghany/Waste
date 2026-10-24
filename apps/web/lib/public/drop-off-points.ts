// The public map of Drop-off Points' rules (Issue #293, M3b), apart from its
// page so they are tested here: which fraction the address asks for, where
// the map lives, how a day's opening is written, and where each point stands
// on the map.
import type { PublicDropOffPoint, PublicOpeningDay } from "@waste/contracts/public"
import { boundsFromPolygon, type LngLatBounds } from "@waste/domain/map-planning/geo"

import { DROP_OFF_COPY as COPY } from "./drop-off-points-copy"

/** The longest key a fraction has (the contracts' KEY_MAX), spelled again since the web imports the contracts as types only. */
export const FRACTION_KEY_MAX = 50

/** The guide's fraction key the address asks for, a lowercase slug the door takes; null for none, or one no key could be, so the map shows every point. */
export function fractionKeyOf(fraction: string | string[] | undefined): string | null {
  const first = (Array.isArray(fraction) ? fraction[0] : fraction)?.trim() ?? ""
  return first.length <= FRACTION_KEY_MAX && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(first) ? first : null
}

/** Where the map lives, asking for one fraction's points where a key is given. */
export const dropOffHrefOf = (slug: string, fractionKey?: string | null): string =>
  `/p/${encodeURIComponent(slug)}/drop-off${fractionKey == null ? "" : `?fraction=${encodeURIComponent(fractionKey)}`}`

/** A day's opening as a resident reads it: all day, closed, or its windows. */
export function openingTextOf(day: PublicOpeningDay): string {
  if (day.allDay) return COPY.openAllDay
  if (day.windows.length === 0) return COPY.closed
  return day.windows.map((window) => `${window.opensAt}–${window.closesAt}`).join(COPY.windowsJoin)
}

/** A day as a short label: `Mon 21 Dec`, on no one's clock but the date's own. */
export function shortDayOf(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`))
}

/** A point as the map pins it. */
export type MapPoint = { id: string; name: string; kind: PublicDropOffPoint["kind"]; lng: number; lat: number }

export const mapPointsOf = (points: readonly PublicDropOffPoint[]): MapPoint[] =>
  points.map((point) => ({ id: point.id, name: point.name, kind: point.kind, lng: point.location.coordinates[0], lat: point.location.coordinates[1] }))

/** The box that holds every point, by the map planner's own rule; null for none. */
export const boundsOf = (points: readonly MapPoint[]): LngLatBounds | null => (points.length === 0 ? null : boundsFromPolygon(points))

/** The points as one GeoJSON layer's source: the map draws them on its canvas, never one element each. */
export function pointsCollectionOf(points: readonly MapPoint[]) {
  return {
    type: "FeatureCollection" as const,
    features: points.map((point) => ({ type: "Feature" as const, properties: { id: point.id, name: point.name, kind: point.kind }, geometry: { type: "Point" as const, coordinates: [point.lng, point.lat] } })),
  }
}

/** The anchor of a point's card, which its pin on the map links to. */
export const pointAnchorOf = (id: string): string => `point-${id}`
