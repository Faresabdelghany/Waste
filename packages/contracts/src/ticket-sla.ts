// A project's ticket SLA on the wire (O4 of #290): the targets a ticket is
// due by, each the hours from when it happened to its due date for a priority, for
// every kind (`kind` null) or for one kind, the kind's own winning
// (@waste/domain/resolution/sla), or since #548 of #544 for one Ticket Type,
// whose own wins over its kind's. `GET /projects/:id/ticket-sla` answers
// them and `PUT` replaces them whole: a target the body leaves out is gone, a
// target it keeps moves only its hours and keeps its id, so the audit log
// reads one row's history per kind and priority. A project without targets
// opens tickets due never, as before.
import { duplicateSlaTarget, SLA_KIND_OR_TYPE, TICKET_SLA_HOURS_MAX } from "@waste/domain/resolution/sla"
import { TICKET_TYPE_SETTINGS_MAX } from "@waste/domain/resolution/ticket-types"
import { TICKET_KINDS, TICKET_PRIORITIES } from "@waste/domain/resolution/vocabulary"
import * as z from "zod"

import { Id } from "./ids"
import { TicketKind, TicketPriority } from "./resolution"
import { eachOnceSentence, PositiveInt } from "./resource"

/** From when a ticket's issue happened to its due date, in whole hours: one to a year. */
export const SlaHours = PositiveInt.max(TICKET_SLA_HOURS_MAX)

const targetFields = {
  /** The kind the target is for; null for every kind without one of its own, or where a type is named. */
  kind: TicketKind.nullable(),
  /** The Ticket Type the target is for (#548 of #544), whose own wins over its kind's; null for a kind's or every kind's. */
  ticketTypeId: Id.nullable(),
  priority: TicketPriority,
  hours: SlaHours,
}

export const TicketSlaTarget = z.object({ id: Id, ...targetFields })
export type TicketSlaTarget = z.infer<typeof TicketSlaTarget>

/** A project's targets, by priority in the vocabulary's order, every kind before the kinds, the kinds before the types. */
export const TicketSla = z.object({ projectId: Id, targets: z.array(TicketSlaTarget) })
export type TicketSla = z.infer<typeof TicketSla>

/** The most targets a project holds: every kind, each kind and the types it names, at each priority. */
export const TICKET_SLA_TARGETS_MAX = (TICKET_KINDS.length + 1 + TICKET_TYPE_SETTINGS_MAX) * TICKET_PRIORITIES.length

/** What a set naming a kind or a type and a priority twice is told. */
export const SLA_TARGET_ONCE = eachOnceSentence("kind or ticket type and priority", "a ticket is due by one target")

/** `PUT /projects/:id/ticket-sla`: the whole set; each kind or type and priority once, every kind counting as one, and never a kind's and a type's at once. */
export const TicketSlaSet = z
  .strictObject({ targets: z.array(z.strictObject({ ...targetFields, ticketTypeId: Id.nullable().default(null).describe("Null when absent: a kind's or every kind's target.") })).max(TICKET_SLA_TARGETS_MAX) })
  // zod 4 runs a check on a body whose fields failed: read the entries with care.
  .superRefine((body, context) => {
    for (const [index, target] of body.targets.entries()) {
      if (target !== undefined && target.kind !== null && target.ticketTypeId !== null) context.addIssue({ code: "custom", message: SLA_KIND_OR_TYPE, path: ["targets", index] })
    }
    const at = duplicateSlaTarget(body.targets.filter((target) => target !== undefined))
    if (at !== undefined) context.addIssue({ code: "custom", message: SLA_TARGET_ONCE, path: ["targets", at] })
  })
export type TicketSlaSet = z.infer<typeof TicketSlaSet>
