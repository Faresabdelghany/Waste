// The registry: every job this process runs, one per line, in the order the
// wiring registers them. A new job is a new file beside this one exporting a
// `defineJob({ ... })` (definition.ts says what one carries) and one import
// and one line here; nothing else in the process changes. The registry test
// holds the list: every queue named once, every cron expression one pg-boss
// accepts, every scheduled job carrying its data, every subscription named
// once and spelled as the relay publishes it.
//
// Seven jobs today. Planning's two (#97 part B): `planning.generate-routes`,
// one run of generation over a scheme and a window, and the nightly
// `planning.plan-ahead`, which sweeps for the schemes to run it over.
// Execution's `execution.relay-outbox` (#104 part C), which publishes the
// outbox to the `outbox.<kind>` queues. Resolution's
// `resolution.open-tickets` (#109 part B), the outbox's first consumer. And
// Finance's two (#112 part B): the consumer of the outbox's
// `pickup-completed`, `pickup-corrected` and `ticket-completed`, and the
// monthly billing run.
import type { AnyJob } from "./definition"
import { generateRoutes } from "./generate-routes"
import { heartbeat } from "./heartbeat"
import { openTickets } from "./open-tickets"
import { planAheadJob } from "./plan-ahead"
import { recordBillableEvents } from "./record-billable-events"
import { relayOutbox } from "./relay-outbox"
import { runScheduledBilling } from "./run-billing"

export const JOBS: readonly AnyJob[] = [heartbeat, generateRoutes, planAheadJob, relayOutbox, openTickets, recordBillableEvents, runScheduledBilling]

export type { AnyJob, JobContext, JobDefinition, JobQueueOptions, PublishedQueue } from "./definition"
export { defineJob } from "./definition"
