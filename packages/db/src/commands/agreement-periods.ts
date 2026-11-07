// What an Agreement and a Subscription hold over time, declared once
// (commands/periods.ts): an agreement holds its subscriptions and the
// business Access Credentials its visits are charged to (#393, M4 of #293);
// a subscription holds the Container Service Placements serving it and its
// pauses. Shortening either is refused while a child would fall outside, and
// ending either on a day — a termination, a change of service, a move
// (apps/api's routes/agreements.ts and routes/moves.ts) — ends what it holds
// there, so no credential outlives the agreement its visits are charged to
// and no placement the subscription it serves.
//
// A change of service and a move carry the containers on: each one serving
// an ended subscription on the day serves the one replacing it from then,
// with the same fraction and frequency override, so it never leaves service
// and no stock movement is written (`servingOn`, then `carryPlacements`).
import { count } from "@waste/domain/text"
import { and, asc, eq, gt, inArray, isNull, lt, or } from "drizzle-orm"

import type { Tx } from "../client"
import { newId } from "../ids"
import { subscription, subscriptionPause } from "../schema/agreements"
import { containerServicePlacement } from "../schema/containers"
import { accessCredential } from "../schema/site-visits"
import { endChildrenOn, endOn, type DatedChild } from "./periods"

/** "it" or "them": the sentence has just counted the rows, so the pronoun follows the count. */
const them = (rows: number) => (rows === 1 ? "it" : "them")
const begin = (rows: number) => (rows === 1 ? "begins" : "begin")

export const strandedSubscriptions = (rows: number) => `${count(rows, "subscription")} would fall outside the agreement's period; end ${them(rows)} first`
export const subscriptionsBeginLater = (rows: number) => `${count(rows, "subscription")} ${begin(rows)} on or after that day; end ${them(rows)} first`
/** A placement is ended through the ledger's commands, since a form does not end one (Issue #101). */
export const strandedPlacements = (rows: number) => `${count(rows, "placement")} would fall outside the subscription's period; end ${them(rows)} first through the container's return or decommission`
export const placementsBeginLater = (rows: number) => `${count(rows, "placement")} ${begin(rows)} on or after that day; end ${them(rows)} first`
export const strandedPauses = (rows: number) => `${count(rows, "pause")} would fall outside the subscription's period; end or cancel ${them(rows)} first`
/** A pause that has not begun is cancelled, not ended (#291). */
export const pausesBeginLater = (rows: number) => `${count(rows, "pause")} ${begin(rows)} on or after that day; cancel ${them(rows)} first`
export const strandedCredentials = (rows: number) => `${count(rows, "access credential")} would fall outside the agreement's period; end ${them(rows)} first`
export const credentialsBeginLater = (rows: number) => `${count(rows, "access credential")} ${begin(rows)} on or after that day; end ${them(rows)} first`

const PLACEMENTS: DatedChild = { table: containerServicePlacement, parent: containerServicePlacement.subscriptionId, stranded: strandedPlacements, beginsLater: placementsBeginLater, children: [] }
const PAUSES: DatedChild = { table: subscriptionPause, parent: subscriptionPause.subscriptionId, stranded: strandedPauses, beginsLater: pausesBeginLater, children: [] }

/** What a subscription holds: the placements serving it and its pauses. */
export const SUBSCRIPTION_CHILDREN: readonly DatedChild[] = [PLACEMENTS, PAUSES]

const SUBSCRIPTIONS: DatedChild = { table: subscription, parent: subscription.agreementId, stranded: strandedSubscriptions, beginsLater: subscriptionsBeginLater, children: SUBSCRIPTION_CHILDREN }
/** A business's credential names the agreement its visits are charged to; a household's names none and hangs on no agreement. */
const CREDENTIALS: DatedChild = { table: accessCredential, parent: accessCredential.agreementId, stranded: strandedCredentials, beginsLater: credentialsBeginLater, children: [] }

/** What an agreement holds: its subscriptions, and the credentials charged to it. */
export const AGREEMENT_CHILDREN: readonly DatedChild[] = [SUBSCRIPTIONS, CREDENTIALS]

/**
 * Ends the subscriptions on `on`, under their agreement's lock: refused where
 * a placement or a pause of them begins on or after the day, then the
 * placements and the pauses in force past it end there and the subscriptions
 * after them. Each subscription runs past `on`; the caller judged that.
 */
export async function endSubscriptionsOn(tx: Tx, companyId: string, subscriptionIds: readonly string[], on: string): Promise<void> {
  await endOn(tx, SUBSCRIPTIONS, companyId, subscriptionIds, on)
}

/**
 * Ends everything the agreement holds on `on`, under its lock — its
 * subscriptions with their placements and pauses, and its credentials —
 * refused first where any of them begins on or after the day; the agreement's
 * own end is its caller's patch, which then strands nothing.
 */
export async function endAgreementHoldingsOn(tx: Tx, companyId: string, agreementId: string, on: string): Promise<void> {
  await endChildrenOn(tx, AGREEMENT_CHILDREN, companyId, [agreementId], on)
}

/** The subscriptions of an agreement in force past `on`: what its end on that day ends. */
export async function subscriptionsPast(tx: Tx, companyId: string, agreementId: string, on: string): Promise<string[]> {
  const rows = await tx
    .select({ id: subscription.id })
    .from(subscription)
    .where(and(eq(subscription.companyId, companyId), eq(subscription.agreementId, agreementId), or(isNull(subscription.validTo), gt(subscription.validTo, on))))
    .orderBy(asc(subscription.id))
  return rows.map((row) => row.id)
}

/** A placement serving a subscription on the day, as a replacement carries it on. */
export type ServingPlacement = { id: string; subscriptionId: string; containerId: string; wasteFractionId: string; serviceFrequencyId: string | null; validTo: string | null }

/** The placements serving the subscriptions past `on` — begun before it, ending after it or open — read before they end, since each replacement keeps its end. */
export async function servingOn(tx: Tx, companyId: string, subscriptionIds: readonly string[], on: string): Promise<ServingPlacement[]> {
  if (subscriptionIds.length === 0) return []
  const rows = await tx
    .select({
      id: containerServicePlacement.id,
      subscriptionId: containerServicePlacement.subscriptionId,
      containerId: containerServicePlacement.containerId,
      wasteFractionId: containerServicePlacement.wasteFractionId,
      serviceFrequencyId: containerServicePlacement.serviceFrequencyId,
      validTo: containerServicePlacement.validTo,
    })
    .from(containerServicePlacement)
    .where(
      and(
        eq(containerServicePlacement.companyId, companyId),
        inArray(containerServicePlacement.subscriptionId, [...subscriptionIds]),
        lt(containerServicePlacement.validFrom, on),
        or(isNull(containerServicePlacement.validTo), gt(containerServicePlacement.validTo, on)),
      ),
    )
    .orderBy(asc(containerServicePlacement.id))
  return rows.map((row) => ({ ...row, subscriptionId: row.subscriptionId as string }))
}

/** Places each container on the subscription replacing the one it served, from `on` until the end it had, with its fraction and frequency override. */
export async function carryPlacements(tx: Tx, scope: { companyId: string; projectId: string }, placements: readonly ServingPlacement[], replacementId: string, on: string): Promise<void> {
  if (placements.length === 0) return
  await tx.insert(containerServicePlacement).values(
    placements.map((placement) => ({
      id: newId(),
      companyId: scope.companyId,
      projectId: scope.projectId,
      containerId: placement.containerId,
      subscriptionId: replacementId,
      wasteFractionId: placement.wasteFractionId,
      serviceFrequencyId: placement.serviceFrequencyId,
      validFrom: on,
      validTo: placement.validTo,
    })),
  )
}
