// A route's messages with its driver on the Pilot (O24 of #290): the thread
// the office reads in the route's details, `GET /routes/:id/messages`, and
// the office's send, `POST /routes/:id/messages`. The answer is the message,
// not the route, so the send is the client's and the route stays as it is;
// the thread is read again after it. The driver's side is the Driver App's
// (lib/driver/route-messages.ts).
import type { RouteMessage } from "@waste/contracts/route-messages"
import { routeMessageIssue } from "@waste/domain/execution/route-messages"

import { get, post } from "../client"
import { shownOn } from "./clock"

type Client = Parameters<typeof get>[0]

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
export const draftRefusal = routeMessageIssue
