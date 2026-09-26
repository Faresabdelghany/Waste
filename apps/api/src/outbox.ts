// The outbox's one writer, as the API imports it. `emit` and its two types
// moved to `@waste/db/commands/outbox` with the commands the worker runs
// (Issue #112 part B) — `issueInvoice` emits `invoice-issued` inside a
// billing run the worker schedules, with no request in hand — and every
// route here reads it from this path as it did (routes/routes.ts,
// routes/pickups.ts, routes/unloads.ts, routes/driver.ts, routes/tickets.ts,
// routes/settlements.ts, routes/ticket-writes.ts). The header of
// `packages/db/src/commands/outbox.ts` says what an event carries and why.
export { emit, type OutboxEventDraft, type Tenant } from "@waste/db/commands/outbox"
