// A granted pause, applied (M11 of #293): the consumer of `application-decided`
// that puts M7's decision into force where its kind's effect is a pause. A
// grant, whole or in part, of a `pause` Application naming a subscription
// pauses that subscription over the granted period, cut to today on and to
// the subscription's own period (`pauseOfGrant`, @waste/domain/registry/
// applications) — the rule the office's own pause holds (`POST
// /subscriptions/:id/pauses`), so generation passes its containers over on
// those days exactly as it does an office pause. Every pause, not a tank's
// alone: a holiday home's tank and a household's bin are paused alike.
//
// It never reaches back. The consumer starts fresh (`startsFresh`): it hears
// the decisions relayed once it runs, never those that waited on the kind's
// own queue before it existed, which would pause a subscription — and change
// what it is charged — on a decision made months ago that the office has
// long since acted on by hand.
//
// The pause is written once: its id is the Decision's, so a redelivery meets
// the primary key and writes nothing. A grant over days the subscription is
// already paused on — the office paused it by hand — is left to that pause,
// and logged. Under the subscription's agreement's lock and then its own, as
// the office's pause takes them, and as the deciding account with the
// Application's number as the reason, so the audit trail says whose decision
// paused it. The planned stops in the pause drop at the scheme's next run —
// the nightly plan-ahead's or the next Generate — as for an office pause no
// run was asked for.
import { Application } from "@waste/contracts/applications"
import type { Tx } from "@waste/db/client"
import { projectToday } from "@waste/db/commands/project-clock"
import { lockRow } from "@waste/db/commands/shared"
import { agreement, subscription, subscriptionPause } from "@waste/db/schema/agreements"
import { exclusionConstraintOf } from "@waste/db/sqlstate"
import { actAs, withCompany } from "@waste/db/tenant"
import { pauseOfGrant } from "@waste/domain/registry/applications"
import { and, eq } from "drizzle-orm"

import { defineOutboxConsumer, type RelayedEvent } from "../outbox/subscribe"
import type { JobContext } from "./definition"

/** `EXCLUDE USING gist (company_id, subscription_id, daterange)`: one pause of a subscription in force at a time. */
const PAUSED_ALREADY = "subscription_pause_no_overlap"

/** What one decision came to. */
export type PauseApplied = { event: string; did: "paused" | "nothing" | "already-paused" | "replayed"; pauseId: string | null }

/** The reason the audit trail carries: the Application by the number a decision letter quotes. */
export const grantReason = (number: number) => `Application ${number} granted`

async function lockedSubscription(tx: Tx, companyId: string, id: string) {
  const [found] = await tx.select({ agreementId: subscription.agreementId }).from(subscription).where(and(eq(subscription.companyId, companyId), eq(subscription.id, id))).limit(1)
  if (found === undefined) return undefined
  await lockRow(tx, agreement, { companyId, id: found.agreementId })
  await lockRow(tx, subscription, { companyId, id })
  const [row] = await tx
    .select({ id: subscription.id, projectId: subscription.projectId, validFrom: subscription.validFrom, validTo: subscription.validTo })
    .from(subscription)
    .where(and(eq(subscription.companyId, companyId), eq(subscription.id, id)))
    .limit(1)
  return row
}

/** One decision to what was done with it, in one fenced transaction as the tenant. */
export async function applyPauseGrant(event: RelayedEvent, { api, log, now }: Pick<JobContext, "api" | "log" | "now">): Promise<PauseApplied> {
  const application = Application.parse(event.payload)
  const { decision } = application
  const nothing: PauseApplied = { event: event.id, did: "nothing", pauseId: null }
  const outcome =
    application.kind !== "pause" || application.subscriptionId === null || decision === null
      ? nothing
      : await withCompany(api.db, event.companyId, async (tx): Promise<PauseApplied> => {
          const [written] = await tx.select({ id: subscriptionPause.id }).from(subscriptionPause).where(and(eq(subscriptionPause.companyId, event.companyId), eq(subscriptionPause.id, decision.id))).limit(1)
          if (written !== undefined) return { event: event.id, did: "replayed", pauseId: written.id }
          const parent = await lockedSubscription(tx, event.companyId, application.subscriptionId as string)
          if (parent === undefined) throw new Error(`application-decided ${event.id} names subscription ${application.subscriptionId}, which is not in company ${event.companyId}`)
          const today = await projectToday(tx, { companyId: event.companyId, projectId: parent.projectId }, now)()
          const pause = pauseOfGrant({ kind: application.kind, subscriptionId: parent.id, decision }, parent, today)
          if (pause === null) return nothing
          await actAs(tx, { userAccountId: decision.decidedBy, reason: grantReason(application.number) })
          try {
            await tx.transaction((savepoint) => savepoint.insert(subscriptionPause).values({ id: decision.id, companyId: event.companyId, projectId: parent.projectId, ...pause }))
          } catch (error) {
            if (exclusionConstraintOf(error) !== PAUSED_ALREADY) throw error
            return { event: event.id, did: "already-paused", pauseId: null }
          }
          return { event: event.id, did: "paused", pauseId: decision.id }
        })
  log(`registry.apply-pause-grants: application-decided ${outcome.event} → ${outcome.did}${outcome.pauseId === null ? "" : ` (subscription pause ${outcome.pauseId})`}`)
  return outcome
}

/** The registry entry on `outbox.application-decided`; spread into `OUTBOX_CONSUMERS`. Starts fresh: the decisions before it are never applied. */
export const applyPauseGrants = defineOutboxConsumer({
  name: "registry",
  kinds: ["application-decided"],
  description: "Pauses the subscription a granted pause Application names over its granted period, cut to today on; once per decision, and never for a decision relayed before the consumer ran.",
  startsFresh: true,
  handler: (event, context) => applyPauseGrant(event, context),
})
