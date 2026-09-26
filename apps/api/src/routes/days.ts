// An instant as the day it falls on, on a project's clock (Issue #101,
// slice 6), as the API imports it. `dayInTimezone` and `lastDayInside` moved
// to `@waste/db/commands/days` with the commands the worker runs (Issue #112
// part B) — a billing run's `issuedOn` and a ticket's closing day are
// rendered on the project's clock by a job as by a request — and
// routes/fleet-lookups.ts, routes/vehicle-allocations.ts and days.test.ts
// read them from this path as they did. The header there says why a day and
// never an instant, and why the parts are assembled rather than trusted.
export { dayInTimezone, lastDayInside } from "@waste/db/commands/days"
