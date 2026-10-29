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
// (nothing moves a pickup back to planned). `PICKUP_ORIGINS` says who put a
// stop on its route (#111): generation, or the office by hand — an extra stop
// on a generated route or a stop of a route the office made — which
// generation's refresh then leaves where the office put it.
// `ROUTE_CANCEL_REASON_CODES` says why a route was cancelled (O5 of #290):
// the office's eight — `OFFICE_CANCEL_REASON_CODES`, the value a cancel's
// body reads — and `regeneration`, which a run writes on a route its scheme
// no longer plans; the free note beside the code stays the route's note.
// `PROOF_KINDS` is the glossary's
// "time, GPS, photo, weight, signature, or driver event": seven driver events
// — `arrival`, `completion`, `skip`, `failure`, `problem` about a stop,
// `route-started` and `route-ended` about the route, so what the device said
// when it started and ended the day is a row and not a discarded body — four
// kinds of evidence, and `correction`, the dispatcher's audited change of an
// outcome; execution/proof-shapes.ts says what each carries.
// `DRIVER_COMMAND_KINDS` is the prototype's ten driver actions less
// `retry-sync` (the device's, not a command) and `reschedule-stop` (a
// Ticket's), plus `arrive`, the four evidence commands, `record-unload`, and
// `pause`/`resume` in place of breaks, and `record-positions`, where the
// vehicle was while the session ran (O8 of #290), and `pre-trip-check`, a
// vehicle's walk-round before or during the day (O13 of #290). `COMMAND_OUTCOMES` is what the receipt
// stores; `replayed` is the wire's word for the first outcome answered again
// and is never stored. `OUTBOX_KINDS` and `OUTBOX_AGGREGATES` are the events
// the outbox carries and what each is about: the table is Execution's and its
// vocabulary is the union of every context's news (#109 §7.20), so
// Resolution's three kinds and its `ticket` aggregate grew here in place, and
// Finance's two (Issue #112) — `invoice-issued` on an `invoice`, on every
// invoice a run issues and every credit note, and `settlement-closed` on a
// `settlement`, the two doors the e-conomic export consumes — after them, and
// the Registry's `application-decided` on an `application` (M7 of #293), the
// seam each kind's effect is consumed from in its owner's lane.
//
// `CONTAMINANT_CODE_STATUSES` is a contaminant code's (M5 of #293): a
// company's own codes for the wrong waste in a bin, which the office retires
// rather than deletes, since a stop names the code it was tagged with.
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
/** Who put a stop on its route (#111): generation, or the office by hand, whose stop a refresh never skips or moves. */
export const PICKUP_ORIGINS = ["generation", "office"] as const
/** What a stop is for (O3 of #290): emptying its container — generation's only service, and the office's too — or one of the office's work orders: a container delivered, removed or swapped, repaired or washed where it stands; or, since O11, a Bulky Booking's collection, the office's stop at an address with no container. */
export const PICKUP_SERVICES = ["empty", "deliver", "remove", "swap", "repair", "wash", "bulky"] as const
/** Where a Bulky Booking stands (O11 of #290): a reading of its cancel stamp and the stop that names it, never stored. */
export const BULKY_BOOKING_STATUSES = ["booked", "routed", "collected", "cancelled"] as const
/** Why a route was cancelled (O5 of #290): the office's eight, then the one the system writes when a run no longer plans the route. */
export const ROUTE_CANCEL_REASON_CODES = ["vehicle-breakdown", "crew-unavailable", "weather", "road-closure", "holiday", "duplicate", "merged", "other", "regeneration"] as const
/** What a Proof of Service is: seven driver events — five about a stop, two about the route — four kinds of evidence, and the dispatcher's correction. */
export const PROOF_KINDS = ["arrival", "completion", "skip", "failure", "problem", "route-started", "route-ended", "photo", "weight", "signature", "note", "correction"] as const
/** Who recorded a proof or an unload. */
export const EXECUTION_SOURCES = ["driver-app", "dispatch", "integration"] as const
/** What a driver's device may say, one contract each. */
export const DRIVER_COMMAND_KINDS = ["start-route", "arrive", "complete-pickup", "skip-pickup", "fail-pickup", "report-problem", "add-photo", "add-weight", "add-signature", "add-note", "record-unload", "pause", "resume", "end-route", "record-positions", "pre-trip-check"] as const
/** What the receipt stores of a command; a replay answers the stored one again and stores nothing. */
export const COMMAND_OUTCOMES = ["applied", "rejected"] as const
/** Why a station refused a load (O9 of #290): the facility's side of an unload, apart from weight review's `rejected`, which is the office rejecting a weighbridge reading. */
export const UNLOAD_REFUSAL_REASONS = ["contamination", "fraction-not-accepted", "hazardous", "overweight", "other"] as const
/** Where a Weighbridge Ticket stands (O27 of #290): matched to a route and written as its Unload, unmatched with the reason, or dismissed by the office with a note. */
export const WEIGHBRIDGE_TICKET_STATUSES = ["matched", "unmatched", "dismissed"] as const
/** Why a Weighbridge Ticket found no route on its own (O27 of #290): what the office reads in the queue before it matches the ticket by hand. */
export const WEIGHBRIDGE_UNMATCHED_REASONS = ["unknown-vehicle", "no-route", "several-routes", "unknown-fraction", "fraction-not-accepted"] as const
/** What a ticket of an ingest batch came to that is not kept (O27 of #290): a station not registered, or an instant ahead of the server's clock. */
export const WEIGHBRIDGE_REFUSALS = ["unknown-station", "ahead-of-clock"] as const
/** What the outbox tells the other contexts: Execution's twelve, then Resolution's three (Issue #109), which Finance reads, then Finance's two (Issue #112), which the export reads. */
export const OUTBOX_KINDS = ["route-dispatched", "route-started", "route-completed", "route-cancelled", "route-reassigned", "pickup-completed", "pickup-failed", "pickup-skipped", "pickup-problem-reported", "pickup-corrected", "unload-recorded", "command-rejected", "ticket-opened", "ticket-completed", "ticket-rejected", "invoice-issued", "settlement-closed", "application-decided", "site-visit-recorded", "site-visit-voided"] as const
/** What an outbox event is about; the payload is that resource on the wire. */
export const OUTBOX_AGGREGATES = ["route", "pickup", "unload", "command", "ticket", "invoice", "settlement", "application", "site-visit"] as const
/** A contaminant code's: in use, or retired from new tags while the stops tagged with it keep it. */
export const CONTAMINANT_CODE_STATUSES = ["active", "inactive"] as const

export type RouteStatus = (typeof ROUTE_STATUSES)[number]
export type PickupStatus = (typeof PICKUP_STATUSES)[number]
export type PickupOutcome = (typeof PICKUP_OUTCOMES)[number]
export type PickupReason = (typeof PICKUP_REASONS)[number]
export type PickupOrigin = (typeof PICKUP_ORIGINS)[number]
export type PickupService = (typeof PICKUP_SERVICES)[number]
export type BulkyBookingStatus = (typeof BULKY_BOOKING_STATUSES)[number]
export type RouteCancelReasonCode = (typeof ROUTE_CANCEL_REASON_CODES)[number]
export type ProofKind = (typeof PROOF_KINDS)[number]
export type ExecutionSource = (typeof EXECUTION_SOURCES)[number]
export type WeighbridgeTicketStatus = (typeof WEIGHBRIDGE_TICKET_STATUSES)[number]
export type WeighbridgeUnmatchedReason = (typeof WEIGHBRIDGE_UNMATCHED_REASONS)[number]
export type WeighbridgeRefusal = (typeof WEIGHBRIDGE_REFUSALS)[number]
export type DriverCommandKind = (typeof DRIVER_COMMAND_KINDS)[number]
export type CommandOutcome = (typeof COMMAND_OUTCOMES)[number]
export type UnloadRefusalReason = (typeof UNLOAD_REFUSAL_REASONS)[number]
export type OutboxKind = (typeof OUTBOX_KINDS)[number]
export type OutboxAggregate = (typeof OUTBOX_AGGREGATES)[number]
export type ContaminantCodeStatus = (typeof CONTAMINANT_CODE_STATUSES)[number]

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

/**
 * The services the office books on a stop it adds: every one. An emptying —
 * an extra one, of a container on the route already, included — a repair and
 * a wash, each of a container where it stands, and since O3b a delivery, a
 * removal and a swap, which move a container through the ledger as the stop
 * is completed (execution/work-orders.ts), and since O11 a Bulky Booking's
 * collection, at the booking's address with no container. Generation's stops
 * are emptyings alone. A value beside the lists, like the driver's six reasons.
 */
export const OFFICE_STOP_SERVICES = ["empty", "deliver", "remove", "swap", "repair", "wash", "bulky"] as const satisfies readonly PickupService[]
export type OfficeStopService = (typeof OFFICE_STOP_SERVICES)[number]

/**
 * The work orders a project prices (M14 of #293): every office service but an
 * emptying, which is a collection and priced as a pickup is. A project names
 * the `job` product each one bills (`work_order_product`); a value beside the
 * lists, like the office's services it is drawn from.
 */
export const WORK_ORDER_SERVICES = ["deliver", "remove", "swap", "repair", "wash"] as const satisfies readonly OfficeStopService[]
export type WorkOrderService = (typeof WORK_ORDER_SERVICES)[number]
export const isWorkOrderService = (service: PickupService): service is WorkOrderService => (WORK_ORDER_SERVICES as readonly PickupService[]).includes(service)

/**
 * The codes the office may give a cancel (O5 of #290): every one but
 * `regeneration`, which a generation run writes when the scheme no longer
 * plans the route — a value of the list, like the driver's six, so the
 * office's body cannot say a run cancelled it.
 */
export const OFFICE_CANCEL_REASON_CODES = ["vehicle-breakdown", "crew-unavailable", "weather", "road-closure", "holiday", "duplicate", "merged", "other"] as const satisfies readonly RouteCancelReasonCode[]
export type OfficeCancelReasonCode = (typeof OFFICE_CANCEL_REASON_CODES)[number]

/** The code a generation run writes on a route its scheme no longer plans. */
export const REGENERATION_CANCEL = "regeneration" satisfies RouteCancelReasonCode

/**
 * The reasons a Pickup Exception is missed for (M5 of #293): the driver's
 * reasons the customer caused — the wrong waste, a bin not out, a bin that
 * could not be reached, and the driver's `other` — never the operator's own
 * (`capacity`, `safety`) nor one the system writes. A value beside the lists,
 * like the driver's six.
 */
export const PICKUP_EXCEPTION_REASONS = ["contamination", "not-presented", "inaccessible", "other"] as const satisfies readonly DriverPickupReason[]
export type PickupExceptionReason = (typeof PICKUP_EXCEPTION_REASONS)[number]

/** The proofs that may name a contaminant code: the ones that record an outcome, the office's correction among them. */
export const CODED_PROOF_KINDS = ["completion", "skip", "failure", "correction"] as const satisfies readonly ProofKind[]

/** The two reasons the system writes when a route's end or cancellation closes its open pickups; a value beside the lists, like the driver's six. */
export const CLOSING_REASONS = ["route-ended", "route-cancelled"] as const satisfies readonly PickupReason[]
export type ClosingReason = (typeof CLOSING_REASONS)[number]

/** Every list of this module by its name, for a test that walks them and for a reader looking for the whole vocabulary at once. */
export const EXECUTION_VOCABULARIES = {
  ROUTE_STATUSES,
  PICKUP_STATUSES,
  PICKUP_OUTCOMES,
  PICKUP_REASONS,
  PICKUP_ORIGINS,
  PICKUP_SERVICES,
  BULKY_BOOKING_STATUSES,
  ROUTE_CANCEL_REASON_CODES,
  PROOF_KINDS,
  EXECUTION_SOURCES,
  DRIVER_COMMAND_KINDS,
  COMMAND_OUTCOMES,
  UNLOAD_REFUSAL_REASONS,
  OUTBOX_KINDS,
  OUTBOX_AGGREGATES,
  CONTAMINANT_CODE_STATUSES,
} as const satisfies Record<string, readonly [string, ...string[]]>
