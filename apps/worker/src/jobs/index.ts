// The registry: every job this process runs, one per line, in the order the
// wiring registers them. A new job is a new file beside this one exporting a
// `defineJob({ ... })` (definition.ts says what one carries) and one import
// and one line here; nothing else in the process changes. The registry test
// holds the list: every queue named once, every cron expression one pg-boss
// accepts, every scheduled job carrying its data, every consumer's queue one
// the relay publishes.
//
// Fourteen entries today, seven jobs and two consumers. Planning's two (#97
// part B): `planning.generate-routes`, one run of generation over a scheme and
// a window, and the nightly `planning.plan-ahead`, which sweeps for the
// schemes to run it over. Routing's two (#169, #171): `routing.measure`, a
// baseline or manual Plan's legs and totals, and `routing.optimise`, an
// optimiser Plan's order, both through the routing provider and its quota
// engine. Execution's
// `execution.relay-outbox` (#104 part C), which sends the outbox to the
// `outbox.<kind>` queues. Resolution's consumer (#109 part B), four entries
// on the queues of the kinds that become a ticket. And Finance's (#112 part
// B): its consumer, three entries on `pickup-completed`, `pickup-corrected`
// and `ticket-completed`, and the monthly `finance.run-billing`. A consumer
// is `...defineOutboxConsumer({ ... })` spread into the list, one entry per
// kind (../outbox/subscribe.ts).
import type { AnyJob } from "./definition"
import { generateRoutes } from "./generate-routes"
import { heartbeat } from "./heartbeat"
import { openTickets } from "./open-tickets"
import { planAheadJob } from "./plan-ahead"
import { recordBillableEvents } from "./record-billable-events"
import { relayOutbox } from "./relay-outbox"
import { routingMeasure } from "./routing-measure"
import { routingOptimise } from "./routing-optimise"
import { runScheduledBilling } from "./run-billing"

export const JOBS: readonly AnyJob[] = [heartbeat, generateRoutes, planAheadJob, routingMeasure, routingOptimise, relayOutbox, ...openTickets, ...recordBillableEvents, runScheduledBilling]

export type { AnyJob, JobContext, JobDefinition, JobQueueOptions, PublishedQueue } from "./definition"
export { defineJob } from "./definition"
