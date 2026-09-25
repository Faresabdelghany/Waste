// Execution's closed lists at the API boundary (Issue #104): each of
// @waste/domain/execution/vocabulary's tuples turned into the `z.enum` the
// routes validate against, so an unknown token never reaches a `CHECK` that
// would refuse it as a 500 naming nothing. Shared here because seven modules
// read them — `routes.ts` the route status, `pickups.ts` the pickup's status
// and reasons, `proofs.ts` the kinds and sources, `unloads.ts` the sources,
// `driver-commands.ts` the command kinds, the outcomes and the driver's
// reasons, `outbox.ts` the event kinds and aggregates — and a list spelled in
// one place is a list that cannot drift between them.
//
// Two things beside the enums are the context's presentation on the wire.
// The route's display number is `RC-1042`: the database stores `number:
// 1042` from the company's counter, the prefix is presentation and spelled
// once here as `ROUTE_NUMBER_PREFIX`, and `routeLabel` is the one way a
// number becomes the label a `Route` carries and every sentence names. And a
// photo's or a signature's Storage object lives under an agreed key,
// `<companyId>/<routeId>/<commandId>.<ext>` (#104 §3): `ObjectKey` holds a
// key to that shape here, where a wrong shape is a 400 naming the field,
// and the applier holds it to the row's own ids
// (@waste/domain/execution/commands, `objectKeyNames`), since only it knows
// which company, route and command the key must name.
import {
  COMMAND_OUTCOMES,
  DRIVER_COMMAND_KINDS,
  DRIVER_PICKUP_REASONS,
  EXECUTION_SOURCES,
  OUTBOX_AGGREGATES,
  OUTBOX_KINDS,
  PICKUP_OUTCOMES,
  PICKUP_REASONS,
  PICKUP_STATUSES,
  PROOF_KINDS,
  ROUTE_STATUSES,
} from "@waste/domain/execution/vocabulary"
import * as z from "zod"

/** Where a dated Route stands. */
export const RouteStatus = z.enum(ROUTE_STATUSES)
export type RouteStatus = z.infer<typeof RouteStatus>

/** Where a Pickup stands; `skipped` was not attempted, `failed` was. */
export const PickupStatus = z.enum(PICKUP_STATUSES)
export type PickupStatus = z.infer<typeof PickupStatus>

/** The statuses a pickup may be moved to: every one but planned, which nothing moves a pickup back to. */
export const PickupOutcome = z.enum(PICKUP_OUTCOMES)
export type PickupOutcome = z.infer<typeof PickupOutcome>

/** Why a stop was skipped or failed: the driver's six and the system's four. */
export const PickupReason = z.enum(PICKUP_REASONS)
export type PickupReason = z.infer<typeof PickupReason>

/** The six reasons a device may give; the system's four are the server's to write. */
export const DriverPickupReason = z.enum(DRIVER_PICKUP_REASONS)
export type DriverPickupReason = z.infer<typeof DriverPickupReason>

/** What a Proof of Service is: a driver event, a kind of evidence, or the dispatcher's correction. */
export const ProofKind = z.enum(PROOF_KINDS)
export type ProofKind = z.infer<typeof ProofKind>

/** Who recorded a proof or an unload. */
export const ExecutionSource = z.enum(EXECUTION_SOURCES)
export type ExecutionSource = z.infer<typeof ExecutionSource>

/** What a driver's device may say. */
export const DriverCommandKind = z.enum(DRIVER_COMMAND_KINDS)
export type DriverCommandKind = z.infer<typeof DriverCommandKind>

/** What the receipt stores of a command: applied or rejected. */
export const CommandOutcome = z.enum(COMMAND_OUTCOMES)
export type CommandOutcome = z.infer<typeof CommandOutcome>

/** What the outbox tells the other contexts. */
export const OutboxKind = z.enum(OUTBOX_KINDS)
export type OutboxKind = z.infer<typeof OutboxKind>

/** What an outbox event is about. */
export const OutboxAggregate = z.enum(OUTBOX_AGGREGATES)
export type OutboxAggregate = z.infer<typeof OutboxAggregate>

/** The prefix a route's number is shown with: `RC-1042`. Presentation, spelled once. */
export const ROUTE_NUMBER_PREFIX = "RC-"

/** The label a route is named by, from the number the database stores. */
export const routeLabel = (number: number): string => `${ROUTE_NUMBER_PREFIX}${number}`

/** The image formats a proof's object may be, as the key's extension. */
export const OBJECT_EXTENSIONS = ["jpg", "jpeg", "png", "webp"] as const

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

/** The shape of a Storage object's key: `<companyId>/<routeId>/<commandId>.<ext>`, three lowercase UUIDs and one of the four formats. */
export const OBJECT_KEY = new RegExp(`^${UUID}/${UUID}/${UUID}\\.(${OBJECT_EXTENSIONS.join("|")})$`)

/** What a key of another shape is told. */
export const OBJECT_KEY_SHAPE = "An object key is <companyId>/<routeId>/<commandId>.<jpg|jpeg|png|webp>"

/** A Storage object's key, held to its shape; which ids it must name is the applier's rule. */
export const ObjectKey = z.string().regex(OBJECT_KEY, OBJECT_KEY_SHAPE)
export type ObjectKey = z.infer<typeof ObjectKey>
