// The ticket-opening statements, once (Issue #109 §5), as apps/api reads
// them. `openTicket`, `appendTicketEvent` and their shapes live in
// `@waste/db/commands/open-ticket` since part B, the home §7.24 proposed for
// the write statements both processes run: `POST /tickets` (routes/tickets.ts)
// calls `openTicket` with the caller's account inside the request's
// transaction, and the worker's consumer (apps/worker/src/jobs/open-tickets.ts)
// calls the same function with `null` and the outbox event's id inside a
// job's transaction under `withCompany`. What the header of that module says
// holds here unchanged — the counter under the company's row lock, the row,
// the `created` event, the alert's link, the `ticket-opened` event, in that
// order and in the caller's transaction, and every history row's shape
// consulted before the insert — and this module is the API's name for it, so
// routes/tickets.ts and ticket-writes.test.ts read it where they always did.
export { appendTicketEvent, openTicket, type OpenTicketInput, type TicketDraft, type TicketEventDraft, type TicketRef } from "@waste/db/commands/open-ticket"
