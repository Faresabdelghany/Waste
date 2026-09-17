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
 * Stable per-collection-group colors (D33): when a scheme has several groups
 * the map colors lines by group, not by day — two groups on one day would
 * otherwise share a color and be indistinguishable.
 */
export const SCHEME_GROUP_COLORS = [
  "#2563eb",
  "#059669",
  "#d97706",
  "#db2777",
  "#7c3aed",
  "#0891b2",
  "#dc2626",
  "#65a30d",
] as const

/** A drawable plan: one route's stops on one day, optionally labelled by its group. */
export type SchemeMapPlan = {
  day: ServiceDay
  containerIds: readonly string[]
  /** The collection group's name — set only for multi-group schemes. */
  label?: string
}

/**
 * Plans whose stop lists are identical, folded into one drawable group
 * (issue #17): positions are deterministic per container, so a sameAllDays
 * scheme's per-day plans would otherwise paint N pixel-identical routes on
 * top of each other and only the last day's color would survive. One group =
 * one polyline, one pin set, one legend row. Labelled plans (collection
 * groups) fold only with the same label and take the group's color.
 */
export type SchemeMapDayGroup = {
  /** Every day serving this exact stop list, in canonical day order. */
  days: ServiceDay[]
  /** The shared stop list in picked order, deduped within the day. */
  containerIds: string[]
  /** The collection group label, when the plans carry one. */
  label?: string
  /** The group's earliest day (or its collection group) speaks for it on the map. */
  color: string
}

export function groupIdenticalDayPlans(plans: readonly SchemeMapPlan[]): SchemeMapDayGroup[] {
  const groups = new Map<string, SchemeMapDayGroup>()
  const labels = Array.from(
    new Set(plans.map((plan) => plan.label).filter((label): label is string => Boolean(label))),
  )
  const colorFor = (plan: SchemeMapPlan, days: readonly ServiceDay[]): string =>
    plan.label
      ? SCHEME_GROUP_COLORS[labels.indexOf(plan.label) % SCHEME_GROUP_COLORS.length]
      : SCHEME_DAY_COLORS[days[0]]
  for (const plan of plans) {
    const containerIds = [...new Set(plan.containerIds)]
    const key = `${plan.label ?? ""}\u0001${containerIds.join("\u0000")}`
    const group = groups.get(key)
    if (group) {
      group.days = sortServiceDays([...group.days, plan.day])
      group.color = colorFor(plan, group.days)
    } else {
      groups.set(key, {
        days: [plan.day],
        containerIds,
        ...(plan.label ? { label: plan.label } : {}),
        color: colorFor(plan, [plan.day]),
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
