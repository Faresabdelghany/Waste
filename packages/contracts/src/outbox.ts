// The outbox on the wire (Issue #104, §6): one event a context writes in the
// request's transaction after the rows it describes, for the relay (part C)
// to publish and stamp. Not a route's resource — nothing answers it over HTTP
// — but the relay and its test read rows of this shape, and a consumer reads
// `payload`, which is the wire resource as the write left it: a `Route`, a
// `Pickup` with its proof, an `Unload`, a `DriverCommandReceipt`, and, since
// Resolution publishes its three kinds (Issue #109), a `Ticket`. The payload
// is `z.json()` here, since which resource it is depends on the kind and a
// consumer parses it with that kind's schema.
import * as z from "zod"

import { IsoDateTime } from "./dates"
import { OutboxAggregate, OutboxKind } from "./execution"
import { Id } from "./ids"
import { stamped } from "./resource"

export const OutboxEvent = z.object({
  ...stamped,
  projectId: Id,
  kind: OutboxKind,
  aggregateKind: OutboxAggregate,
  /** The route, pickup, unload or command the event is about; a soft id. */
  aggregateId: Id,
  /** The command's instant, not the request's. */
  occurredAt: IsoDateTime,
  /** The wire resource as the write left it. */
  payload: z.json(),
  /** Stamped by the relay; null until it is. */
  publishedAt: IsoDateTime.nullable(),
})
export type OutboxEvent = z.infer<typeof OutboxEvent>
