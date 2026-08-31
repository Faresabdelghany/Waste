// Derived presentation for the Route Schemes list (issue #30;
// docs/new-changes/SPEC.md area F, DECISIONS.md D15).
//
// Pure data logic, following the calendar-list.ts seam: records plus current
// related records in, display strings out. The recurrence summary derives
// from the scheme's structured `submittedValues` at render time — never from
// a stored display string — so editing a scheme's recurrence changes the
// list immediately. Row context and calendar resolve live related records
// first; a stored display fact is consulted only when the record has no
// structured id at all (the D28i legacy tolerance) — a structured id that no
// longer resolves means the target was deleted, and its frozen display copy
// must not impersonate it. Per D15 the context always names the actual
// stored planning area (or project scope) — the design artifact's truncated
// "Copenhagen Central · By Operations" was a copy bug, not a layout to
// reproduce.

import type { BusinessRecord } from "../data/business-modules"
import { canonicalCalendarName } from "./calendar"
import { formatWorkingDays } from "./calendar-list"
import {
  recurrenceCadenceLabel,
  recurrenceFromValues,
  serviceDaysFromValues,
} from "./recurrence"
import { stringValue } from "./validation"

const EMPTY = "—"

/** A display fact, with blank/whitespace-only values treated as absent. */
function factOf(record: BusinessRecord, label: string): string | undefined {
  const value = record.facts?.[label]?.trim()
  return value ? value : undefined
}

/**
 * The scheme's planning-area name: the live area record when the structured
 * id resolves, the legacy display fact only when there is no structured id
 * (D28i), and undefined when the id points at a deleted area — the caller
 * decides the honest fallback then. Shared with the scheme detail page so
 * the fallback policy lives once.
 */
export function schemeAreaName(
  record: BusinessRecord,
  areas: readonly BusinessRecord[],
): string | undefined {
  const areaId = stringValue(record.submittedValues ?? {}, "planningAreaId")
  if (areaId) return areas.find((area) => area.id === areaId)?.name
  return factOf(record, "Planning area")
}

/**
 * The derived "Project · service days" row context: the planning-area name
 * (else the caller's project-scope label) joined with the structured service
 * days ("Mon–Fri", "Tue/Thu"). Falls back segment-by-segment so a legacy
 * record without structured days still names its scope.
 */
export function schemeListContext(
  record: BusinessRecord,
  areas: readonly BusinessRecord[],
  projectLabel: string,
): string {
  const scope = schemeAreaName(record, areas) ?? projectLabel
  const days = serviceDaysFromValues(record.submittedValues ?? {})
  if (days.length === 0) return scope || EMPTY
  const daysLabel = formatWorkingDays(days)
  return scope ? `${scope} · ${daysLabel}` : daysLabel
}

/**
 * Display seam for the row context: replaces the stored `context` copy with
 * the derived one, so every surface (table, list/board views, detail header)
 * renders real stored area/project names. Returns the input unchanged when
 * the value already matches, keeping mapped lists referentially stable.
 */
export function withDerivedSchemeContext(
  record: BusinessRecord,
  areas: readonly BusinessRecord[],
  projectLabel: string,
): BusinessRecord {
  const context = schemeListContext(record, areas, projectLabel)
  return record.context === context ? record : { ...record, context }
}

/**
 * The compact derived recurrence summary for the Recurrence column: cadence
 * plus fortnight rotation — service days already live in the row context, so
 * they are not repeated here. "—" while the stored configuration is too
 * incomplete to derive from (D15: never fall back to a stored display
 * string).
 */
export function schemeRecurrenceSummary(record: BusinessRecord): string {
  const recurrence = recurrenceFromValues(record.submittedValues ?? {})
  return recurrence ? recurrenceCadenceLabel(recurrence) : EMPTY
}

/**
 * The Collection calendar column: the linked calendar record's live name. A
 * structured `calendarId` that no longer resolves renders "—" (the calendar
 * was deleted); only a record with no structured id at all falls back to its
 * legacy display fact (D28i), folded through canonicalCalendarName so
 * pre-rename copies agree with the filter facet.
 */
export function schemeCalendarName(
  record: BusinessRecord,
  calendars: readonly BusinessRecord[],
): string {
  const calendarId = stringValue(record.submittedValues ?? {}, "calendarId")
  if (calendarId) {
    return calendars.find((calendar) => calendar.id === calendarId)?.name ?? EMPTY
  }
  return canonicalCalendarName(factOf(record, "Collection calendar")) ?? EMPTY
}

export type SchemeRowSummary = {
  recurrence: string
  calendar: string
}

/** The derived table cells for one scheme row (D15). */
export function schemeRowSummary(
  record: BusinessRecord,
  calendars: readonly BusinessRecord[],
): SchemeRowSummary {
  return {
    recurrence: schemeRecurrenceSummary(record),
    calendar: schemeCalendarName(record, calendars),
  }
}
