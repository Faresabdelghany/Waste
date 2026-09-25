// Resolution's closed lists (Issue #109): where a Ticket stands, what kind of
// case it is, how urgent, where it came from, what a completed one ended in,
// what a row of its history is and who may read it, and what an Alert is, how
// severe, who raised it and where it stands. Like Execution's and the three
// contexts' before it (execution/vocabulary.ts, registry/vocabulary.ts,
// planning/vocabulary.ts, resources/vocabulary.ts), the database reads each
// list into its `CHECK` (`oneOf` in packages/db/src/schema/checks.ts) and the
// contracts read the same list into a `z.enum`, so the check at the API
// boundary and the check in the column cannot drift.
//
// The Ticket is the glossary's "case that owns the resolution of a request,
// deviation, complaint, task, or operational issue" (CONTEXT.md), so a
// deviation, a complaint and a request are kinds of one Ticket and none is a
// table (`TICKET_KINDS`: the prototype's five types, its repair ticket on a
// defective container, the glossary's complaint and task, and the two the
// outbox's consumer writes — `reported-problem` for a `pickup-problem-reported`
// and `rejected-command` for a `command-rejected`, ADR-0004). `TICKET_STATUSES`
// is the prototype's seven less `Created`, which folds into `open` the way
// `Draft` folded into `planned` (#104 §2): a ticket is created for zero
// seconds, and `created_at` says when; `pending` is waiting on the customer,
// `on-hold` waiting on us, `completed` and `rejected` are closed.
// `TICKET_SOURCES` spells the driver as Execution spells it (`driver-app`)
// and puts `dispatch` beside it, since a stop closed by a dispatcher's
// cancellation is the dispatcher's word. `TICKET_RESOLUTIONS` is what a
// `completed` ticket ended in — a re-collection arranged, the request
// fulfilled, information given, nothing to do, a duplicate — and a `rejected`
// ticket has a reason and no resolution. `TICKET_EVENT_KINDS` is what a
// history row is; there is no `edited`, since the history of a field edit is
// the audit log's and not the domain model's (ADR-0005). `TICKET_VISIBILITIES`
// is who may read a comment: the office, or the office and the customer the
// ticket is about; every other kind of row is `internal`, which
// resolution/event-shapes.ts holds. The Alert is "a condition that requires
// attention, notification, or acknowledgement and may create or link to a
// ticket": `ALERT_KINDS` the prototype's six condition types as tokens,
// `ALERT_SOURCES` who raised it — `manual` is the one written here; the
// prototype's rule, route event and sensor keep their token so a later source
// is a code change and not a migration — and `ALERT_STATUSES` the prototype's
// four less "Linked to ticket", which is a reading of `ticket_id`.
//
// Two values beside the lists, the way Execution's `CLOSING_REASONS` and
// Planning's `DEFAULT_WEEKEND` are values and not vocabularies:
// `OPEN_TICKET_STATUSES` is what "open" means in a list filter and a count,
// and `CLOSED_TICKET_STATUSES` what every command but `reopen` and `comment`
// refuses (resolution/transitions.ts).
//
// A value is a kebab-case token: it goes into a migration as a SQL literal
// and onto the wire as an enum member, and those are the same string. A list
// is a `readonly` tuple with a type read off it; `RESOLUTION_VOCABULARIES`
// names them all for the test that walks them.

/** Where a Ticket stands: the prototype's seven less `Created`, which is `created_at`. */
export const TICKET_STATUSES = ["open", "in-progress", "pending", "on-hold", "completed", "rejected"] as const
/** What kind of case a Ticket is: the prototype's five, the repair ticket, the glossary's complaint and task, the consumer's two, and other. */
export const TICKET_KINDS = ["missed-collection", "overflow", "access-issue", "container-request", "container-defect", "proof-follow-up", "complaint", "reported-problem", "rejected-command", "internal-task", "other"] as const
/** How urgent: the prototype's five, `none` the default. */
export const TICKET_PRIORITIES = ["critical", "high", "medium", "low", "none"] as const
/** Where a Ticket came from: the office's doors, the driver's device as Execution spells it, the dispatcher's word, and two machines. */
export const TICKET_SOURCES = ["office", "phone", "email", "portal", "driver-app", "dispatch", "import", "integration"] as const
/** What a completed Ticket ended in; a rejected one has a reason and no resolution. */
export const TICKET_RESOLUTIONS = ["recollected", "serviced", "answered", "no-action", "duplicate"] as const
/** What a row of a Ticket's history is; there is no `edited` (ADR-0005). */
export const TICKET_EVENT_KINDS = ["created", "assigned", "status-changed", "comment"] as const
/** Who may read a comment: the office, or the office and the customer. */
export const TICKET_VISIBILITIES = ["internal", "customer"] as const
/** What an Alert is about: the prototype's six condition types, verbatim as tokens. */
export const ALERT_KINDS = ["route-exception", "resource", "service-risk", "asset", "weight", "other"] as const
/** How severe an Alert is. */
export const ALERT_SEVERITIES = ["critical", "high", "medium", "low"] as const
/** Who raised an Alert; `manual` is the one written by the office, the other three wait for their sources. */
export const ALERT_SOURCES = ["manual", "execution", "telemetry", "rule"] as const
/** Where an Alert stands; "linked to a ticket" is a reading of `ticket_id`, not a status. */
export const ALERT_STATUSES = ["new", "acknowledged", "resolved"] as const

export type TicketStatus = (typeof TICKET_STATUSES)[number]
export type TicketKind = (typeof TICKET_KINDS)[number]
export type TicketPriority = (typeof TICKET_PRIORITIES)[number]
export type TicketSource = (typeof TICKET_SOURCES)[number]
export type TicketResolution = (typeof TICKET_RESOLUTIONS)[number]
export type TicketEventKind = (typeof TICKET_EVENT_KINDS)[number]
export type TicketVisibility = (typeof TICKET_VISIBILITIES)[number]
export type AlertKind = (typeof ALERT_KINDS)[number]
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number]
export type AlertSource = (typeof ALERT_SOURCES)[number]
export type AlertStatus = (typeof ALERT_STATUSES)[number]

/** The statuses a Ticket is open in: what "open" means in a list filter and a count. A value of `TICKET_STATUSES`, not a vocabulary. */
export const OPEN_TICKET_STATUSES = ["open", "in-progress", "pending", "on-hold"] as const satisfies readonly TicketStatus[]
export type OpenTicketStatus = (typeof OPEN_TICKET_STATUSES)[number]

/** The statuses a Ticket is closed in: what every command but `reopen` and a comment refuses. A value of `TICKET_STATUSES`, not a vocabulary. */
export const CLOSED_TICKET_STATUSES = ["completed", "rejected"] as const satisfies readonly TicketStatus[]
export type ClosedTicketStatus = (typeof CLOSED_TICKET_STATUSES)[number]

/** Whether a Ticket in this status is closed: completed or rejected. */
export const isClosedTicketStatus = (status: TicketStatus): status is ClosedTicketStatus => (CLOSED_TICKET_STATUSES as readonly TicketStatus[]).includes(status)

/** Every list of this module by its name, for a test that walks them and for a reader looking for the whole vocabulary at once. */
export const RESOLUTION_VOCABULARIES = {
  TICKET_STATUSES,
  TICKET_KINDS,
  TICKET_PRIORITIES,
  TICKET_SOURCES,
  TICKET_RESOLUTIONS,
  TICKET_EVENT_KINDS,
  TICKET_VISIBILITIES,
  ALERT_KINDS,
  ALERT_SEVERITIES,
  ALERT_SOURCES,
  ALERT_STATUSES,
} as const satisfies Record<string, readonly [string, ...string[]]>
