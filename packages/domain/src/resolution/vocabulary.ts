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
// cancellation is the dispatcher's word; `service-provider` is a ticket a
// Service Provider's account raised from its workspace on a route it runs
// (#291 slice 23b, migration 0025), which only the API writes. `TICKET_RESOLUTIONS` is what a
// `completed` ticket ended in — a re-collection arranged, the request
// fulfilled, information given, nothing to do, a duplicate — and a `rejected`
// ticket has a reason and no resolution. `TICKET_EVENT_KINDS` is what a
// history row is; there is no `edited`, since the history of a field edit is
// the audit log's and not the domain model's (ADR-0005). `TICKET_VISIBILITIES`
// is who may read a comment: the office, the office and the customer the
// ticket is about, or the office and the Service Provider that runs the
// ticket's route (#291 slice 23b, migration 0025) — the one thread a
// provider's account reads, and what its own comments are; every other kind
// of row is `internal`, which resolution/event-shapes.ts holds. The Alert is "a condition that requires
// attention, notification, or acknowledgement and may create or link to a
// ticket": `ALERT_KINDS` the prototype's six condition types as tokens,
// `ALERT_SOURCES` who raised it — `manual` the office, `rule` and `execution`
// the worker's rules (O4 of #290), and the sensor's token kept so a later
// source is a code change and not a migration — `ALERT_STATUSES` the
// prototype's four less "Linked to ticket", which is a reading of
// `ticket_id`, and `ALERT_RULES` the worker's rules an alert is raised by
// (resolution/alert-rules.ts). `TEAM_STATUSES` is whether a Team takes
// tickets (O30 of #290, row 7.20): a team is retired, never deleted, since
// the tickets it held still name it. A Ticket Type (#545 of #544) is the
// company's own name for a kind of case, inside one kind
// (resolution/ticket-types.ts): `TICKET_TYPE_STATUSES` is whether it is
// offered to a new ticket, retired the way a team is; `TICKET_FIELD_INPUTS`
// is what a custom field of a type takes — a line, a paragraph, a number, a
// date, yes or no, or one of its choices — and `TICKET_FIELD_REQUIREMENTS`
// when it must be filled in: never, to open the ticket, or to complete it.
// A type's automation (#546 of #544, resolution/automation.ts) runs on one of
// `TICKET_ACTION_TRIGGERS` — opened, or reaching a status a command leads to
// — and does one of `TICKET_ACTION_KINDS`; a status it moves to is one of
// `TICKET_ACTION_COMMANDS`, and a message it sends goes to one of
// `TICKET_MESSAGE_RECIPIENTS`, the ticket's customer or a role at its
// property, the Registry's party roles by the same tokens. Those three are
// read off their parents — the statuses, the office's commands, the party
// roles — so a value added there reaches them.
//
// Four values beside the lists, the way Execution's `CLOSING_REASONS` and
// Planning's `DEFAULT_WEEKEND` are values and not vocabularies:
// `OPEN_TICKET_STATUSES` is what "open" means in a list filter and a count,
// `CLOSED_TICKET_STATUSES` what every command but `reopen` and `comment`
// refuses (resolution/transitions.ts), `BILLABLE_RESOLUTIONS` the
// resolutions whose work Finance charges for (finance/from-event.ts), which a
// completion may name its product with (#291 C3), and `OFFICE_TICKET_SOURCES`
// the sources a ticket the office opens may claim.
//
// A value is a kebab-case token: it goes into a migration as a SQL literal
// and onto the wire as an enum member, and those are the same string. A list
// is a `readonly` tuple with a type read off it; `RESOLUTION_VOCABULARIES`
// names them all for the test that walks them.
import { mapped, without } from "../lists"
import { PROPERTY_PARTY_ROLES } from "../registry/vocabulary"

/** Where a Ticket stands: the prototype's seven less `Created`, which is `created_at`. */
export const TICKET_STATUSES = ["open", "in-progress", "pending", "on-hold", "completed", "rejected"] as const
/** What kind of case a Ticket is: the prototype's five, the repair ticket, the glossary's complaint and task, the consumer's two, and other. */
export const TICKET_KINDS = ["missed-collection", "overflow", "access-issue", "container-request", "container-defect", "proof-follow-up", "complaint", "reported-problem", "rejected-command", "internal-task", "other"] as const
/** How urgent: the prototype's five, `none` the default. */
export const TICKET_PRIORITIES = ["critical", "high", "medium", "low", "none"] as const
/** Where a Ticket came from: the office's doors, the driver's device as Execution spells it, the dispatcher's word, two machines, a Service Provider's workspace, and a counting rule's limit reached (#547 of #544). */
export const TICKET_SOURCES = ["office", "phone", "email", "portal", "driver-app", "dispatch", "import", "integration", "service-provider", "counting-rule"] as const
/** What a completed Ticket ended in; a rejected one has a reason and no resolution. */
export const TICKET_RESOLUTIONS = ["recollected", "serviced", "answered", "no-action", "duplicate"] as const
/** What a row of a Ticket's history is; there is no `edited` (ADR-0005). */
export const TICKET_EVENT_KINDS = ["created", "assigned", "status-changed", "comment"] as const
/** Who may read a comment: the office, the office and the customer, or the office and the Service Provider running the ticket's route. */
export const TICKET_VISIBILITIES = ["internal", "customer", "service-provider"] as const
/** What an Alert is about: the prototype's six condition types, verbatim as tokens. */
export const ALERT_KINDS = ["route-exception", "resource", "service-risk", "asset", "weight", "other"] as const
/** How severe an Alert is. */
export const ALERT_SEVERITIES = ["critical", "high", "medium", "low"] as const
/** Who raised an Alert: the office (`manual`), the worker's rules (`rule`, `execution` for a condition of the work itself, and `telemetry` for what a device reports: a driver's position, a container's fill level). */
export const ALERT_SOURCES = ["manual", "execution", "telemetry", "rule"] as const
/** Where an Alert stands; "linked to a ticket" is a reading of `ticket_id`, not a status. */
export const ALERT_STATUSES = ["new", "acknowledged", "resolved"] as const
/** Whether a Team takes tickets (O30 of #290, row 7.20): an inactive team is offered to no new ticket and keeps the ones it holds. */
export const TEAM_STATUSES = ["active", "inactive"] as const
/** Whether a Ticket Type is offered to a new ticket (#545 of #544): an inactive type is offered to none and keeps the tickets it holds. */
export const TICKET_TYPE_STATUSES = ["active", "inactive"] as const
/** What a Ticket Type's custom field takes: a line of text, a paragraph, a number, a calendar date, yes or no, or one of the field's choices. */
export const TICKET_FIELD_INPUTS = ["text", "paragraph", "number", "date", "yes-no", "choice"] as const
/** When a custom field must be filled in: never, before the ticket is opened, or before it is completed. */
export const TICKET_FIELD_REQUIREMENTS = ["optional", "to-open", "to-complete"] as const
/** What moves a ticket: the office's six commands. `assign` moves the assignee and not the status, and a comment moves nothing, so neither is here. */
export const TICKET_COMMANDS = ["start", "wait", "hold", "complete", "reject", "reopen"] as const
/** When a Ticket Type's actions run (#546 of #544): a ticket of it opened, or reaching one of the statuses a command leads to — every status, `open` named for the event. */
export const TICKET_ACTION_TRIGGERS = mapped(TICKET_STATUSES, (status): "opened" | Exclude<TicketStatus, "open"> => (status === "open" ? "opened" : status))
/** What one of a type's actions does: hands the ticket to a team or a person, sets its priority, moves its status, sends a message from a template, or opens a follow-up ticket. */
export const TICKET_ACTION_KINDS = ["assign-team", "assign-person", "set-priority", "set-status", "send-message", "open-follow-up", "plan-in-route"] as const
/** The status commands an action may give: every one but reopening, which undoes a close an automation should not second-guess. */
export const TICKET_ACTION_COMMANDS = without(TICKET_COMMANDS, "reopen")
/** Who a message an action sends goes to: the customer the ticket names, or the customer in a role at its property. */
export const TICKET_MESSAGE_RECIPIENTS = ["ticket-customer", ...PROPERTY_PARTY_ROLES] as const
/** The calendar period a Counting Rule counts over (#547 of #544): a month, a quarter or a year. */
export const COUNTING_PERIODS = ["month", "quarter", "year"] as const
/** Whether a Counting Rule counts (#547 of #544): an inactive rule counts nothing and opens no ticket, and may be simulated before it is switched on. */
export const COUNTING_RULE_STATUSES = ["active", "inactive"] as const
/** The worker's rules an Alert is raised by (O4 of #290, O8's stale position, O26's filling container, O20's maintenance due, and M17 of #293's disposal-site reconciliation); null on an alert a person raised. */
export const ALERT_RULES = ["route-not-started", "session-silent", "licence-expiring", "ticket-overdue", "position-stale", "fill-threshold", "maintenance-due", "load-not-received", "load-weight-mismatch", "load-overweight", "route-not-tipped"] as const

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
export type AlertRule = (typeof ALERT_RULES)[number]
export type TeamStatus = (typeof TEAM_STATUSES)[number]
export type TicketTypeStatus = (typeof TICKET_TYPE_STATUSES)[number]
export type TicketFieldInput = (typeof TICKET_FIELD_INPUTS)[number]
export type TicketFieldRequirement = (typeof TICKET_FIELD_REQUIREMENTS)[number]
export type TicketCommand = (typeof TICKET_COMMANDS)[number]
export type TicketActionTrigger = (typeof TICKET_ACTION_TRIGGERS)[number]
export type TicketActionKind = (typeof TICKET_ACTION_KINDS)[number]
export type TicketActionCommand = (typeof TICKET_ACTION_COMMANDS)[number]
export type TicketMessageRecipient = (typeof TICKET_MESSAGE_RECIPIENTS)[number]
export type CountingPeriod = (typeof COUNTING_PERIODS)[number]
export type CountingRuleStatus = (typeof COUNTING_RULE_STATUSES)[number]

/** The statuses a Ticket is open in: what "open" means in a list filter and a count. A value of `TICKET_STATUSES`, not a vocabulary. */
export const OPEN_TICKET_STATUSES = ["open", "in-progress", "pending", "on-hold"] as const satisfies readonly TicketStatus[]
export type OpenTicketStatus = (typeof OPEN_TICKET_STATUSES)[number]

/** The statuses a Ticket is closed in: what every command but `reopen` and a comment refuses. A value of `TICKET_STATUSES`, not a vocabulary. */
export const CLOSED_TICKET_STATUSES = ["completed", "rejected"] as const satisfies readonly TicketStatus[]
export type ClosedTicketStatus = (typeof CLOSED_TICKET_STATUSES)[number]

/** Whether a Ticket in this status is closed: completed or rejected. */
export const isClosedTicketStatus = (status: TicketStatus): status is ClosedTicketStatus => (CLOSED_TICKET_STATUSES as readonly TicketStatus[]).includes(status)

/** The sources only their own door writes: the driver's device, the dispatcher's cancellation, a Service Provider's workspace, a counting rule's limit. */
const DOOR_TICKET_SOURCES = ["driver-app", "dispatch", "service-provider", "counting-rule"] as const satisfies readonly TicketSource[]

/** The sources a ticket the office opens may claim: every one but a door's own. A value of `TICKET_SOURCES`, not a vocabulary. */
export const OFFICE_TICKET_SOURCES = without(TICKET_SOURCES, ...DOOR_TICKET_SOURCES)

/** The resolutions whose completion is billable: a re-collection arranged, or the request fulfilled. A value of `TICKET_RESOLUTIONS`, not a vocabulary. */
export const BILLABLE_RESOLUTIONS = ["recollected", "serviced"] as const satisfies readonly TicketResolution[]

/** Whether a completed ticket's resolution is one the office may charge for: the list's membership, never a table's keys, so a stray string finds nothing. */
export const isBillableResolution = (resolution: TicketResolution): boolean => (BILLABLE_RESOLUTIONS as readonly string[]).includes(resolution)

/** The statuses a Team takes a new ticket in, as a ticket's, a rule's or a project's default team (`@waste/domain/status-gates`); a ticket it holds stays with it. */
export const ACTIVE_TEAM_STATUSES = ["active"] as const satisfies readonly TeamStatus[]

/** The statuses a Ticket Type is offered to a new ticket in (`@waste/domain/status-gates`); the type a ticket already is of is kept. */
export const ACTIVE_TICKET_TYPE_STATUSES = ["active"] as const satisfies readonly TicketTypeStatus[]

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
  ALERT_RULES,
  TEAM_STATUSES,
  TICKET_TYPE_STATUSES,
  TICKET_FIELD_INPUTS,
  TICKET_FIELD_REQUIREMENTS,
  TICKET_COMMANDS,
  TICKET_ACTION_TRIGGERS,
  TICKET_ACTION_KINDS,
  TICKET_ACTION_COMMANDS,
  TICKET_MESSAGE_RECIPIENTS,
  COUNTING_PERIODS,
  COUNTING_RULE_STATUSES,
} as const satisfies Record<string, readonly string[]>
