// The registry: every job this process runs, one per line, in the order the
// wiring registers them. A new job is a new file beside this one exporting a
// `defineJob({ ... })` (definition.ts says what one carries) and one import
// and one line here; nothing else in the process changes. The registry test
// holds the list: every queue named once, every cron expression one pg-boss
// accepts, every scheduled job carrying its data, every subscription named
// once and spelled as the relay publishes it.
//
// Two jobs today: `worker.heartbeat`, the proof the wiring works, and
// Resolution's `resolution.open-tickets` (#109 part B), the outbox's first
// consumer. What will join, as the issues have it: `planning.generate` and
// the nightly `planning.plan-ahead` (#97 part B), `execution.relay-outbox`
// (#104 part C, which publishes what the consumer subscribes to),
// `finance.record-billable-events` and the scheduled billing run (#112 part
// B).
import type { AnyJob } from "./definition"
import { heartbeat } from "./heartbeat"
import { openTickets } from "./open-tickets"

export const JOBS: readonly AnyJob[] = [heartbeat, openTickets]

export type { AnyJob, JobContext, JobDefinition } from "./definition"
export { defineJob } from "./definition"
