// The messaging provider door (#291 C15), the routing precedent
// (@waste/routing/provider): every message the worker sends goes through
// this shape, so a real e-mail or SMS provider is a constructor and a name
// in select.ts and nothing else. The owner's decision on #291: until a
// provider is verified card-free at sign-up and at first send, the one door
// is the log-only sender (log-only.ts), which sends nothing.
//
// A send is one call for one message, never made inside a database
// transaction (send-message.ts holds that rule). It answers the provider's
// id for the message; what it throws is a failed attempt, which the job
// counts against the message's attempts.
import type { MessageChannel } from "@waste/domain/messaging/vocabulary"

/** One message as the provider is handed it: rendered, addressed, on its channel. */
export type OutgoingMessage = {
  /** The delivery log's id, which a provider may carry as its own reference. */
  id: string
  channel: MessageChannel
  /** An e-mail address or a phone number, as the log copied it. */
  to: string
  /** An e-mail's subject; null for a text message. */
  subject: string | null
  body: string
}

/** What a provider answers for a message it took. */
export type SendReceipt = { providerMessageId: string }

export type MessagingProvider = {
  /** Its name on the log's `provider` column: `log` for the log-only sender. */
  readonly name: string
  send(message: OutgoingMessage): Promise<SendReceipt>
}
