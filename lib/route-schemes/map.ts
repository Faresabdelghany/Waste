// Route Scheme map geometry (spec FR-15, ticket #6). Pure data logic — no UI
// or store dependencies — shared by the wizard's Route map step and the scheme
// detail view. Pin positions are illustrative until container records carry
// coordinates: deterministic per container id, so the picture is stable across
// visits; real geocoding is explicitly out of scope.

import { avalancheHash } from "./hash"
import { sortServiceDays, type ServiceDay } from "./recurrence"

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

/**
 * Day plans whose stop lists are identical, folded into one drawable group
 * (issue #17): positions are deterministic per container, so a sameAllDays
 * scheme's per-day plans would otherwise paint N pixel-identical routes on
 * top of each other and only the last day's color would survive. One group =
 * one polyline, one pin set, one legend row.
 */
export type SchemeMapDayGroup = {
  /** Every day serving this exact stop list, in canonical day order. */
  days: ServiceDay[]
  /** The shared stop list in picked order, deduped within the day. */
  containerIds: string[]
  /** The group's earliest day speaks for it on the map. */
  color: string
}

export function groupIdenticalDayPlans(
  plans: readonly { day: ServiceDay; containerIds: readonly string[] }[],
): SchemeMapDayGroup[] {
  const groups = new Map<string, SchemeMapDayGroup>()
  for (const plan of plans) {
    const containerIds = [...new Set(plan.containerIds)]
    const key = containerIds.join("\u0000")
    const group = groups.get(key)
    if (group) {
      group.days = sortServiceDays([...group.days, plan.day])
      group.color = SCHEME_DAY_COLORS[group.days[0]]
    } else {
      groups.set(key, {
        days: [plan.day],
        containerIds,
        color: SCHEME_DAY_COLORS[plan.day],
      })
    }
  }
  return [...groups.values()]
}

/**
 * One rendered pin per distinct stop across the shown groups. A stop served
 * by more than one distinct route keeps `color: null` — the map styles it as
 * shared instead of letting the later group's pin hide the earlier one.
 */
export type SchemeMapPin = {
  containerId: string
  x: number
  y: number
  /** Every shown day serving this stop, in canonical day order. */
  days: ServiceDay[]
  color: string | null
}

export function schemeMapPins(
  groups: readonly SchemeMapDayGroup[],
): SchemeMapPin[] {
  const pins = new Map<string, SchemeMapPin>()
  for (const group of groups) {
    for (const containerId of group.containerIds) {
      const pin = pins.get(containerId)
      if (pin) {
        pin.days = sortServiceDays([...new Set([...pin.days, ...group.days])])
        pin.color = null
      } else {
        pins.set(containerId, {
          containerId,
          ...stopPosition(containerId),
          days: [...group.days],
          color: group.color,
        })
      }
    }
  }
  return [...pins.values()]
}
