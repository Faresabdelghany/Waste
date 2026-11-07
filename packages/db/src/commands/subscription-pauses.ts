// A Subscription's pause, written once for both doors that pause one (#291,
// slice 10; M11 of #293): the office's `POST /subscriptions/:id/pauses`
// (apps/api's routes/subscription-pauses.ts) and a granted pause
// Application applied (apps/worker's registry/apply-pause-grants.ts). Each
// door judges the period in its own way — the office's is refused outside
// the subscription's period or before today, a grant's is cut to them — and
// both write it here: under the subscription's agreement's lock and then its
// own, top down as the subscription's patch takes them, so a pause and a
// shortening of the period it sits in take turns; and one pause of a
// subscription in force at a time, the exclusion constraint's, in its
// sentence.
import type { Period } from "@waste/domain/periods"
import { and, eq } from "drizzle-orm"

import type { Tx } from "../client"
import { agreement, subscription, subscriptionPause } from "../schema/agreements"
import { lockRow, refuseOverlap } from "./shared"

/** `EXCLUDE USING gist (company_id, subscription_id, daterange)`: one pause of a subscription in force at a time. */
export const PAUSED_ALREADY = "subscription_pause_no_overlap"
export const PAUSED_ALREADY_SENTENCE = "The subscription is already paused over part of that period"

/** The sentence every write of a pause's period refuses an overlap with. */
export const PAUSE_OVERLAP: Readonly<Record<string, string>> = { [PAUSED_ALREADY]: PAUSED_ALREADY_SENTENCE }

/** The subscription a pause hangs on, as a write needs it: its period, its project and the agreement whose lock comes first. */
export type PausedSubscription = Period & { id: string; projectId: string; agreementId: string }

async function findSubscription(tx: Tx, companyId: string, id: string): Promise<PausedSubscription | undefined> {
  const [row] = await tx
    .select({ id: subscription.id, projectId: subscription.projectId, agreementId: subscription.agreementId, validFrom: subscription.validFrom, validTo: subscription.validTo })
    .from(subscription)
    .where(and(eq(subscription.companyId, companyId), eq(subscription.id, id)))
    .limit(1)
  return row
}

/** The subscription's locks, its agreement's first, top down; then the subscription read again underneath them. Undefined for none of the company's. */
export async function lockedSubscription(tx: Tx, companyId: string, id: string): Promise<PausedSubscription | undefined> {
  const found = await findSubscription(tx, companyId, id)
  if (found === undefined) return undefined
  await lockRow(tx, agreement, { companyId, id: found.agreementId })
  await lockRow(tx, subscription, { companyId, id })
  return await findSubscription(tx, companyId, id)
}

/**
 * Pauses the subscription its caller locked (`lockedSubscription`) over the
 * period, under the id the caller names, and answers the pause as written.
 * Refused, a conflict, where the subscription is already paused over part of
 * it; the insert runs in a savepoint, so a caller that counts the refusal
 * rather than fails on it goes on in its transaction.
 */
export async function pauseSubscription(tx: Tx, companyId: string, parent: { id: string; projectId: string }, pause: Period & { id: string }): Promise<typeof subscriptionPause.$inferSelect> {
  const [row] = await tx.transaction((savepoint) =>
    refuseOverlap(PAUSE_OVERLAP, () =>
      savepoint
        .insert(subscriptionPause)
        .values({ id: pause.id, companyId, projectId: parent.projectId, subscriptionId: parent.id, validFrom: pause.validFrom, validTo: pause.validTo })
        .returning(),
    ),
  )
  return row
}
