// The ledger's work orders at completion (O3b of #290): a delivery, a removal
// or a swap the driver completes moves its container through the Stock
// Movement ledger in the same transaction, dated by the completion (D3) — a
// delivery is the `issue` into a placement under the subscription it was
// booked with, from the completion's day on the project's clock; a removal is
// the `return` to the warehouse it was booked with, ending the placement in
// force on that day as 10a ends it; a swap is the return of the container
// taken and the issue of its replacement under the placement's subscription,
// with its fraction and cadence, one after the other.
//
// The movements are the ledger's own statements (`stock-ledger.ts`), recorded
// by whoever completed the stop. They run in a savepoint inside the
// completion's: a refusal — the container issued elsewhere meanwhile, a
// warehouse closed, a subscription ended — rolls back the ledger's partial
// writes alone, and the completion stands, since the stop happened (D8). The
// office is then told by an internal task carrying the ledger's own sentence
// (`ledgerNotRecorded`), to record by hand what the driver did; anything but
// the ledger's refusal, a bug, still fails the command.
//
// The office's correction of the stop's outcome follows the same rule: a
// correction to completed makes the movements as the completion would have,
// dated by the correction, and one away from completed leaves them standing —
// the ledger is appended to, never taken back — and tells the office so
// (`ledgerMovedThenCorrected`). Both reach here through `stopOutcomeChanged`
// (`stop-outcomes.ts`).
import { dayInTimezone, timeInTimezone } from "@waste/domain/clock"
import { isLedgerService, LEDGER_STEPS, ledgerMovedThenCorrected, ledgerNotRecorded, type LedgerService } from "@waste/domain/execution/work-orders"
import { pickupMissed, type PickupService, type PickupStatus } from "@waste/domain/execution/vocabulary"
import { Refused } from "@waste/domain/refusal"
import { and, desc, eq } from "drizzle-orm"

import type { Tx } from "../client"
import { newId } from "../ids"
import type { Send } from "../jobs"
import { validOn } from "../query/valid-on"
import { container, containerServicePlacement } from "../schema/containers"
import { property, sharedCollectionPoint } from "../schema/customers"
import { pickup } from "../schema/execution"
import { project } from "../schema/organisation"
import { NO_TICKET_LINKS } from "../shapes/tickets"
import { openTicket } from "./open-ticket"
import type { Actor } from "./shared"
import { issueContainer, move, type ContainerRef } from "./stock-ledger"

/** Who completed the stop: the driver on the route, or the office correcting its outcome; the ticket's source and its sentence say which. */
export type CompletedBy = "driver" | "office"
const SOURCE_OF: Readonly<Record<CompletedBy, "driver-app" | "dispatch">> = { driver: "driver-app", office: "dispatch" }

/** The stop a completion just closed, as the ledger work reads it. */
type CompletedStop = {
  id: string
  projectId: string
  routeId: string
  service: PickupService
  containerId: string | null
  subscriptionId: string | null
  warehouseId: string | null
  replacementContainerId: string | null
  wasteFractionId: string
  propertyId: string | null
  sharedCollectionPointId: string | null
}

/** A container as the ledger's commands name it: its id, its project and its label. */
async function containerRef(tx: Tx, companyId: string, id: string): Promise<ContainerRef> {
  const [row] = await tx
    .select({ id: container.id, projectId: container.projectId, label: container.label })
    .from(container)
    .where(and(eq(container.companyId, companyId), eq(container.id, id)))
    .limit(1)
  if (row === undefined) throw new Error(`container ${id} of a work order is not there`)
  return row
}

/** The movements of one work order, in the ledger's order, recorded by the actor. */
async function moveFor(tx: Tx, actor: Actor, stop: CompletedStop & { service: LedgerService }, day: string, occurredAt: string, at: Date): Promise<void> {
  const { companyId } = actor
  const taken = await containerRef(tx, companyId, stop.containerId as string)
  const says = { occurredAt, at }
  if (stop.service === "deliver") {
    await issueContainer(tx, actor, taken, { subscriptionId: stop.subscriptionId as string, wasteFractionId: stop.wasteFractionId, validFrom: day }, says)
    return
  }
  // The placement in force as the swap reads it, before the return ends it: its subscription — or a public placement's point (M12 of #293) — fraction and cadence go to the replacement.
  const [inForce] =
    stop.service === "swap"
      ? await tx
          .select({
            subscriptionId: containerServicePlacement.subscriptionId,
            sharedCollectionPointId: containerServicePlacement.sharedCollectionPointId,
            wasteFractionId: containerServicePlacement.wasteFractionId,
            serviceFrequencyId: containerServicePlacement.serviceFrequencyId,
          })
          .from(containerServicePlacement)
          .where(and(eq(containerServicePlacement.companyId, companyId), eq(containerServicePlacement.containerId, taken.id), validOn(containerServicePlacement, day)))
          .orderBy(desc(containerServicePlacement.validFrom))
          .limit(1)
      : []
  for (const step of LEDGER_STEPS[stop.service]) {
    if (step === "return") {
      await move(tx, actor, taken, { kind: "return", to: { kind: "warehouse", warehouseId: stop.warehouseId as string }, validTo: day, ...says })
      continue
    }
    if (inForce === undefined) throw Refused.conflict(`Container ${taken.label} has no placement in force on ${day} for its replacement to take over`)
    const replacement = await containerRef(tx, companyId, stop.replacementContainerId as string)
    await issueContainer(tx, actor, replacement, { subscriptionId: inForce.subscriptionId, sharedCollectionPointId: inForce.sharedCollectionPointId, wasteFractionId: inForce.wasteFractionId, serviceFrequencyId: inForce.serviceFrequencyId, validFrom: day }, says)
  }
}

/** The stop as its ledger work reads it, with its project's timezone; undefined for a stop whose service moves nothing. */
async function ledgerStop(tx: Tx, companyId: string, pickupId: string): Promise<(CompletedStop & { service: LedgerService; timezone: string }) | undefined> {
  const [stop] = await tx
    .select({
      id: pickup.id,
      projectId: pickup.projectId,
      routeId: pickup.routeId,
      service: pickup.service,
      containerId: pickup.containerId,
      subscriptionId: pickup.subscriptionId,
      warehouseId: pickup.warehouseId,
      replacementContainerId: pickup.replacementContainerId,
      wasteFractionId: pickup.wasteFractionId,
      propertyId: pickup.propertyId,
      sharedCollectionPointId: pickup.sharedCollectionPointId,
      timezone: project.timezone,
    })
    .from(pickup)
    .innerJoin(project, and(eq(project.companyId, pickup.companyId), eq(project.id, pickup.projectId)))
    .where(and(eq(pickup.companyId, companyId), eq(pickup.id, pickupId)))
    .limit(1)
  if (stop === undefined) throw new Error(`pickup ${pickupId} decided and then not there`)
  const service = stop.service
  return isLedgerService(service) ? { ...stop, service } : undefined
}

/**
 * After a completion: the stop's ledger movements, in a savepoint, or the
 * office's internal task with the ledger's sentence where it refused them.
 * Nothing for a stop whose service moves nothing. `occurredAt` is the
 * completion's; `at` the caller's clock, which the ledger holds the instant
 * to; `by` who completed it; `send` what the task's automation queues with.
 */
async function recordLedgerWork(tx: Tx, actor: Actor, send: Send, pickupId: string, occurredAt: string, at: Date, by: CompletedBy): Promise<void> {
  const work = await ledgerStop(tx, actor.companyId, pickupId)
  if (work === undefined) return
  const completed = new Date(occurredAt)
  const day = dayInTimezone(completed, work.timezone)
  try {
    await tx.transaction(async (savepoint) => {
      await moveFor(savepoint, actor, work, day, occurredAt, at)
    })
  } catch (error) {
    if (!(error instanceof Refused)) throw error
    const words = ledgerNotRecorded({ ...(await workFacts(tx, actor.companyId, work)), by, completedAt: timeInTimezone(completed, work.timezone), sentence: error.refusal.sentence })
    await openLedgerTask(tx, actor, send, work, words, SOURCE_OF[by], at)
  }
}

/**
 * A stop's outcome, for its ledger work: to completed — the driver's
 * completion, or the office's correction from a miss — the movements as a
 * completion makes them, dated by `occurredAt`; from completed to a miss, the
 * office's task saying the movements stand. Nothing for any other move, or a
 * stop whose service moves nothing.
 */
export async function ledgerHearsOfStop(tx: Tx, actor: Actor, send: Send, pickupId: string, outcome: { from: PickupStatus; to: PickupStatus; occurredAt: string; by: CompletedBy }, at: Date): Promise<void> {
  if (outcome.to === "completed" && outcome.from !== "completed") {
    await recordLedgerWork(tx, actor, send, pickupId, outcome.occurredAt, at, outcome.by)
    return
  }
  if (outcome.from !== "completed" || !pickupMissed(outcome.to)) return
  const work = await ledgerStop(tx, actor.companyId, pickupId)
  if (work === undefined) return
  const words = ledgerMovedThenCorrected({ ...(await workFacts(tx, actor.companyId, work)), outcome: outcome.to, correctedAt: timeInTimezone(at, work.timezone) })
  await openLedgerTask(tx, actor, send, work, words, "dispatch", at)
}

/** The work as a ticket names it: its containers by label and its place by address. */
async function workFacts(tx: Tx, companyId: string, stop: CompletedStop & { service: LedgerService }) {
  const containerLabel = (await containerRef(tx, companyId, stop.containerId as string)).label
  const replacementLabel = stop.replacementContainerId === null ? null : (await containerRef(tx, companyId, stop.replacementContainerId)).label
  const [place] = await tx
    .select({ propertyAddress: property.address, pointAddress: sharedCollectionPoint.address })
    .from(pickup)
    .leftJoin(property, and(eq(property.companyId, pickup.companyId), eq(property.id, pickup.propertyId)))
    .leftJoin(sharedCollectionPoint, and(eq(sharedCollectionPoint.companyId, pickup.companyId), eq(sharedCollectionPoint.id, pickup.sharedCollectionPointId)))
    .where(and(eq(pickup.companyId, companyId), eq(pickup.id, stop.id)))
    .limit(1)
  return { service: stop.service, containerLabel, replacementLabel, address: place?.propertyAddress ?? place?.pointAddress ?? null }
}

/** The office's task about a ledger work order: about the stop, its route, its container and its place. */
async function openLedgerTask(tx: Tx, actor: Actor, send: Send, stop: CompletedStop, words: { kind: "internal-task"; priority: "high"; subject: string; description: string }, source: "driver-app" | "dispatch", at: Date): Promise<void> {
  await openTicket(tx, {
    companyId: actor.companyId,
    draft: {
      projectId: stop.projectId,
      kind: words.kind,
      priority: words.priority,
      source,
      subject: words.subject,
      description: words.description,
      occurredAt: at,
      dueAt: null,
      assigneeUserAccountId: null,
      links: { ...NO_TICKET_LINKS, routeId: stop.routeId, pickupId: stop.id, containerId: stop.containerId, propertyId: stop.propertyId, sharedCollectionPointId: stop.sharedCollectionPointId },
      alertId: null,
    },
    createdBy: actor.userAccountId,
    automation: { send, by: actor.userAccountId },
    sourceEventId: null,
    newId,
    now: () => at,
  })
}
