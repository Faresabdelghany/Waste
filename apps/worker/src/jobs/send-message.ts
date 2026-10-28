// A message sent (#291 C15): `messaging.send` takes one message of the
// delivery log that `queueMessage` (@waste/db/commands/messaging) wrote
// `queued` and sends it through the deployment's provider
// (../messaging/select.ts: the log-only sender until a card-free provider is
// verified, the owner's decision on #291).
//
// Consent is judged here, at the send, against the customer as they stand
// now (`needsConsent`, @waste/domain/messaging/template): a service message
// to a customer who allows none is `withheld` with the reason and never
// reaches the provider; a billing message is owed whatever they chose. Then
// an attempt is counted, in its own short transaction, and the provider is
// called outside any transaction, as every call to another service is
// (#124 §4); the answer is recorded in a second one: `sent` with the
// provider and its id, or the failure's sentence as the reason. A failure
// before the last attempt throws, and pg-boss tries again with backoff; the
// last one marks the message `failed` and completes the job. A message that
// is no longer `queued` — a redelivered job — writes nothing.
//
// The provider may be asked twice for one message where the worker dies
// between its answer and the record of it: a send is at least once, and the
// log-only sender makes that harmless today. A provider with an idempotency
// key takes the message's id as it (`OutgoingMessage.id`).
//
// Every write is `wms_api`'s under `withCompany`, fenced like a request's.
import { SEND_MESSAGE_QUEUE, type SendMessageData } from "@waste/db/commands/messaging"
import { customer } from "@waste/db/schema/customers"
import { message } from "@waste/db/schema/messaging"
import { messageWithoutStatement } from "@waste/db/sqlstate"
import { withCompany } from "@waste/db/tenant"
import { needsConsent } from "@waste/domain/messaging/template"
import type { MessageChannel, MessagePurpose } from "@waste/domain/messaging/vocabulary"
import { and, eq, sql } from "drizzle-orm"

import { LogOnlyProvider } from "../messaging/log-only"
import type { MessagingProvider } from "../messaging/provider"
import { defineJob, type JobContext } from "./definition"

/** The tries a message gets: the first and pg-boss's two retries. */
export const MAX_ATTEMPTS = 3

/** Why a service message to a customer who allows none is withheld. */
export const NO_CONSENT = "The customer allows no service messages"

/** What the provider was asked to do with one message, and how it went. */
export type SendOutcome = "sent" | "withheld" | "failed" | "retry" | "settled"

/** A failed attempt as the log's reason says it: the error's sentence, never a statement's parameters, bounded. */
export const reasonOf = (error: unknown): string => (error instanceof Error ? messageWithoutStatement(error.message) : String(error)).slice(0, 500)

/** The provider the job sends through: the context's, or the log-only sender where a test hands none. */
const providerOf = (context: JobContext): MessagingProvider => context.messaging ?? new LogOnlyProvider(context.log)

/** Sends one message, recording each step; throws to have pg-boss retry a failed attempt that was not the last. */
export async function sendMessage(data: SendMessageData, context: JobContext): Promise<SendOutcome> {
  const provider = providerOf(context)
  const fence = () => and(eq(message.companyId, data.companyId), eq(message.id, data.messageId), eq(message.status, "queued"))

  // The consent and the attempt, in one short transaction under the message's lock.
  const begun = await withCompany(context.api.db, data.companyId, async (tx) => {
    const [row] = await tx
      .select({ customerId: message.customerId, channel: message.channel, purpose: message.purpose, recipient: message.recipient, subject: message.subject, body: message.body, attempts: message.attempts })
      .from(message)
      .where(fence())
      .limit(1)
      .for("no key update")
    if (row === undefined) return { kind: "settled" as const }
    const [holder] = await tx.select({ allowed: customer.serviceMessagesAllowed }).from(customer).where(and(eq(customer.companyId, data.companyId), eq(customer.id, row.customerId))).limit(1)
    if (needsConsent(row.purpose as MessagePurpose) && holder?.allowed !== true) {
      await tx.update(message).set({ status: "withheld", reason: NO_CONSENT }).where(fence())
      return { kind: "withheld" as const }
    }
    const [counted] = await tx.update(message).set({ attempts: sql`${message.attempts} + 1` }).where(fence()).returning({ attempts: message.attempts })
    return { kind: "attempt" as const, row, attempts: counted.attempts }
  })
  if (begun.kind !== "attempt") return begun.kind

  const { row, attempts } = begun
  try {
    const receipt = await provider.send({ id: data.messageId, channel: row.channel as MessageChannel, to: row.recipient, subject: row.subject, body: row.body })
    await withCompany(context.api.db, data.companyId, (tx) =>
      tx.update(message).set({ status: "sent", provider: provider.name, providerMessageId: receipt.providerMessageId, sentAt: context.now(), reason: null }).where(fence()),
    )
    return "sent"
  } catch (error) {
    const reason = reasonOf(error)
    const last = attempts >= MAX_ATTEMPTS
    await withCompany(context.api.db, data.companyId, (tx) => tx.update(message).set(last ? { status: "failed", reason } : { reason }).where(fence()))
    context.log(`messaging: ${data.messageId} attempt ${attempts} of ${MAX_ATTEMPTS} failed${last ? ", giving up" : ""}: ${reason}`)
    if (last) return "failed"
    throw error
  }
}

export const sendMessageJob = defineJob<SendMessageData>({
  queue: SEND_MESSAGE_QUEUE,
  description: "Sends one queued message of the delivery log through the messaging provider, honouring the customer's consent (#291 C15).",
  queueOptions: { retryLimit: MAX_ATTEMPTS - 1, retryDelay: 30, retryBackoff: true },
  handler: async (jobs, context) => {
    const outcomes: SendOutcome[] = []
    for (const job of jobs) outcomes.push(await sendMessage(job.data, context))
    return outcomes
  },
})
