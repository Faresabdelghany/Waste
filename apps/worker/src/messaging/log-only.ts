// The log-only sender (#291 C15), the owner's decision on #291: the whole
// notification system runs on it until a card-free provider is verified. It
// sends nothing — no e-mail, no text message, no key — and writes one line
// naming the message, its channel and its address masked
// (@waste/domain/messaging/template, `maskedAddress`), so the Pilot's log
// shows what would have gone out without holding a resident's address or
// what the message said. Its receipt is the message's own id under `log-`.
import { maskedAddress } from "@waste/domain/messaging/template"

import type { MessagingProvider, OutgoingMessage, SendReceipt } from "./provider"

export const LOG_ONLY_PROVIDER = "log"

export class LogOnlyProvider implements MessagingProvider {
  readonly name = LOG_ONLY_PROVIDER

  constructor(private readonly log: (line: string) => void = (line) => console.log(line)) {}

  async send(message: OutgoingMessage): Promise<SendReceipt> {
    this.log(`messaging: log-only sender: ${message.channel} ${message.id} to ${maskedAddress(message.channel, message.to)}, not sent`)
    return { providerMessageId: `${LOG_ONLY_PROVIDER}-${message.id}` }
  }
}
