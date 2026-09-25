// The outbox's one writer (Issue #104, §6). Every office command that
// changes what another context would hear about — a route dispatched,
// reassigned or cancelled, a pickup skipped or corrected, an unload recorded
// (routes/routes.ts, routes/pickups.ts, routes/unloads.ts) — and every applied
// or rejected driver command (routes/driver.ts) inserts its `outbox_event`
// rows here, in the request's transaction and after the rows they describe,
// so the event commits with the change or not at all. The relay (part C)
// reads the unpublished rows across companies and stamps `published_at`;
// nothing here reads them back.
//
// The payload is the wire resource as the route would answer it at that
// instant — a `Route`, a `PickupDetail` with the proof the command made, an
// `Unload`, a `DriverCommandReceipt` — so a consumer reads what the API
// would have answered and never the tables. One event carries a little
// more: a route-level `report-problem` (no pickup named) writes
// `pickup-problem-reported` on the route aggregate with the `Route` plus
// `proofs`, the problem proof the command made, the way a stop's problem
// travels inside its `PickupDetail`, so the `reason` and the `note` reach
// Resolution whichever aggregate the problem was reported on and a consumer
// reads `proofs[0]` either way. `occurredAt` is the command's
// instant and not the request's: the day a cancelled route was cancelled,
// the instant a pickup left `planned`, when the truck tipped. `projectId`
// travels with the event because every Execution row is a project's and the
// relay groups by company under `withCompany` as `wms_api`, whose fence
// needs the tenant on every row.
import type { Tx } from "@waste/db/client"
import { outboxEvent } from "@waste/db/schema/execution"
import type { OutboxAggregate, OutboxKind } from "@waste/domain/execution/vocabulary"

import type { Principal } from "./auth/principal"
import { newId } from "./ids"

/** One event as a route or the applier hands it in: what it is about, what happened, the resource as answered, and when. */
export type OutboxEventDraft = {
  /** What the event is about: a route, a pickup, an unload or a command. */
  aggregate: OutboxAggregate
  /** The id of that route, pickup, unload or command; a soft id, joined by nobody. */
  aggregateId: string
  kind: OutboxKind
  /** The wire resource as the write left it. */
  payload: unknown
  /** The project the aggregate belongs to. */
  projectId: string
  /** The command's instant, not the request's. */
  occurredAt: Date
}

/** Inserts one `outbox_event` row, server-minted id, unpublished, in the request's transaction. */
export async function emit(tx: Tx, principal: Principal, event: OutboxEventDraft): Promise<void> {
  await tx.insert(outboxEvent).values({
    id: newId(),
    companyId: principal.companyId,
    projectId: event.projectId,
    kind: event.kind,
    aggregateKind: event.aggregate,
    aggregateId: event.aggregateId,
    occurredAt: event.occurredAt,
    payload: event.payload,
  })
}
