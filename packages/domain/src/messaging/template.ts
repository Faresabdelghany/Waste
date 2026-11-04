// A message template's rules (#291 C15), pure: the placeholders a text names
// (`{{recipientName}}`), the ones no message fills, the text rendered from
// its values, what a channel asks of a template, which purposes the
// customer's consent governs, and an address told in a log line without
// being spelled out. The API refuses a template naming a placeholder nobody
// fills, so a message is never sent with a hole in it; @waste/db's
// `queueMessage` renders it once, when the message is queued, and the
// delivery log keeps what was rendered.
import type { MessageChannel, MessagePurpose } from "./vocabulary"

/**
 * The values a message fills, by name: who it is to, the customer it is
 * about, and the company sending it. A slice that sends something more (an
 * invoice's number, a collection's day) adds its names here and its values
 * where it queues.
 */
export const MESSAGE_VARIABLES = ["recipientName", "customerName", "companyName"] as const
export type MessageVariable = (typeof MESSAGE_VARIABLES)[number]
export type MessageValues = Readonly<Record<MessageVariable, string>>

/** Text messages longer than this are refused: four concatenated segments of 160 characters. */
export const SMS_BODY_MAX = 640

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g

/** The names a text's placeholders name, each once, in the order first named. */
export function placeholdersOf(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((match) => match[1]))]
}

/** The placeholders of a text that no message fills. */
export function unknownPlaceholders(text: string): string[] {
  return placeholdersOf(text).filter((name) => !(MESSAGE_VARIABLES as readonly string[]).includes(name))
}

/** The text with each placeholder replaced by its value, in one pass, so a value is never read as a placeholder of its own. */
export function renderTemplate(text: string, values: MessageValues): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => (name in values ? values[name as MessageVariable] : whole))
}

/** What a channel asks of a template: an e-mail a subject, a text message none and a body that fits; undefined where it holds. */
export function channelShapeIssue(template: { channel: MessageChannel; subject: string | null; body: string }): { path: "subject" | "body"; message: string } | undefined {
  if (template.channel === "email") return template.subject === null ? { path: "subject", message: "An e-mail template has a subject" } : undefined
  if (template.subject !== null) return { path: "subject", message: "A text message has no subject" }
  if (template.body.length > SMS_BODY_MAX) return { path: "body", message: `A text message is at most ${SMS_BODY_MAX} characters` }
  return undefined
}

/** Whether the customer's consent governs a message of this purpose: a service message's, never a billing one's or a staff one's. */
export const needsConsent = (purpose: MessagePurpose): boolean => purpose === "service"

/** An address as a log line tells it: an e-mail's first letter and domain, a phone's last two digits. */
export function maskedAddress(channel: MessageChannel, address: string): string {
  if (channel === "email") {
    const at = address.indexOf("@")
    return at < 1 ? "***" : `${address[0]}***${address.slice(at)}`
  }
  const digits = address.replace(/\D/g, "")
  return digits.length < 2 ? "***" : `***${digits.slice(-2)}`
}
