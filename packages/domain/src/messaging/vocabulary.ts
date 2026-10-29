// Messaging's closed lists (#291 C15), spelled once for the database's CHECK
// and the contracts' `z.enum`, as the Registry's are (registry/vocabulary.ts
// says why one tuple serves both).

/** How a message reaches its recipient: e-mail first, SMS second. A channel added here needs its provider's door in the worker. */
export const MESSAGE_CHANNELS = ["email", "sms"] as const

/**
 * What a message is for, which decides whether the customer's consent
 * (`customer.service_messages_allowed`) governs it: a service message — a
 * collection, a change of service, a ticket's news — is sent only to a
 * customer who allows them; a billing message — an invoice, a reminder — is
 * owed whatever they chose (template.ts, `needsConsent`); a staff message (O16
 * of #290) goes to one of the company's own user accounts, gated by that
 * person's notification preferences rather than a customer's consent.
 */
export const MESSAGE_PURPOSES = ["service", "billing", "staff"] as const

/** What a template is for: a customer's message only, service or billing. A staff message is rendered by the domain from its event (notifications/notices.ts), never from a template. */
export const MESSAGE_TEMPLATE_PURPOSES = ["service", "billing"] as const

/**
 * Where a message on the delivery log stands: queued for the worker; sent by
 * the provider; failed past its attempts; or withheld, never sent, since the
 * customer allows no service messages. Sent, failed and withheld are final.
 */
export const MESSAGE_STATUSES = ["queued", "sent", "failed", "withheld"] as const

/** Whether a template may be used for a new message; an inactive one is kept for the messages it rendered. */
export const MESSAGE_TEMPLATE_STATUSES = ["active", "inactive"] as const

export type MessageChannel = (typeof MESSAGE_CHANNELS)[number]
export type MessagePurpose = (typeof MESSAGE_PURPOSES)[number]
export type MessageTemplatePurpose = (typeof MESSAGE_TEMPLATE_PURPOSES)[number]
export type MessageStatus = (typeof MESSAGE_STATUSES)[number]
export type MessageTemplateStatus = (typeof MESSAGE_TEMPLATE_STATUSES)[number]

/** Every list of this module by its name. */
export const MESSAGING_VOCABULARIES = {
  MESSAGE_CHANNELS,
  MESSAGE_PURPOSES,
  MESSAGE_TEMPLATE_PURPOSES,
  MESSAGE_STATUSES,
  MESSAGE_TEMPLATE_STATUSES,
} as const satisfies Record<string, readonly [string, ...string[]]>
