// The ledger's work orders at completion (O3b of #290): a delivery, a removal
// or a swap the driver completes moves its container through the Stock
// Movement ledger in the same request, dated by the completion (D3) — a
// delivery is the `issue` into a placement under the subscription it was
// booked with, from the completion's day on the project's clock; a removal is
// the `return` to the warehouse it was booked with, ending the placement in
// force on that day as 10a ends it; a swap is the return of the container
// taken and the issue of its replacement under the placement's subscription,
// with its fraction and cadence, one after the other.
//
// The movements are the ledger's own statements (lifecycle.ts's `move`,
// containers.ts's `issueContainer`), run as the driver: their rows record the
// driver's account, fenced to the route's project, which a driver's principal
// otherwise reaches by assignment and not by Project Access. They run in a
// savepoint inside the completion's: a refusal — the container issued
// elsewhere meanwhile, a warehouse closed, a subscription ended — rolls back
// the ledger's partial writes alone, and the driver's completion stands,
// since the stop happened (D8). The office is then told by an internal task
// carrying the ledger's own sentence (`ledgerNotRecorded`), to record by hand
// what the driver did; a bug, anything but the ledger's refusal, still fails
// the command.
//
// The office's correction of the stop's outcome follows the same rule
// (`correctLedgerWork`): a correction to completed makes the movements as
// the completion would have, dated by the correction, and one away from
// completed leaves them standing — the ledger is appended to, never taken
// back — and tells the office so (`ledgerMovedThenCorrected`).
import type { Tx } from "@waste/db/client"
import { containerServicePlacement } from "@waste/db/schema/containers"
import { container } from "@waste/db/schema/containers"
import { pickup } from "@waste/db/schema/execution"
import { project } from "@waste/db/schema/organisation"
import { property, sharedCollectionPoint } from "@waste/db/schema/customers"
import { validOn } from "@waste/db/query/valid-on"
import { Refused } from "@waste/db/commands/shared"
import { isLedgerService, LEDGER_STEPS, ledgerMovedThenCorrected, ledgerNotRecorded, type LedgerService } from "@waste/domain/execution/work-orders"
import type { PickupService, PickupStatus } from "@waste/domain/execution/vocabulary"
import { and, desc, eq } from "drizzle-orm"

import type { Principal } from "../auth/principal"
import { newId } from "../ids"
import { ProblemError } from "../problem"
import { issueContainer } from "./containers"
import { dayInTimezone } from "./days"
import { move, type ContainerRef } from "./lifecycle"
import { openTicket } from "./ticket-writes"

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

/** What a movement the ledger refused is told in, in a person's words: a field's own sentence before a 400's general one. */
function sentenceOf(error: unknown): string | undefined {
  if (error instanceof ProblemError) return error.body.errors?.[0]?.message ?? error.body.detail ?? error.body.title
  if (error instanceof Refused) return error.message
  return undefined
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

/** The movements of one work order, in the ledger's order, the driver's account recording them. */
async function moveFor(tx: Tx, driver: Principal, stop: CompletedStop & { service: LedgerService }, day: string, occurredAt: string, at: Date): Promise<void> {
  const { companyId } = driver
  const taken = await containerRef(tx, companyId, stop.containerId as string)
  const says = { occurredAt, at }
  if (stop.service === "deliver") {
    await issueContainer(tx, driver, taken, { subscriptionId: stop.subscriptionId as string, wasteFractionId: stop.wasteFractionId, validFrom: day }, says)
    return
  }
  // The placement in force as the swap reads it, before the return ends it: its subscription, fraction and cadence go to the replacement.
  const [inForce] =
    stop.service === "swap"
      ? await tx
          .select({ subscriptionId: containerServicePlacement.subscriptionId, wasteFractionId: containerServicePlacement.wasteFractionId, serviceFrequencyId: containerServicePlacement.serviceFrequencyId })
          .from(containerServicePlacement)
          .where(and(eq(containerServicePlacement.companyId, companyId), eq(containerServicePlacement.containerId, taken.id), validOn(containerServicePlacement, day)))
          .orderBy(desc(containerServicePlacement.validFrom))
          .limit(1)
      : []
  for (const step of LEDGER_STEPS[stop.service]) {
    if (step === "return") {
      await move(tx, driver, taken, { kind: "return", to: { kind: "warehouse", warehouseId: stop.warehouseId as string }, validTo: day, ...says })
      continue
    }
    if (inForce === undefined) throw new ProblemError(409, { detail: `Container ${taken.label} has no placement in force on ${day} for its replacement to take over` })
    const replacement = await containerRef(tx, companyId, stop.replacementContainerId as string)
    await issueContainer(tx, driver, replacement, { subscriptionId: inForce.subscriptionId, wasteFractionId: inForce.wasteFractionId, serviceFrequencyId: inForce.serviceFrequencyId, validFrom: day }, says)
  }
}

/** The completion's time on the project's clock, as a ticket says it: "10:12". */
const timeIn = (instant: Date, timeZone: string): string => new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(instant)

/** Who completed the stop: the driver on the route, or the office correcting its outcome; the ticket's source and its sentence say which. */
type CompletedBy = "driver" | "office"
const SOURCE_OF: Readonly<Record<CompletedBy, "driver-app" | "dispatch">> = { driver: "driver-app", office: "dispatch" }

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
  const service = stop.service as PickupService
  return isLedgerService(service) ? { ...stop, service } : undefined
}

/**
 * After a completion: the stop's ledger movements, in a savepoint, or the
 * office's internal task with the ledger's sentence where it refused them.
 * Nothing for a stop whose service moves nothing. `occurredAt` is the
 * completion's; `at` the request's clock, which the ledger holds the instant
 * to; `by` who completed it.
 */
export async function recordLedgerWork(tx: Tx, actor: Principal, pickupId: string, occurredAt: string, at: Date, by: CompletedBy): Promise<void> {
  const work = await ledgerStop(tx, actor.companyId, pickupId)
  if (work === undefined) return
  // The driver acts on the route's project: the ledger's fences read the principal's projects.
  const onTheRoute: Principal = { ...actor, projects: [{ id: work.projectId, name: "" }] }
  const completed = new Date(occurredAt)
  const day = dayInTimezone(completed, work.timezone)
  try {
    await tx.transaction(async (savepoint) => {
      await moveFor(savepoint as unknown as Tx, onTheRoute, work, day, occurredAt, at)
    })
  } catch (error) {
    const sentence = sentenceOf(error)
    if (sentence === undefined) throw error
    const words = ledgerNotRecorded({ ...(await workFacts(tx, actor.companyId, work)), by, completedAt: timeIn(completed, work.timezone), sentence })
    await openLedgerTask(tx, actor, work, words, SOURCE_OF[by], at)
  }
}

/**
 * The office's correction of a stop's outcome, for its ledger work: to
 * completed from a miss, the movements as a completion makes them, dated by
 * the correction; from completed to a miss, the office's task saying the
 * movements stand. Nothing for a stop whose service moves nothing.
 */
export async function correctLedgerWork(tx: Tx, office: Principal, pickupId: string, outcome: { from: PickupStatus; to: PickupStatus }, at: Date): Promise<void> {
  if (outcome.to === "completed" && outcome.from !== "completed") {
    await recordLedgerWork(tx, office, pickupId, at.toISOString(), at, "office")
    return
  }
  if (outcome.from !== "completed" || (outcome.to !== "skipped" && outcome.to !== "failed")) return
  const work = await ledgerStop(tx, office.companyId, pickupId)
  if (work === undefined) return
  const words = ledgerMovedThenCorrected({ ...(await workFacts(tx, office.companyId, work)), outcome: outcome.to, correctedAt: timeIn(at, work.timezone) })
  await openLedgerTask(tx, office, work, words, "dispatch", at)
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
async function openLedgerTask(tx: Tx, actor: Principal, stop: CompletedStop, words: { kind: "internal-task"; priority: "high"; subject: string; description: string }, source: "driver-app" | "dispatch", at: Date): Promise<void> {
  const { companyId } = actor
  await openTicket(tx, {
    companyId,
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
      links: {
        routeId: stop.routeId,
        pickupId: stop.id,
        containerId: stop.containerId,
        propertyId: stop.propertyId,
        sharedCollectionPointId: stop.sharedCollectionPointId,
        customerId: null,
        agreementId: null,
        driverId: null,
        parentTicketId: null,
      },
      alertId: null,
    },
    createdBy: actor.user.id,
    sourceEventId: null,
    newId,
    now: () => at,
  })
}
