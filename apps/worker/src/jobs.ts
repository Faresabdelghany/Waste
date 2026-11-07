// The registry: every job this process runs, in the order the wiring
// registers them, each from the directory of its context. A new job is a file
// of its context exporting a `defineJob({ ... })` (runtime/definition.ts says
// what one carries) and one line here; a new outbox consumer is a
// `defineOutboxConsumer({ ... })` (runtime/outbox.ts) and one line in
// `CONSUMERS`, which the relay is built from, so it sends each kind to every
// consumer that takes it and nothing in the runtime imports a consumer. The
// registry test holds the list: every queue named once, every cron expression
// one pg-boss accepts, every scheduled job carrying its data, every
// consumer's queue one the relay publishes.
import { purgePositionsJob } from "./execution/purge-positions"
import { purgeProofObjectsJob, type ProofRetention } from "./execution/purge-proof-objects"
import { recordBillableEvents } from "./finance/record-billable-events"
import { runScheduledBilling } from "./finance/run-billing"
import { collectionRemindersJob } from "./messaging/collection-reminders"
import type { MessagingDoor } from "./messaging/provider"
import { sendMessageJob } from "./messaging/send-message"
import { noticeCustomers } from "./notifications/customer-notices"
import { notifyStaff } from "./notifications/staff-notifications"
import { generateRoutes } from "./planning/generate-routes"
import { planAheadJob } from "./planning/plan-ahead"
import { applyPauseGrants } from "./registry/apply-pause-grants"
import { proposeRightSizingJob } from "./registry/propose-right-sizing"
import { alertRulesJob } from "./resolution/alert-rules"
import { countEmptyings } from "./resolution/count-emptyings"
import { openTickets } from "./resolution/open-tickets"
import type { RoutingEngine } from "./routing/engine"
import { routingMeasure } from "./routing/measure"
import { routingOptimise } from "./routing/optimise"
import { sweepHorizonJob } from "./routing/sweep-horizon"
import type { AnyJob, JobContext, PollingKnob } from "./runtime/definition"
import { heartbeat } from "./runtime/heartbeat"
import { relayOutbox } from "./runtime/relay-outbox"

/** What the registry's jobs run with: the core, the polling knob, and what the routing, messaging and proofs' jobs add. Every job of the list is held to it here, and main.ts builds it. */
export type WorkerContext = JobContext & PollingKnob & RoutingEngine & MessagingDoor & ProofRetention

/** Every outbox consumer's entries, one per kind it takes: Resolution's, Finance's, the staff notices' and the customer notices' (O16 of #290), the Registry's granted pauses (M11 of #293), then the counting rules' count (#547 of #544). */
export const CONSUMERS: readonly AnyJob<WorkerContext>[] = [...openTickets, ...recordBillableEvents, ...notifyStaff, ...noticeCustomers, ...applyPauseGrants, ...countEmptyings]

/** The relay, sending each kind to the consumers above that take it. */
export const relay = relayOutbox(CONSUMERS)

export const JOBS: readonly AnyJob<WorkerContext>[] = [
  heartbeat,
  generateRoutes,
  planAheadJob,
  routingMeasure,
  routingOptimise,
  sweepHorizonJob,
  relay,
  ...CONSUMERS,
  runScheduledBilling,
  purgeProofObjectsJob,
  alertRulesJob,
  purgePositionsJob,
  sendMessageJob,
  collectionRemindersJob,
  proposeRightSizingJob,
]
