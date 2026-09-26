// The registry: every job this process runs, one per line, in the order the
// wiring registers them. A new job is a new file beside this one exporting a
// `defineJob({ ... })` (definition.ts says what one carries) and one import
// and one line here; nothing else in the process changes. The registry test
// holds the list: every queue named once, every cron expression one pg-boss
// accepts, every scheduled job carrying its data.
//
// Planning's two are here (#97 part B): `planning.generate-routes`, one run
// of generation over a scheme and a window, and the nightly
// `planning.plan-ahead`, which sweeps for the schemes to run it over. What
// will join, as the issues have it: `execution.relay-outbox` (#104 part C),
// `resolution.open-tickets` (#109 part B), `finance.record-billable-events`
// and the scheduled billing run (#112 part B).
import type { AnyJob } from "./definition"
import { generateRoutes } from "./generate-routes"
import { heartbeat } from "./heartbeat"
import { planAheadJob } from "./plan-ahead"

export const JOBS: readonly AnyJob[] = [heartbeat, generateRoutes, planAheadJob]

export type { AnyJob, JobContext, JobDefinition } from "./definition"
export { defineJob } from "./definition"
