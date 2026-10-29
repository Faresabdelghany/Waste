// The registry: every job this process runs, one per line, in the order the
// wiring registers them. A new job is a new file beside this one exporting a
// `defineJob({ ... })` (definition.ts says what one carries) and one import
// and one line here; nothing else in the process changes. The registry test
// holds the list: every queue named once, every cron expression one pg-boss
// accepts, every scheduled job carrying its data, every consumer's queue one
// the relay publishes.
//
// Fifteen entries today, eight jobs and two consumers. Planning's two (#97
// part B): `planning.generate-routes`, one run of generation over a scheme and
// a window, and the nightly `planning.plan-ahead`, which sweeps for the
// schemes to run it over. Routing's three (#169, #171, #172):
// `routing.measure`, a baseline or manual Plan's legs and totals, and
// `routing.optimise`, an optimiser Plan's order, both through the routing
// provider and its quota engine, and the nightly `routing.sweep-horizon`,
// which asks the coming week's routes their Plans. Execution's
// `execution.relay-outbox` (#104 part C), which sends the outbox to the
// `outbox.<kind>` queues. Resolution's consumer (#109 part B), four entries
// on the queues of the kinds that become a ticket. And Finance's (#112 part
// B): its consumer, three entries on `pickup-completed`, `pickup-corrected`
// and `ticket-completed`, and the monthly `finance.run-billing`. A consumer
// is `...defineOutboxConsumer({ ... })` spread into the list, one entry per
// kind (../outbox/subscribe.ts). Execution's two nightly purges keep what a
// driver's day leaves for no longer than it is owed: the proofs' objects (O1
// of #290) and the positions (O8 of #290). And messaging's `messaging.send`
// (#291 C15), one queued message through the messaging provider. And
// right-sizing's nightly `customers.propose-right-sizing` (M23b of #293).
import { alertRulesJob, ALERT_RULES_QUEUE, rulesSchedule } from "./alert-rules"
import type { AnyJob } from "./definition"
import { generateRoutes } from "./generate-routes"
import { heartbeat } from "./heartbeat"
import { planAheadJob } from "./plan-ahead"
import { proposeRightSizingJob } from "./propose-right-sizing"
import { purgePositionsJob } from "./purge-positions"
import { purgeProofObjectsJob } from "./purge-proof-objects"
import { relayOutbox } from "./relay-outbox"
import { sweepHorizonJob } from "./routing-horizon"
import { routingMeasure } from "./routing-measure"
import { routingOptimise } from "./routing-optimise"
import { runScheduledBilling } from "./run-billing"
import { sendMessageJob } from "./send-message"
import { OUTBOX_CONSUMERS } from "../outbox/routes"

export const JOBS: readonly AnyJob[] = [heartbeat, generateRoutes, planAheadJob, routingMeasure, routingOptimise, sweepHorizonJob, relayOutbox, ...OUTBOX_CONSUMERS, runScheduledBilling, purgeProofObjectsJob, alertRulesJob, purgePositionsJob, sendMessageJob, proposeRightSizingJob]

/** The registry with the alert rules on the cadence `WORKER_RULES_INTERVAL_SECONDS` sets (O4 of #290); the registry as it is where it is unset. */
export const jobsWithRulesEvery = (seconds: number | undefined): readonly AnyJob[] =>
  seconds === undefined ? JOBS : JOBS.map((job) => (job.queue === ALERT_RULES_QUEUE ? { ...job, schedule: rulesSchedule(seconds) } : job))

export type { AnyJob, JobContext, JobDefinition, JobQueueOptions, PublishedQueue } from "./definition"
export { defineJob } from "./definition"
