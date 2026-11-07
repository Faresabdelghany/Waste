// The outbox's one writer (Issue #104 §6; here since Issue #109 part B).
// Every office command that changes what another context would hear about —
// a route dispatched, reassigned or cancelled, a pickup skipped or corrected,
// an unload recorded — every applied or rejected driver command, every
// ticket opened, completed or rejected and every invoice issued and
// settlement closed inserts its `outbox_event` row here, in the caller's
// transaction and after the rows it describes, so the event commits with the
// change or not at all. The relay (#104 part C) reads the unpublished rows
// across companies and stamps `published_at`; nothing here reads them back.
//
// The payload is the wire resource as the caller would answer it at that
// instant — a `Route`, a `PickupDetail` with the proof the command made, an
// `Unload`, a `DriverCommandReceipt`, a `Ticket` — so a consumer reads what
// the API would have answered and never the tables; which resource each kind
// carries is `OUTBOX_PAYLOADS`' (@waste/contracts/outbox), which the draft is
// typed by, and what it is about is the kind's (@waste/domain/outbox), which
// a draft never names. `occurredAt` is the command's instant and not the
// request's: the day a cancelled route was cancelled, the instant a pickup
// left `planned`, when the truck tipped.
// `projectId` travels with the event because every row here is a project's
// and the relay groups by company under `withCompany` as `wms_api`, whose
// fence needs the tenant on every row.
//
// It lived in apps/api/src/outbox.ts until the worker became the second
// process that writes the outbox (Issue #109 part B and #112 part B) —
// Resolution's consumer opens a ticket from an event with no request in hand
// and emits `ticket-opened` like the office's create does, and Finance's
// billing run issues invoices on a schedule and emits `invoice-issued` — so it
// moved to the package both processes consume, beside the write statements
// that call it (`commands/open-ticket.ts`, `commands/invoice-writes.ts`), and
// the API's routes import it from here. It
// takes the tenant it needs and nothing more, `{ companyId }`, which a
// `Principal` satisfies and a job's event carries: the API's routes pass what
// they passed, the commands pass the company alone, and the worker's jobs pass
// the event's.
import type { OutboxPayloadInput } from "@waste/contracts/outbox"
import { aggregateOf, type OutboxKind } from "@waste/domain/outbox/vocabulary"

import type { Tx } from "../client"
import { newId } from "../ids"
import { outboxEvent } from "../schema/execution"

/** Whose event it is: the tenant, which is all the row needs of the caller. A Principal is one; so is the worker's job. */
export type Tenant = { companyId: string }

/** One event as a route, the applier or a shared statement hands it in, typed by its kind: what happened, the id of what it is about and that aggregate's wire resource as the write left it. */
export type OutboxEventDraft<K extends OutboxKind = OutboxKind> = K extends OutboxKind
  ? {
      kind: K
      /** The id of what the event is about; a soft id, joined by nobody. */
      aggregateId: string
      payload: OutboxPayloadInput<K>
      /** The project the aggregate belongs to. */
      projectId: string
      /** The command's instant, not the request's. */
      occurredAt: Date
    }
  : never

/** Inserts one `outbox_event` row, server-minted id, unpublished, in the caller's transaction. */
export async function emit(tx: Tx, tenant: Tenant, event: OutboxEventDraft): Promise<void> {
  await tx.insert(outboxEvent).values({
    id: newId(),
    companyId: tenant.companyId,
    projectId: event.projectId,
    kind: event.kind,
    aggregateKind: aggregateOf(event.kind),
    aggregateId: event.aggregateId,
    occurredAt: event.occurredAt,
    payload: event.payload,
  })
}
