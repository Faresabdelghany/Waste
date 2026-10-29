// Settings › Pre-trip checklists (O13 of #290): a vehicle type's checklist —
// the items a driver looks at before or during the day, in order, each
// critical or not — as rows a person edits, and the body `PUT
// /vehicle-types/:id/checklist` replaces the list with. The pane reads and
// writes the API directly (components/settings/pre-trip-checklists-settings.tsx,
// lib/api/pre-trip-checklists.ts): the list is a vehicle type's configuration,
// not records of a workspace module. A row the API would refuse is refused
// here first, at the row, in the API's sentence.
import type { ChecklistItem, VehicleTypeChecklistSet } from "@waste/contracts/pre-trip"
import { CHECKLIST_MAX } from "@waste/domain/resources/pre-trip"

import { allows, type Grants } from "../api/grants"

/** The pane, offered on the Pilot alone: the checklists are the API's. */
export const PRE_TRIP_CHECKLISTS_SETTINGS_PANE_ID = "pre-trip-checklists"

/** One item as the form holds it: the label as typed and its weight, under a key React keeps it by. */
export type ChecklistRow = { key: string; label: string; critical: boolean }

/** The contracts' `EACH_ITEM_ONCE`, spelled again since the web imports no zod; a test holds the two equal. */
export const ONCE_SENTENCE = "Name each checklist item once: a driver answers each once"
/** What a blank item is told. */
export const LABEL_SENTENCE = "Say what the driver checks"
/** What a list past the cap is told. */
export const TOO_MANY_SENTENCE = `A checklist holds at most ${CHECKLIST_MAX} items`

/** A type's checklist as rows, in its order. */
export const checklistRowsOf = (items: readonly ChecklistItem[]): ChecklistRow[] => items.map((item) => ({ key: item.id, label: item.label, critical: item.critical }))

/** What the form refuses before the API sees it: the row and why. */
export type ChecklistRefusal = { index: number; message: string }

export const isChecklistRefusal = (value: VehicleTypeChecklistSet | ChecklistRefusal): value is ChecklistRefusal => "index" in value

/** The body the rows become, or the first row the API would refuse. */
export function checklistBodyOf(rows: readonly ChecklistRow[]): VehicleTypeChecklistSet | ChecklistRefusal {
  if (rows.length > CHECKLIST_MAX) return { index: CHECKLIST_MAX, message: TOO_MANY_SENTENCE }
  const seen = new Set<string>()
  for (const [index, row] of rows.entries()) {
    const label = row.label.trim()
    if (label === "") return { index, message: LABEL_SENTENCE }
    const key = label.toLowerCase()
    if (seen.has(key)) return { index, message: ONCE_SENTENCE }
    seen.add(key)
  }
  return { items: rows.map((row) => ({ label: row.label.trim(), critical: row.critical })) }
}

/** The rows with one moved up or down by one place; a move past either end leaves them as they are. */
export function movedRow(rows: readonly ChecklistRow[], index: number, by: -1 | 1): ChecklistRow[] {
  const target = index + by
  if (index < 0 || index >= rows.length || target < 0 || target >= rows.length) return [...rows]
  const next = [...rows]
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}

/** Whether the rows say something other than the list the API holds: a label, a weight, an order or a count. */
export function checklistChanged(rows: readonly ChecklistRow[], saved: readonly ChecklistItem[]): boolean {
  return rows.length !== saved.length || rows.some((row, index) => row.label.trim() !== saved[index].label || row.critical !== saved[index].critical)
}

/** What the pane may do for a role: read the types' lists under the master data's `view`, and change one under its `edit`, the grants the API holds them to. */
export const checklistAccessOf = (grants: Grants | undefined): { view: boolean; edit: boolean } => ({
  view: allows(grants, "configure.master", "view"),
  edit: allows(grants, "configure.master", "edit"),
})
