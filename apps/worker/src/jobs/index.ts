// The registry: every job this process runs, one per line, in the order the
// wiring registers them. A new job is a new file beside this one exporting a
// `defineJob({ ... })` (definition.ts says what one carries) and one import
// and one line here; nothing else in the process changes. The registry test
// holds the list: every queue named once, every cron expression one pg-boss
// accepts, every scheduled job carrying its data, every subscription a kind
// of the outbox.
//
// Three jobs today: the heartbeat, and Finance's two (Issue #112 part B) —
// the consumer of the outbox's `pickup-completed`, `pickup-corrected` and
// `ticket-completed`, and the monthly billing run. What will join, as the
// issues have it: `planning.generate` and the nightly `planning.plan-ahead`
// (#97 part B), `execution.relay-outbox` (#104 part C), which publishes what
// the consumer here subscribes to, and `resolution.open-tickets` (#109 part B).
import type { AnyJob } from "./definition"
import { heartbeat } from "./heartbeat"
import { recordBillableEvents } from "./record-billable-events"
import { runScheduledBilling } from "./run-billing"

export const JOBS: readonly AnyJob[] = [heartbeat, recordBillableEvents, runScheduledBilling]

export type { AnyJob, JobContext, JobDefinition } from "./definition"
export { defineJob } from "./definition"
