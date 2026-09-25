// Proof of Service on the wire (Issue #104): evidence that work occurred, one
// ledger row per event or piece of evidence, appended and never rewritten —
// it spreads `recorded`, like a Stock Movement. Every row names its Route
// and, where the kind is a stop's, its Pickup; a driver-recorded row names
// the Session it was recorded in and an office row none.
//
// The kinds have shapes (#104 §7.13): what each names, carries, forbids and
// comes from is the domain's `PROOF_SHAPES`
// (@waste/domain/execution/proof-shapes), which the database spells as one
// CASE and this schema runs as a refine — `proofShape(kind, row)` — so a
// resource that disagrees with its kind does not parse on the client either,
// and the sentence is `proofShapeIssue`'s, naming the column. There is no
// write body: the driver's commands append proofs, and the dispatcher's
// correction (`PickupCorrection` in pickups.ts) appends one of its own.
import { proofShapeIssue } from "@waste/domain/execution/proof-shapes"
import * as z from "zod"

import { IsoDateTime } from "./dates"
import { ExecutionSource, ObjectKey, PickupOutcome, PickupReason, ProofKind } from "./execution"
import { FlatPoint } from "./geojson"
import { Id } from "./ids"
import { PositiveInt, recorded } from "./resource"
import { Label, Paragraph } from "./text"

export const ProofOfService = z
  .object({
    ...recorded,
    projectId: Id,
    routeId: Id,
    /** The stop, for a stop's kind; null for a problem, a photo or a note on the route alone. */
    pickupId: Id.nullable(),
    /** The session, on every driver-recorded row and on no office row. */
    sessionId: Id.nullable(),
    kind: ProofKind,
    source: ExecutionSource,
    /** The device's clock, or the office's word. */
    occurredAt: IsoDateTime,
    /** The driver's login or the dispatcher's. */
    recordedBy: Id,
    deviceId: Label.nullable(),
    /** Where the device stood. */
    location: FlatPoint.nullable(),
    locationAccuracyM: PositiveInt.nullable(),
    reason: PickupReason.nullable(),
    note: Paragraph.nullable(),
    /** A lifter's or a hand scale's reading, whole kilograms. */
    weightKg: PositiveInt.nullable(),
    /** The Storage object of a photo or a signature. */
    objectKey: ObjectKey.nullable(),
    /** On a correction: the outcome the pickup was moved to. */
    outcome: PickupOutcome.nullable(),
  })
  .superRefine((row, context) => {
    const issue = proofShapeIssue(row.kind, row)
    if (issue !== undefined) context.addIssue({ code: "custom", message: issue, path: ["kind"] })
  })
export type ProofOfService = z.infer<typeof ProofOfService>
