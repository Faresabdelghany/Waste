// Execution's closed lists (Issue #104): where a dated Route and its Pickups
// stand, why a stop was not collected, what a Proof of Service is evidence
// of, who recorded it, what a driver's device may say, what became of what it
// said, and what the outbox tells the other contexts. Like the Registry's,
// Planning's and Resources' (registry/vocabulary.ts, planning/vocabulary.ts,
// resources/vocabulary.ts), the database reads each list into its `CHECK`
// (`oneOf` in packages/db/src/schema/checks.ts) and the contracts read the
// same list into a `z.enum`, so the check at the API boundary and the check
// in the column cannot drift.
//
// Two lists are #97 part B's, spelled here first because part A of #104
// lands before part B has a host: `ROUTE_STATUSES` and `PICKUP_STATUSES`,
// verbatim as #97 §2 gives them, so generation writes what these rows read.
// The prototype's `Draft` folds into `planned` (a generated route is never a
// draft), Live's `Paused` is a reading of the session's `paused_at`, a
// pickup's `Next` and `Attention` are readings (the first open pickup by
// position; a failed one), and its `Rescheduled` is a Ticket's outcome and no
// status here. `skipped` is a stop nobody attempted — regeneration, a
// cancelled or ended route, a dispatcher's removal, a driver passing it by —
// and `failed` a stop the driver worked and could not collect; both carry a
// reason, and `PICKUP_REASONS` is the prototype's six driver reasons and the
// four the system writes. `DRIVER_PICKUP_REASONS` beside it is the six a
// device may send, a value of the list like Planning's `DEFAULT_WEEKEND`, so
// a command cannot claim a stop was skipped by regeneration. `PICKUP_OUTCOMES`
// is the statuses minus `planned`: what a correction gives and a correction
// proof carries, a list of its own since a column's check and an enum read it
// (nothing moves a pickup back to planned). `PROOF_KINDS` is the glossary's
// "time, GPS, photo, weight, signature, or driver event": seven driver events
// — `arrival`, `completion`, `skip`, `failure`, `problem` about a stop,
// `route-started` and `route-ended` about the route, so what the device said
// when it started and ended the day is a row and not a discarded body — four
// kinds of evidence, and `correction`, the dispatcher's audited change of an
// outcome; execution/proof-shapes.ts says what each carries.
// `DRIVER_COMMAND_KINDS` is the prototype's ten driver actions less
// `retry-sync` (the device's, not a command) and `reschedule-stop` (a
// Ticket's), plus `arrive`, the four evidence commands, `record-unload`, and
// `pause`/`resume` in place of breaks. `COMMAND_OUTCOMES` is what the receipt
// stores; `replayed` is the wire's word for the first outcome answered again
// and is never stored. `OUTBOX_KINDS` and `OUTBOX_AGGREGATES` are the events
// the outbox carries and what each is about: the table is Execution's and its
// vocabulary is the union of every context's news (#109 §7.20), so
// Resolution's three kinds and its `ticket` aggregate grew here in place, and
// Finance's two (Issue #112) — `invoice-issued` on an `invoice`, on every
// invoice a run issues and every credit note, and `settlement-closed` on a
// `settlement`, the two doors the e-conomic export consumes — after them.
//
// A value is a kebab-case token: it goes into a migration as a SQL literal
// and onto the wire as an enum member, and those are the same string. A list
// is a `readonly` tuple with a type read off it; `EXECUTION_VOCABULARIES`
// names them all for the test that walks them.

/** Where a dated Route stands: #97 B's five, verbatim. */
export const ROUTE_STATUSES = ["planned", "ready", "active", "completed", "cancelled"] as const
/** Where a Pickup stands: #97 B's four, verbatim; `skipped` was not attempted, `failed` was. */
export const PICKUP_STATUSES = ["planned", "completed", "skipped", "failed"] as const
/** The statuses a pickup may be moved to: every one but `planned`, which nothing moves a pickup back to. What a correction gives and a correction proof carries. */
export const PICKUP_OUTCOMES = ["completed", "skipped", "failed"] as const
/** Why a stop was skipped or failed: the driver's six, then the four the system writes. */
export const PICKUP_REASONS = ["inaccessible", "contamination", "not-presented", "capacity", "safety", "other", "route-ended", "route-cancelled", "removed-by-dispatcher", "regeneration"] as const
/** What a Proof of Service is: seven driver events — five about a stop, two about the route — four kinds of evidence, and the dispatcher's correction. */
export const PROOF_KINDS = ["arrival", "completion", "skip", "failure", "problem", "route-started", "route-ended", "photo", "weight", "signature", "note", "correction"] as const
/** Who recorded a proof or an unload. */
export const EXECUTION_SOURCES = ["driver-app", "dispatch", "integration"] as const
/** What a driver's device may say, one contract each. */
export const DRIVER_COMMAND_KINDS = ["start-route", "arrive", "complete-pickup", "skip-pickup", "fail-pickup", "report-problem", "add-photo", "add-weight", "add-signature", "add-note", "record-unload", "pause", "resume", "end-route"] as const
/** What the receipt stores of a command; a replay answers the stored one again and stores nothing. */
export const COMMAND_OUTCOMES = ["applied", "rejected"] as const
/** What the outbox tells the other contexts: Execution's twelve, then Resolution's three (Issue #109), which Finance reads, then Finance's two (Issue #112), which the export reads. */
export const OUTBOX_KINDS = ["route-dispatched", "route-started", "route-completed", "route-cancelled", "route-reassigned", "pickup-completed", "pickup-failed", "pickup-skipped", "pickup-problem-reported", "pickup-corrected", "unload-recorded", "command-rejected", "ticket-opened", "ticket-completed", "ticket-rejected", "invoice-issued", "settlement-closed"] as const
/** What an outbox event is about; the payload is that resource on the wire. */
export const OUTBOX_AGGREGATES = ["route", "pickup", "unload", "command", "ticket", "invoice", "settlement"] as const

export type RouteStatus = (typeof ROUTE_STATUSES)[number]
export type PickupStatus = (typeof PICKUP_STATUSES)[number]
export type PickupOutcome = (typeof PICKUP_OUTCOMES)[number]
export type PickupReason = (typeof PICKUP_REASONS)[number]
export type ProofKind = (typeof PROOF_KINDS)[number]
export type ExecutionSource = (typeof EXECUTION_SOURCES)[number]
export type DriverCommandKind = (typeof DRIVER_COMMAND_KINDS)[number]
export type CommandOutcome = (typeof COMMAND_OUTCOMES)[number]
export type OutboxKind = (typeof OUTBOX_KINDS)[number]
export type OutboxAggregate = (typeof OUTBOX_AGGREGATES)[number]

/**
 * The reasons a driver's device may give for a skip, a failure or a problem:
 * the prototype's six. Not a vocabulary but a value of one, like Planning's
 * `DEFAULT_WEEKEND` — the four the system writes (`route-ended`,
 * `route-cancelled`, `removed-by-dispatcher`, `regeneration`) are the
 * server's and the contracts' command bodies read this list, so a device
 * cannot say a stop was removed by the dispatcher.
 */
export const DRIVER_PICKUP_REASONS = ["inaccessible", "contamination", "not-presented", "capacity", "safety", "other"] as const satisfies readonly PickupReason[]
export type DriverPickupReason = (typeof DRIVER_PICKUP_REASONS)[number]

/** The two reasons the system writes when a route's end or cancellation closes its open pickups; a value beside the lists, like the driver's six. */
export const CLOSING_REASONS = ["route-ended", "route-cancelled"] as const satisfies readonly PickupReason[]
export type ClosingReason = (typeof CLOSING_REASONS)[number]

/** Every list of this module by its name, for a test that walks them and for a reader looking for the whole vocabulary at once. */
export const EXECUTION_VOCABULARIES = {
  ROUTE_STATUSES,
  PICKUP_STATUSES,
  PICKUP_OUTCOMES,
  PICKUP_REASONS,
  PROOF_KINDS,
  EXECUTION_SOURCES,
  DRIVER_COMMAND_KINDS,
  COMMAND_OUTCOMES,
  OUTBOX_KINDS,
  OUTBOX_AGGREGATES,
} as const satisfies Record<string, readonly [string, ...string[]]>
