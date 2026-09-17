// Saved selections (2026-09-16): the bookmark menu's named shapes, each kept
// with the filters and collection window it was drawn under so loading one
// restores the exact view. Stored in the browser under one key; parsing is
// tolerant — a malformed entry is dropped, an unknown window falls back to
// "any", an unknown shape kind to "polygon" — so a stale store never blanks
// the menu. Pure data logic; the menu owns the storage calls.

import {
  BUSINESS_FILTER_KEYS,
  emptyBusinessFilters,
  type BusinessFilters,
} from "../data/business-filters"
import type { LngLat } from "./geo"
import { isCollectionWindow, type CollectionWindow } from "./schedule"
import type { SelectionShape } from "./selection"

export const SAVED_SELECTIONS_STORAGE_KEY = "wastehero-map-selections-v1"

export type SavedSelection = {
  id: string
  name: string
  shape: SelectionShape
  filters: BusinessFilters
  window: CollectionWindow
  /** ISO datetime. */
  createdAt: string
}

export type SavedSelectionInput = Pick<SavedSelection, "name" | "shape" | "filters" | "window">

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string")

const isLngLat = (value: unknown): value is LngLat =>
  Boolean(value) &&
  typeof value === "object" &&
  typeof (value as LngLat).lng === "number" &&
  typeof (value as LngLat).lat === "number"

function parseFilters(value: unknown): BusinessFilters {
  const filters: BusinessFilters = { ...emptyBusinessFilters }
  if (!value || typeof value !== "object") return filters
  const raw = value as Record<string, unknown>
  for (const key of BUSINESS_FILTER_KEYS) {
    if (isStringArray(raw[key])) filters[key] = [...(raw[key] as string[])]
  }
  return filters
}

function parseShape(value: unknown): SelectionShape | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  if (!Array.isArray(raw.polygon) || raw.polygon.length < 3 || !raw.polygon.every(isLngLat)) return null
  return {
    kind: raw.kind === "rectangle" ? "rectangle" : "polygon",
    polygon: raw.polygon.map((point) => ({ lng: point.lng, lat: point.lat })),
  }
}

function parseSelection(value: unknown): SavedSelection | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== "string" || typeof raw.name !== "string" || !raw.name.trim()) return null
  const shape = parseShape(raw.shape)
  if (!shape) return null
  return {
    id: raw.id,
    name: raw.name,
    shape,
    filters: parseFilters(raw.filters),
    window: isCollectionWindow(raw.window) ? raw.window : "any",
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
  }
}

export function parseSavedSelections(raw: string | null): SavedSelection[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    const list =
      parsed && typeof parsed === "object" && Array.isArray((parsed as { selections?: unknown }).selections)
        ? ((parsed as { selections: unknown[] }).selections as unknown[])
        : []
    return list.map(parseSelection).filter((entry): entry is SavedSelection => entry !== null)
  } catch {
    return []
  }
}

export function serializeSavedSelections(selections: readonly SavedSelection[]): string {
  return JSON.stringify({ selections })
}

/** Appends a new entry with the trimmed name; a blank name leaves the list as it is. */
export function addSavedSelection(
  selections: readonly SavedSelection[],
  input: SavedSelectionInput,
  stamp: { id: string; now: string },
): SavedSelection[] {
  const name = input.name.trim()
  if (!name) return [...selections]
  return [
    ...selections,
    {
      id: stamp.id,
      name,
      shape: { kind: input.shape.kind, polygon: input.shape.polygon.map((point) => ({ ...point })) },
      filters: parseFilters(input.filters),
      window: input.window,
      createdAt: stamp.now,
    },
  ]
}

/** Renames by id with the trimmed name; a blank name leaves the list as it is. */
export function renameSavedSelection(
  selections: readonly SavedSelection[],
  id: string,
  name: string,
): SavedSelection[] {
  const trimmed = name.trim()
  if (!trimmed) return [...selections]
  return selections.map((entry) => (entry.id === id ? { ...entry, name: trimmed } : entry))
}

export function removeSavedSelection(selections: readonly SavedSelection[], id: string): SavedSelection[] {
  return selections.filter((entry) => entry.id !== id)
}
