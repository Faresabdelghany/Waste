// Route Messages on the wire (O24 of #290): the office and the route's driver
// writing to each other about one route. The office reads and writes a
// route's thread at `/routes/:id/messages`; the driver reads and writes the
// thread of a route assigned to them at `/driver/routes/:id/messages`, under
// an id their device mints, so a send tried again over a lost answer is the
// message already written. A message is never edited or taken back. Plain
// text, one line or a few: what a person says across a cab, not a letter.
import { ROUTE_MESSAGE_AUTHORS } from "@waste/domain/execution/vocabulary"
import * as z from "zod"

import { IsoDateTime } from "./dates"
import { Id } from "./ids"

export const RouteMessageAuthor = z.enum(ROUTE_MESSAGE_AUTHORS)
export type RouteMessageAuthor = z.infer<typeof RouteMessageAuthor>

/** The longest message: a few lines a driver reads at a stop. */
export const ROUTE_MESSAGE_BODY_MAX = 1000

const Body = z
  .string()
  .trim()
  .min(1, "Say something")
  .max(ROUTE_MESSAGE_BODY_MAX, `A message is at most ${ROUTE_MESSAGE_BODY_MAX} characters`)

/** One message of a route's thread, oldest first in a list. */
export const RouteMessage = z.object({
  id: Id,
  projectId: Id,
  routeId: Id,
  author: RouteMessageAuthor,
  /** The account that sent it: the office's person, or the driver's login. */
  sentBy: Id,
  /** The name the thread shows beside it: the person's or the driver's. */
  senderName: z.string(),
  /** The driver profile that wrote it; null for the office's. */
  driverId: Id.nullable(),
  body: z.string(),
  recordedAt: IsoDateTime,
})
export type RouteMessage = z.infer<typeof RouteMessage>

/** The office's message to the route's driver; the server mints the id. */
export const RouteMessageCreate = z.strictObject({ body: Body })
export type RouteMessageCreate = z.infer<typeof RouteMessageCreate>

/** The driver's message to the office, under the id their device minted. */
export const DriverRouteMessageCreate = z.strictObject({ id: Id, body: Body })
export type DriverRouteMessageCreate = z.infer<typeof DriverRouteMessageCreate>
