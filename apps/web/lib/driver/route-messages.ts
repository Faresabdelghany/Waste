// A route's messages on the Driver App (O24 of #290): the thread of a route
// assigned to the driver, read from `GET /driver/routes/:id/messages`, and the
// driver's word to the office, `POST /driver/routes/:id/messages`, under an id
// the device mints — a UUIDv7, as a command's is — so a send tried again over
// a lost answer is answered as the message already written. A message is sent
// while the device reaches the API; it is not queued offline, and nothing is
// shown that the server has not answered: the box keeps the text until the
// API took it.
import type { RouteMessage } from "@waste/contracts/route-messages"
import { routeMessageIssue } from "@waste/domain/execution/route-messages"
import { ID_RANDOM_BYTES, mintId } from "@waste/domain/ids"

import { get, post, type ApiClient } from "../api/client"

export const readDriverRouteMessages = (client: ApiClient, routeId: string): Promise<RouteMessage[]> => get<RouteMessage[]>(client, `/driver/routes/${encodeURIComponent(routeId)}/messages`)

/** A message's id, minted on the device: the key a send tried again is the same message by. */
export const mintMessageId = (now = Date.now(), fill = (bytes: Uint8Array) => crypto.getRandomValues(bytes)): string => mintId(now, fill(new Uint8Array(ID_RANDOM_BYTES)))

export const sendDriverRouteMessage = (client: ApiClient, routeId: string, message: { id: string; body: string }): Promise<RouteMessage> =>
  post<RouteMessage>(client, `/driver/routes/${encodeURIComponent(routeId)}/messages`, { id: message.id, body: message.body.trim() }).then((answer) => answer.body)

export const sendable = (text: string): boolean => routeMessageIssue(text) === null

export const authorLine = (message: Pick<RouteMessage, "author" | "senderName">): string => (message.author === "driver" ? "You" : `Office · ${message.senderName}`)
