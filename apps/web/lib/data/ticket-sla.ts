// Settings › Ticket SLA (O4 of #290): a project's targets — the hours a ticket
// of a priority has from opening to its due date, for every kind or for one
// kind — as rows a person edits, and the body `PUT /projects/:id/ticket-sla`
// replaces the set with. The pane reads and writes the API directly
// (components/settings/ticket-sla-settings.tsx): the set is one project's
// configuration, not records of a workspace module. A row the API would
// refuse is refused here first, at the row, in the API's sentence.
import type { TicketSla, TicketSlaSet } from "@waste/contracts/ticket-sla"
import { duplicateSlaTarget, SLA_TARGET_ONCE, slaTargetKey, TICKET_SLA_HOURS_MAX } from "@waste/domain/resolution/sla"
import { TICKET_KINDS, TICKET_PRIORITIES, type TicketPriority } from "@waste/domain/resolution/vocabulary"

import { type Grants, mayOn } from "@/lib/modules/grants"
import { statusLabel } from "@/lib/records/fields"
import { scopeOfValue, typeLabel, typeScope, valueOfScope, type TypeChoice } from "./ticket-scope"

/** The kind picker's value for every kind: the wire's null. */
export const EVERY_KIND = "every-kind"

/** One target as the form holds it: the picks and the hours as typed, under a key React keeps it by. `kind` is the picker's value: every kind, a kind, or a type (`typeScope`, #548 of #544). */
export type SlaRow = { key: string; kind: string; priority: string; hours: string }

export type SlaOption = { value: string; label: string }

export const SLA_KIND_OPTIONS: readonly SlaOption[] = [{ value: EVERY_KIND, label: "Every kind" }, ...TICKET_KINDS.map((kind) => ({ value: kind, label: statusLabel(kind) }))]
export const SLA_PRIORITY_OPTIONS: readonly SlaOption[] = TICKET_PRIORITIES.map((priority) => ({ value: priority, label: statusLabel(priority) }))

/** What a target may be for: every kind, each kind, and the types listed (#548 of #544), a type's own winning over its kind's. */
export const slaScopeOptions = (types: readonly TypeChoice[]): SlaOption[] => [...SLA_KIND_OPTIONS, ...types.map((type) => ({ value: typeScope(type.id), label: typeLabel(type) }))]

const NEW_ROW_HOURS = "24"

export const HOURS_SENTENCE = `Give the hours as a whole number from 1 to ${TICKET_SLA_HOURS_MAX}`

/** The project's targets as rows, in the API's order. */
export const slaRowsOf = (sla: TicketSla): SlaRow[] => sla.targets.map((target) => ({ key: target.id, kind: valueOfScope(target, EVERY_KIND), priority: target.priority, hours: String(target.hours) }))

export const typesNamedBy = (sla: TicketSla): string[] => sla.targets.flatMap((target) => (target.ticketTypeId === null ? [] : [target.ticketTypeId]))

const pairOf = (row: Pick<SlaRow, "kind" | "priority">) => slaTargetKey({ ...scopeOfValue(row.kind, EVERY_KIND), priority: row.priority })

/** A row to add: every kind at the first priority without one, else the first kind free at the first priority with room, else the first type listed free (#548 of #544). */
export function newSlaRow(rows: readonly SlaRow[], key: string, types: readonly Pick<TypeChoice, "id">[] = []): SlaRow {
  const taken = new Set(rows.map(pairOf))
  for (const kind of [EVERY_KIND, ...TICKET_KINDS, ...types.map((type) => typeScope(type.id))]) {
    const priority = TICKET_PRIORITIES.find((candidate) => !taken.has(pairOf({ kind, priority: candidate })))
    if (priority !== undefined) return { key, kind, priority, hours: NEW_ROW_HOURS }
  }
  return { key, kind: EVERY_KIND, priority: TICKET_PRIORITIES[0], hours: NEW_ROW_HOURS }
}

export type SlaRefusal = { index: number; field: "kind" | "hours"; message: string }

export const isSlaRefusal = (value: TicketSlaSet | SlaRefusal): value is SlaRefusal => "index" in value

export function slaBodyOf(rows: readonly SlaRow[]): TicketSlaSet | SlaRefusal {
  const targets: TicketSlaSet["targets"] = []
  for (const [index, row] of rows.entries()) {
    const typed = row.hours.trim()
    const hours = /^\d+$/.test(typed) ? Number(typed) : Number.NaN
    if (!(hours >= 1 && hours <= TICKET_SLA_HOURS_MAX)) return { index, field: "hours", message: HOURS_SENTENCE }
    targets.push({ ...scopeOfValue(row.kind, EVERY_KIND), priority: row.priority as TicketPriority, hours })
  }
  const twice = duplicateSlaTarget(targets)
  return twice === undefined ? { targets } : { index: twice, field: "kind", message: SLA_TARGET_ONCE }
}

export function slaSavedSentence(projectName: string, targets: number): string {
  if (targets === 0) return `${projectName} has no SLA now: tickets opened from now on have no due date unless someone gives one.`
  return targets === 1 ? `${projectName} has one target. Tickets opened from now on are due by it.` : `${projectName} has ${targets} targets. Tickets opened from now on are due by them.`
}

/** What the person's role lets them do with the SLA: read it under `view` on the templates' module, set it under `edit`. */
export const slaAccessOf = (grants: Grants | null): { view: boolean; edit: boolean } => ({
  view: mayOn(grants, "configure.templates", "view"),
  edit: mayOn(grants, "configure.templates", "edit"),
})
