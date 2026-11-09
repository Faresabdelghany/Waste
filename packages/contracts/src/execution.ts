// Execution's closed lists at the API boundary (Issue #104): each of
// @waste/domain/execution/vocabulary's tuples turned into the `z.enum` the
// routes validate against, so an unknown token never reaches a `CHECK` that
// would refuse it as a 500 naming nothing. Shared here because several modules
// read them — `routes.ts` the route status and its cancel's reason codes, `pickups.ts` the pickup's status,
// origin and reasons, `proofs.ts` the kinds and sources, `unloads.ts` the sources,
// `driver-commands.ts` the command kinds, the outcomes and the driver's
// reasons — and a list spelled in one place is a list that cannot drift
// between them.
//
// A photo's or a signature's Storage object lives under an agreed key,
// `<companyId>/<routeId>/<commandId>.<ext>` (#104 §3,
// @waste/domain/storage-objects): `ObjectKey` holds a key to that shape here,
// where a wrong shape is a 400 naming the field, and the applier holds it to
// the row's own ids (`objectKeyNames`), since only it knows which company,
// route and command the key must name.
import {
  COMMAND_OUTCOMES,
  DRIVER_COMMAND_KINDS,
  DRIVER_PICKUP_REASONS,
  EXECUTION_SOURCES,
  FILL_LEVELS,
  IDENTIFICATION_METHODS,
  OFFICE_CANCEL_REASON_CODES,
  OFFICE_STOP_SERVICES,
  PICKUP_ORIGINS,
  PICKUP_OUTCOMES,
  PICKUP_REASONS,
  PICKUP_SERVICES,
  PICKUP_STATUSES,
  PROOF_KINDS,
  ROUTE_CANCEL_REASON_CODES,
  ROUTE_STATUSES,
} from "@waste/domain/execution/vocabulary"
import { PROOF_KEY_PATTERN, PROOF_KEY_SHAPE } from "@waste/domain/storage-objects"
import * as z from "zod"

export const RouteStatus = z.enum(ROUTE_STATUSES)
export type RouteStatus = z.infer<typeof RouteStatus>

/** Why a route was cancelled (O5 of #290): the office's eight, and the run's `regeneration`. */
export const RouteCancelReasonCode = z.enum(ROUTE_CANCEL_REASON_CODES)
export type RouteCancelReasonCode = z.infer<typeof RouteCancelReasonCode>

/** The eight codes the office's cancel may give; `regeneration` is a run's to write. */
export const OfficeCancelReasonCode = z.enum(OFFICE_CANCEL_REASON_CODES)
export type OfficeCancelReasonCode = z.infer<typeof OfficeCancelReasonCode>

/** Where a Pickup stands; `skipped` was not attempted, `failed` was. */
export const PickupStatus = z.enum(PICKUP_STATUSES)
export type PickupStatus = z.infer<typeof PickupStatus>

/** The statuses a pickup may be moved to: every one but planned, which nothing moves a pickup back to. */
export const PickupOutcome = z.enum(PICKUP_OUTCOMES)
export type PickupOutcome = z.infer<typeof PickupOutcome>

/** Who put a stop on its route (#111): generation, or the office, whose stop a refresh never skips or moves. */
export const PickupOrigin = z.enum(PICKUP_ORIGINS)
export type PickupOrigin = z.infer<typeof PickupOrigin>

/** What a stop is for (O3 of #290): emptying its container, or one of the office's work orders. */
export const PickupService = z.enum(PICKUP_SERVICES)
export type PickupService = z.infer<typeof PickupService>

/** The services the office books on a stop it adds: every one, a delivery, a removal and a swap with their ledger bookings (O3b of #290). */
export const OfficeStopService = z.enum(OFFICE_STOP_SERVICES)
export type OfficeStopService = z.infer<typeof OfficeStopService>

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

export const DriverCommandKind = z.enum(DRIVER_COMMAND_KINDS)
export type DriverCommandKind = z.infer<typeof DriverCommandKind>

/** How a driver read the code that confirms a stop's container (O19 of #290). */
export const IdentificationMethod = z.enum(IDENTIFICATION_METHODS)
/** How full a stop's container was, the driver's estimate (M23 of #293). */
export const FillLevel = z.enum(FILL_LEVELS)
export type FillLevel = z.infer<typeof FillLevel>
export type IdentificationMethod = z.infer<typeof IdentificationMethod>

/** What the receipt stores of a command: applied or rejected. */
export const CommandOutcome = z.enum(COMMAND_OUTCOMES)
export type CommandOutcome = z.infer<typeof CommandOutcome>

/** A proof's Storage object key, held to its shape; which ids it must name is the applier's rule. */
export const ObjectKey = z.string().regex(new RegExp(PROOF_KEY_PATTERN), PROOF_KEY_SHAPE)
export type ObjectKey = z.infer<typeof ObjectKey>
