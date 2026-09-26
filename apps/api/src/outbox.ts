// The outbox's one writer, as apps/api reads it. `emit` and its two types
// live in `@waste/db/commands/outbox` since Issue #109 part B and #112 part
// B, when the worker became the second process that writes the outbox —
// Resolution's consumer emits `ticket-opened` from a job with no request in
// hand, through the same `openTicket` the office's create runs, and
// `issueInvoice` emits `invoice-issued` inside a billing run the worker
// schedules — so the writer moved to the package both processes consume,
// beside the statements that call it. Every office command (routes/routes.ts,
// routes/pickups.ts, routes/unloads.ts), the driver door (routes/driver.ts),
// the ticket commands (routes/tickets.ts, routes/ticket-writes.ts) and
// Finance's two closings (routes/settlements.ts and the invoice writes) read
// it here, under the name they always used, and what the header of that
// module says of the payload, the instant and the tenant holds unchanged: the
// payload is the wire resource as the route answered it, `occurredAt` is the
// command's instant and not the request's, and `emit` takes `{ companyId }`,
// which a `Principal` satisfies.
export { emit, type OutboxEventDraft, type Tenant } from "@waste/db/commands/outbox"
