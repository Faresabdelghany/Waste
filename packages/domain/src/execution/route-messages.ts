// A route's messages (O24 of #290): a few lines between the office and the
// route's driver, read at a stop. A message says something once its spaces
// are trimmed, and no more than a driver reads standing at a bin.

/** The longest message. */
export const ROUTE_MESSAGE_BODY_MAX = 1000

/** What a message of nothing but spaces is told. */
export const SAY_SOMETHING = "Say something"

/** What a message past the bound is told. */
export const MESSAGE_TOO_LONG = `A message is at most ${ROUTE_MESSAGE_BODY_MAX} characters`

/** Why a message as typed is not sent, or null where it may be. */
export function routeMessageIssue(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed.length === 0) return SAY_SOMETHING
  if (trimmed.length > ROUTE_MESSAGE_BODY_MAX) return MESSAGE_TOO_LONG
  return null
}
