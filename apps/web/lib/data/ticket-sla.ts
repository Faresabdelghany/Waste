// Settings › Ticket SLA (O4 of #290): a project's targets — the hours a ticket
// of a priority has from opening to its due date, for every kind or for one
// kind — as rows a person edits, and the body `PUT /projects/:id/ticket-sla`
// replaces the set with. The pane reads and writes the API directly
// (components/settings/ticket-sla-settings.tsx): the set is one project's
// configuration, not records of a workspace module. A row the API would
// refuse is refused here first, at the row, in the API's sentence.
import type { TicketSla, TicketSlaSet } from "@waste/contracts/ticket-sla"
import { duplicateSlaTarget, slaTargetKey, TICKET_SLA_HOURS_MAX } from "@waste/domain/resolution/sla"
import { TICKET_KINDS, TICKET_PRIORITIES, type TicketKind, type TicketPriority } from "@waste/domain/resolution/vocabulary"

import { allows, type Grants } from "../api/grants"
import { statusLabel } from "../api/records/adapter"

/** The pane, offered on the Pilot alone: the SLA is the API's. */
export const TICKET_SLA_SETTINGS_PANE_ID = "ticket-sla"

/** The kind picker's value for every kind: the wire's null. */
export const EVERY_KIND = "every-kind"

/** One target as the form holds it: the picks and the hours as typed, under a key React keeps it by. */
export type SlaRow = { key: string; kind: string; priority: string; hours: string }

export type SlaOption = { value: string; label: string }

export const SLA_KIND_OPTIONS: readonly SlaOption[] = [{ value: EVERY_KIND, label: "Every kind" }, ...TICKET_KINDS.map((kind) => ({ value: kind, label: statusLabel(kind) }))]
export const SLA_PRIORITY_OPTIONS: readonly SlaOption[] = TICKET_PRIORITIES.map((priority) => ({ value: priority, label: statusLabel(priority) }))

/** The hours a new row starts at: a day. */
const NEW_ROW_HOURS = "24"

export const HOURS_SENTENCE = `Give the hours as a whole number from 1 to ${TICKET_SLA_HOURS_MAX}`
/** The contracts' `SLA_TARGET_ONCE`, spelled again since the web imports no zod; a test holds the two equal. */
export const ONCE_SENTENCE = "Name each kind and priority once: a ticket is due by one target"

/** The project's targets as rows, in the API's order. */
export const slaRowsOf = (sla: TicketSla): SlaRow[] => sla.targets.map((target) => ({ key: target.id, kind: target.kind ?? EVERY_KIND, priority: target.priority, hours: String(target.hours) }))

/** A row's kind and priority as the domain names a target by, every kind as null. */
const pairOf = (row: Pick<SlaRow, "kind" | "priority">) => slaTargetKey({ kind: row.kind === EVERY_KIND ? null : row.kind, priority: row.priority })

/** A row to add: every kind at the first priority without one, else the first kind free at the first priority with room. */
export function newSlaRow(rows: readonly SlaRow[], key: string): SlaRow {
  const taken = new Set(rows.map(pairOf))
  for (const kind of [EVERY_KIND, ...TICKET_KINDS]) {
    const priority = TICKET_PRIORITIES.find((candidate) => !taken.has(pairOf({ kind, priority: candidate })))
    if (priority !== undefined) return { key, kind, priority, hours: NEW_ROW_HOURS }
  }
  return { key, kind: EVERY_KIND, priority: TICKET_PRIORITIES[0], hours: NEW_ROW_HOURS }
}

/** What the form refuses before the API sees it: the row, the field and why. */
export type SlaRefusal = { index: number; field: "kind" | "hours"; message: string }

export const isSlaRefusal = (value: TicketSlaSet | SlaRefusal): value is SlaRefusal => "index" in value

/** The body the rows become, or the first row the API would refuse. */
export function slaBodyOf(rows: readonly SlaRow[]): TicketSlaSet | SlaRefusal {
  const targets: TicketSlaSet["targets"] = []
  for (const [index, row] of rows.entries()) {
    const typed = row.hours.trim()
    const hours = /^\d+$/.test(typed) ? Number(typed) : Number.NaN
    if (!(hours >= 1 && hours <= TICKET_SLA_HOURS_MAX)) return { index, field: "hours", message: HOURS_SENTENCE }
    targets.push({ kind: row.kind === EVERY_KIND ? null : (row.kind as TicketKind), priority: row.priority as TicketPriority, hours })
  }
  const twice = duplicateSlaTarget(targets)
  return twice === undefined ? { targets } : { index: twice, field: "kind", message: ONCE_SENTENCE }
}

/** What the person's role lets them do with the SLA: read it under `view` on the templates' module, set it under `edit`. */
export const slaAccessOf = (grants: Grants | undefined): { view: boolean; edit: boolean } => ({
  view: allows(grants, "configure.templates", "view"),
  edit: allows(grants, "configure.templates", "edit"),
})
