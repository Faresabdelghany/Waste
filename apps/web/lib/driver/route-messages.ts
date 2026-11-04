// A route's messages on the Driver App (O24 of #290): the thread of a route
// assigned to the driver, read from `GET /driver/routes/:id/messages`, and the
// driver's word to the office, `POST /driver/routes/:id/messages`, under an id
// the device mints — a UUIDv7, as a command's is — so a send tried again over
// a lost answer is answered as the message already written. A message is sent
// while the device reaches the API; it is not queued offline, and nothing is
// shown that the server has not answered: the box keeps the text until the
// API took it.
import type { RouteMessage } from "@waste/contracts/route-messages"
import { ID_RANDOM_BYTES, mintId } from "@waste/domain/ids"

import { get, post, type ApiClient } from "../api/client"

/** The longest message, as the contracts bound it: spelled again, since the Driver App imports the contracts as types only, and held equal by a test. */
export const DRIVER_MESSAGE_MAX = 1000

export const readDriverRouteMessages = (client: ApiClient, routeId: string): Promise<RouteMessage[]> => get<RouteMessage[]>(client, `/driver/routes/${encodeURIComponent(routeId)}/messages`)

/** A message's id, minted on the device: the key a send tried again is the same message by. */
export const mintMessageId = (now = Date.now(), fill = (bytes: Uint8Array) => crypto.getRandomValues(bytes)): string => mintId(now, fill(new Uint8Array(ID_RANDOM_BYTES)))

/** The driver's message to the office under the id the device minted, answered as the thread reads it. */
export const sendDriverRouteMessage = (client: ApiClient, routeId: string, message: { id: string; body: string }): Promise<RouteMessage> =>
  post<RouteMessage>(client, `/driver/routes/${encodeURIComponent(routeId)}/messages`, { id: message.id, body: message.body.trim() }).then((answer) => answer.body)

/** Whether the text may be sent: something, and not past the bound. */
export const sendable = (text: string): boolean => {
  const trimmed = text.trim()
  return trimmed.length > 0 && trimmed.length <= DRIVER_MESSAGE_MAX
}

/** Who wrote a message, as the driver reads it: the office, or themselves. */
export const authorLine = (message: Pick<RouteMessage, "author" | "senderName">): string => (message.author === "driver" ? "You" : `Office · ${message.senderName}`)
