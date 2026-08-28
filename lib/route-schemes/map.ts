// Route Scheme map geometry (spec FR-15, ticket #6). Pure data logic — no UI
// or store dependencies — shared by the wizard's Route map step and the scheme
// detail view. Pin positions are illustrative until container records carry
// coordinates: deterministic per container id, so the picture is stable across
// visits; real geocoding is explicitly out of scope.

import { avalancheHash } from "./hash"
import type { ServiceDay } from "./recurrence"

/** The SVG overlay's coordinate space; positions are percentages of it. */
export const MAP_VIEWBOX = { width: 100, height: 100 } as const

/**
 * Stable per-day route colors, one hue per weekday, picked to stay legible
 * over the dimmed grayscale map in both light and dark theme.
 */
export const SCHEME_DAY_COLORS: Record<ServiceDay, string> = {
  monday: "#2563eb",
  tuesday: "#d97706",
  wednesday: "#db2777",
  thursday: "#7c3aed",
  friday: "#dc2626",
  saturday: "#0891b2",
  sunday: "#059669",
}

/** Deterministic pseudo-position so a container always lands on the same spot. */
export function stopPosition(containerId: string): { x: number; y: number } {
  const hash = avalancheHash(containerId)
  return {
    x: 10 + ((hash % 997) / 997) * 80,
    y: 12 + ((Math.floor(hash / 997) % 991) / 991) * 74,
  }
}

/**
 * The `points` attribute for a day's route polyline, stops in picked order.
 * Fewer than two stops make no line — the pins still render individually.
 */
export function dayPolylinePoints(containerIds: readonly string[]): string {
  if (containerIds.length < 2) return ""
  return containerIds
    .map((id) => {
      const { x, y } = stopPosition(id)
      return `${x},${y}`
    })
    .join(" ")
}
