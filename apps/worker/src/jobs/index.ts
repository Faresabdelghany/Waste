// The registry: every job this process runs, one per line, in the order the
// wiring registers them. A new job is a new file beside this one exporting a
// `defineJob({ ... })` (definition.ts says what one carries) and one import
// and one line here; nothing else in the process changes. The registry test
// holds the list: every queue named once, every cron expression one pg-boss
// accepts, every scheduled job carrying its data.
//
// Four jobs today. Planning's two (#97 part B): `planning.generate-routes`,
// one run of generation over a scheme and a window, and the nightly
// `planning.plan-ahead`, which sweeps for the schemes to run it over. And
// Execution's `execution.relay-outbox` (#104 part C), which publishes the
// outbox to the `outbox.<kind>` queues. What will join, as the issues have
// it: the outbox's consumers — Resolution's (#109 part B) and Finance's (#112
// part B), each spread into this list from `defineOutboxConsumer`
// (../outbox/subscribe.ts), one entry per kind.
import type { AnyJob } from "./definition"
import { generateRoutes } from "./generate-routes"
import { heartbeat } from "./heartbeat"
import { planAheadJob } from "./plan-ahead"
import { relayOutbox } from "./relay-outbox"

export const JOBS: readonly AnyJob[] = [heartbeat, generateRoutes, planAheadJob, relayOutbox]

export type { AnyJob, JobContext, JobDefinition, JobQueueOptions, PublishedQueue } from "./definition"
export { defineJob } from "./definition"
