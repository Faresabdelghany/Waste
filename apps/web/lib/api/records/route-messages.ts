// A route's messages with its driver on the Pilot (O24 of #290): the thread
// the office reads in the route's details, `GET /routes/:id/messages`, and
// the office's send, `POST /routes/:id/messages`. The answer is the message,
// not the route, so the send is the client's and the route stays as it is;
// the thread is read again after it. The driver's side is the Driver App's
// (lib/driver/route-messages.ts).
import type { RouteMessage } from "@waste/contracts/route-messages"

import { get, post } from "../client"
import { shownOn } from "./clock"

type Client = Parameters<typeof get>[0]

/** The longest message, as the contracts bound it: spelled again, since the contracts reach the bundle as types alone, and held equal by a test. */
export const ROUTE_MESSAGE_MAX = 1000

/** The route's thread, oldest first. */
export const routeMessages = (client: Client, serverId: string): Promise<RouteMessage[]> => get<RouteMessage[]>(client, `/routes/${serverId}/messages`)

/** The office's message to the route's driver, answered as the thread reads it. */
export const sendRouteMessage = (client: Client, serverId: string, body: string): Promise<RouteMessage> =>
  post<RouteMessage>(client, `/routes/${serverId}/messages`, { body: body.trim() }).then((answer) => answer.body)

/** A message's line in the thread: who, when on the route's project's clock, and what. */
export const messageLine = (message: RouteMessage, timezone: string | undefined): { who: string; when: string; body: string; fromDriver: boolean } => ({
  who: message.author === "driver" ? `${message.senderName} (driver)` : message.senderName,
  when: shownOn(message.recordedAt, timezone),
  body: message.body,
  fromDriver: message.author === "driver",
})

/** Why a draft is not sent yet, or null where it may be. */
export const draftRefusal = (draft: string): string | null => {
  const text = draft.trim()
  if (text.length === 0) return "Say something"
  if (text.length > ROUTE_MESSAGE_MAX) return `A message is at most ${ROUTE_MESSAGE_MAX} characters`
  return null
}
