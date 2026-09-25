// What a row of a Ticket's history carries, kind by kind (Issue #109): the one
// table the database's `ticket_event_kind_shape` spells as a CASE
// (packages/db/src/schema/resolution.ts), the contracts' `TicketEvent` runs as
// a refine, and the API consults before it appends a row — the precedent is
// Execution's `PROOF_SHAPES` (execution/proof-shapes.ts), which the proof
// ledger's `proof_of_service_kind_shape` spells once more and a database test
// holds to it over every kind with each column set and unset. The same test
// runs here.
//
// Four kinds, a shape each. `created` is the first row of every ticket and
// says nothing but the status and the assignee the ticket started with: no
// body, no attachment, internal, no resolution. `assigned` may carry the note
// the command gave, no attachment, internal, no resolution. `status-changed`
// may carry the note or the reason a command gave, no attachment, internal,
// and a resolution exactly when the status it moved to is `completed` — the
// history's copy of `ticket_resolution_shape`, so the history reads without
// the row. `comment` carries a body, may carry an attachment's Storage key,
// may be read by the customer (`visibility`), and carries no resolution, since
// a comment changes nothing of the case.
//
// `ticketEventShape(kind, row)` is the whole rule over a row;
// `ticketEventShapeIssue` says which column disagrees, for the API's sentence
// before the check's code.
import type { Presence } from "../execution/proof-shapes"
import type { TicketEventKind, TicketStatus, TicketVisibility } from "./vocabulary"

export type { Presence }

/** What one kind of history row carries. */
export type TicketEventShape = {
  body: Presence
  objectKey: Presence
  /** Who may read it: the office alone, or either. */
  visibility: "internal" | "any"
  /** Whether the row carries no resolution, or one exactly when its status is completed. */
  resolution: "none" | "with-completed"
}

/** A row as the rule reads it: the columns the shape decides over. */
export type TicketEventRow = {
  /** The ticket's status after the event. */
  status: TicketStatus
  body: string | null
  objectKey: string | null
  visibility: TicketVisibility
  resolution: string | null
}

/** A row of the office's own: internal, no attachment, no resolution. */
const INTERNAL: TicketEventShape = { body: "none", objectKey: "none", visibility: "internal", resolution: "none" }

/** The table: what each of the four kinds carries. */
export const TICKET_EVENT_SHAPES: Readonly<Record<TicketEventKind, TicketEventShape>> = {
  created: INTERNAL,
  assigned: { ...INTERNAL, body: "any" },
  "status-changed": { ...INTERNAL, body: "any", resolution: "with-completed" },
  comment: { body: "required", objectKey: "any", visibility: "any", resolution: "none" },
}

/** The columns a `Presence` decides over, in the order the sentence names them. */
const PRESENCE_COLUMNS = ["body", "objectKey"] as const

const holds = (presence: Presence, value: unknown): boolean => (presence === "any" ? true : presence === "required" ? value !== null : value === null)

/** The column that disagrees with the kind's shape, as a sentence; undefined when the row is what its kind carries. */
export function ticketEventShapeIssue(kind: TicketEventKind, row: TicketEventRow): string | undefined {
  const shape = TICKET_EVENT_SHAPES[kind]
  for (const column of PRESENCE_COLUMNS) {
    if (holds(shape[column], row[column])) continue
    return shape[column] === "required" ? `A ${kind} event carries ${column}` : `A ${kind} event carries no ${column}`
  }
  if (shape.visibility === "internal" && row.visibility !== "internal") return `A ${kind} event is internal`
  if (shape.resolution === "none") {
    if (row.resolution !== null) return `A ${kind} event carries no resolution`
  } else if ((row.status === "completed") !== (row.resolution !== null)) {
    return `A ${kind} event carries a resolution exactly when its status is completed`
  }
  return undefined
}

/** Whether the row is what its kind carries: the body, the attachment, who may read it, the resolution. */
export const ticketEventShape = (kind: TicketEventKind, row: TicketEventRow): boolean => ticketEventShapeIssue(kind, row) === undefined
