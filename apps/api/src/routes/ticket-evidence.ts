// A ticket answered with evidence (Issue #293, M6): what the stop a ticket
// is about recorded, read for the office's ticket and quoted in the reply its
// customer is sent, through the domain's one rule
// (`@waste/domain/resolution/evidence`). The stop is the ticket's
// `links.pickupId`, held to the ticket's project when it was linked. Its
// proofs are read here under the ticket's grant and told narrowed to what the
// reply quotes (`EvidenceProof`: no device, account, session, driver's note
// or weight, which the stop's own read keeps under the stops' grant); a
// photo's or a signature's bytes are signed for through `GET
// /pickups/{id}/proof-objects` alone, never a second door to Storage.
//
// `recordCustomerReply` is the one way a reply reaches the customer's thread:
// a `comment` the customer may read, which the portal reads. It sends
// nothing. The communications slice (65's) adds the outbox kind and its
// `emit` here, in the same transaction, so every reply is sent from one
// place; a reply recorded before that slice is never sent after it.
import type { StopEvidence } from "@waste/contracts/tickets"
import type { Tx } from "@waste/db/client"
import { pickup } from "@waste/db/schema/execution"
import { project } from "@waste/db/schema/organisation"
import type { PickupReason, PickupService, PickupStatus, ProofKind } from "@waste/domain/execution/vocabulary"
import { replyFromRecord, stopEvidenceOf, answeredByRecord, type Coordinates } from "@waste/domain/resolution/evidence"
import type { TicketKind, TicketStatus } from "@waste/domain/resolution/vocabulary"
import { and, eq } from "drizzle-orm"

import { pickupColumns, proofOf, proofsOfPickup } from "./execution-shapes"
import type { TicketRow } from "./resolution-shapes"
import { appendTicketEvent, type TicketRef } from "./ticket-writes"

/** An instant as the reply quotes it, on the project's clock: `07:42 on Saturday 24 October`. */
export function whenOn(instant: string, timezone: string): string {
  const at = new Date(instant)
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at)
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "long", day: "numeric", month: "long" }).format(at)
  return `${time} on ${day}`
}

/** The stop a ticket is about, with what it recorded and the reply that quotes it; null for a ticket about no stop. */
export async function stopEvidenceFor(tx: Tx, companyId: string, row: TicketRow): Promise<StopEvidence | null> {
  if (row.pickupId === null) return null
  const [stop] = await tx
    .select(pickupColumns)
    .from(pickup)
    .where(and(eq(pickup.companyId, companyId), eq(pickup.projectId, row.projectId), eq(pickup.id, row.pickupId)))
    .limit(1)
  if (stop === undefined) return null
  const [clock] = await tx
    .select({ timezone: project.timezone })
    .from(project)
    .where(and(eq(project.companyId, companyId), eq(project.id, row.projectId)))
    .limit(1)
  const proofs = (await proofsOfPickup(tx, companyId, stop.id)).map(proofOf)
  const evidence = stopEvidenceOf(
    { status: stop.status as PickupStatus, reason: stop.reason as PickupReason | null, service: stop.service as PickupService, arrivedAt: stop.arrivedAt?.toISOString() ?? null, outcomeAt: stop.outcomeAt?.toISOString() ?? null },
    proofs.map((proof) => ({ id: proof.id, kind: proof.kind as ProofKind, occurredAt: proof.occurredAt, location: (proof.location?.coordinates as Coordinates | undefined) ?? null, objectKey: proof.objectKey })),
  )
  return {
    pickupId: stop.id,
    routeId: stop.routeId,
    outcome: evidence.outcome,
    reason: evidence.reason,
    service: evidence.service,
    corrected: evidence.corrected,
    at: evidence.at,
    location: evidence.location === null ? null : { type: "Point", coordinates: [evidence.location[0], evidence.location[1]] },
    proofs: proofs.map(({ id, kind, source, occurredAt, reason, outcome, objectKey }) => ({ id, kind, source, occurredAt, reason, outcome, objectKey })),
    reply: replyFromRecord(evidence, evidence.at === null ? null : whenOn(evidence.at, clock?.timezone ?? "UTC")),
    answeredByRecord: answeredByRecord(row.kind as TicketKind, evidence),
  }
}

/** The reply's words: the record's sentence, then the office's note where it gave one. */
export const replyBody = (evidence: StopEvidence, note: string | undefined): string => (note === undefined ? evidence.reply : `${evidence.reply}\n\n${note}`)

/** Records a reply on the customer's thread: the one way a reply is written, and where its sending will be. */
export async function recordCustomerReply(
  tx: Tx,
  ref: TicketRef,
  snapshot: { status: TicketStatus; assigneeUserAccountId: string | null },
  body: string,
  recordedBy: string,
  objectKey: string | null = null,
) {
  return await appendTicketEvent(tx, ref, {
    kind: "comment",
    status: snapshot.status,
    assigneeUserAccountId: snapshot.assigneeUserAccountId,
    resolution: null,
    body,
    visibility: "customer",
    objectKey,
    recordedBy,
    sourceEventId: null,
  })
}
