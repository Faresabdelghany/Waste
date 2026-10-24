// A project's ticket SLA on the wire (O4 of #290): the targets a ticket is
// due by, each the hours from when it happened to its due date for a priority, for
// every kind (`kind` null) or for one kind, the kind's own winning
// (@waste/domain/resolution/sla). `GET /projects/:id/ticket-sla` answers
// them and `PUT` replaces them whole: a target the body leaves out is gone, a
// target it keeps moves only its hours and keeps its id, so the audit log
// reads one row's history per kind and priority. A project without targets
// opens tickets due never, as before.
import { duplicateSlaTarget, TICKET_SLA_HOURS_MAX } from "@waste/domain/resolution/sla"
import { TICKET_KINDS, TICKET_PRIORITIES } from "@waste/domain/resolution/vocabulary"
import * as z from "zod"

import { Id } from "./ids"
import { TicketKind, TicketPriority } from "./resolution"
import { eachOnceSentence, PositiveInt } from "./resource"

/** From when a ticket's issue happened to its due date, in whole hours: one to a year. */
export const SlaHours = PositiveInt.max(TICKET_SLA_HOURS_MAX)

const targetFields = {
  /** The kind the target is for; null for every kind without one of its own. */
  kind: TicketKind.nullable(),
  priority: TicketPriority,
  hours: SlaHours,
}

export const TicketSlaTarget = z.object({ id: Id, ...targetFields })
export type TicketSlaTarget = z.infer<typeof TicketSlaTarget>

/** A project's targets, by priority in the vocabulary's order, every kind before the kinds. */
export const TicketSla = z.object({ projectId: Id, targets: z.array(TicketSlaTarget) })
export type TicketSla = z.infer<typeof TicketSla>

/** The most targets a project holds: every kind and each kind, at each priority. */
export const TICKET_SLA_TARGETS_MAX = (TICKET_KINDS.length + 1) * TICKET_PRIORITIES.length

/** What a set naming a kind and a priority twice is told. */
export const SLA_TARGET_ONCE = eachOnceSentence("kind and priority", "a ticket is due by one target")

/** `PUT /projects/:id/ticket-sla`: the whole set; each kind and priority once, every kind counting as one. */
export const TicketSlaSet = z
  .strictObject({ targets: z.array(z.strictObject(targetFields)).max(TICKET_SLA_TARGETS_MAX) })
  // zod 4 runs a check on a body whose fields failed: read the entries with care.
  .superRefine((body, context) => {
    const at = duplicateSlaTarget(body.targets.filter((target) => target !== undefined))
    if (at !== undefined) context.addIssue({ code: "custom", message: SLA_TARGET_ONCE, path: ["targets", at] })
  })
export type TicketSlaSet = z.infer<typeof TicketSlaSet>
