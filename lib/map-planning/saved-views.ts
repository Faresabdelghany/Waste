// Saved map views (2026-09-16): the star menu's named filter sets, kept in
// the browser under one key. Parsing is tolerant — a malformed entry is
// dropped, an unknown window falls back to "any" — so a stale store never
// blanks the menu. Pure data logic; the component owns the storage calls.

import {
  BUSINESS_FILTER_KEYS,
  emptyBusinessFilters,
  type BusinessFilters,
} from "../data/business-filters"
import type { MapMode } from "./points"
import { isCollectionWindow, type CollectionWindow } from "./schedule"

export const MAP_PLANNING_STORAGE_KEY = "wastehero-map-planning-v1"

export type SavedMapView = {
  id: string
  name: string
  mode: MapMode
  window: CollectionWindow
  filters: BusinessFilters
  /** ISO datetime. */
  createdAt: string
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string")

function parseFilters(value: unknown): BusinessFilters {
  const filters: BusinessFilters = { ...emptyBusinessFilters }
  if (!value || typeof value !== "object") return filters
  const raw = value as Record<string, unknown>
  for (const key of BUSINESS_FILTER_KEYS) {
    if (isStringArray(raw[key])) filters[key] = [...(raw[key] as string[])]
  }
  return filters
}

function parseView(value: unknown): SavedMapView | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== "string" || typeof raw.name !== "string" || !raw.name.trim()) return null
  return {
    id: raw.id,
    name: raw.name,
    mode: raw.mode === "properties" ? "properties" : "containers",
    window: isCollectionWindow(raw.window) ? raw.window : "any",
    filters: parseFilters(raw.filters),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
  }
}

export function parseSavedViews(raw: string | null): SavedMapView[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    const views =
      parsed && typeof parsed === "object" && Array.isArray((parsed as { views?: unknown }).views)
        ? ((parsed as { views: unknown[] }).views as unknown[])
        : []
    return views.map(parseView).filter((view): view is SavedMapView => view !== null)
  } catch {
    return []
  }
}

export function serializeSavedViews(views: readonly SavedMapView[]): string {
  return JSON.stringify({ views })
}
