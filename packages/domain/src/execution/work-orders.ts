// The work orders that move a container through the Stock Movement ledger
// (O3b of #290): a delivery issues a container from stock into service at the
// stop's place, under the subscription it was booked with; a removal returns
// the container to the warehouse it was booked with; a swap returns the one
// taken and issues its replacement under the same subscription, as one.
// Each books what its movements need beside its container, and nothing else
// (`BOOKED_WITH`); the movements run as the driver completes the stop, dated
// by the completion (the API's driver door), and a movement the ledger
// refuses never refuses the driver: the stop is done, and the office is given
// an internal task to record it by hand (`ledgerNotRecorded`).
//
// A planned delivery holds its container back from another booking, and a
// planned swap its replacement (`reservedContainerOf`, which the database's
// generated `reserved_container_id` and its unique index spell); a planned
// removal or swap holds the container it takes away (`takenContainerOf`,
// `taken_container_id`); a stop done, skipped or failed holds nothing. A
// correction of the stop by the office runs the movements when it completes
// the stop, and tells the office they stand when it uncompletes one
// (`ledgerMovedThenCorrected`).
import { SERVICE_NOUNS } from "./services"
import type { PickupService, PickupStatus } from "./vocabulary"

/** The services that move a container through the ledger as their stop completes. */
export const LEDGER_SERVICES = ["deliver", "remove", "swap"] as const satisfies readonly PickupService[]
export type LedgerService = (typeof LEDGER_SERVICES)[number]

export const isLedgerService = (service: PickupService): service is LedgerService => (LEDGER_SERVICES as readonly PickupService[]).includes(service)

/** What a service books beside its container: the fields its booking names, every other refused. */
export type BookedField = "subscriptionId" | "warehouseId" | "replacementContainerId"

export const BOOKED_WITH: Readonly<Record<PickupService, readonly BookedField[]>> = {
  empty: [],
  deliver: ["subscriptionId"],
  remove: ["warehouseId"],
  swap: ["replacementContainerId", "warehouseId"],
  repair: [],
  wash: [],
  bulky: [],
}

/** The movements a completed stop makes, in order: the swap returns the container taken before it issues the replacement. */
export const LEDGER_STEPS: Readonly<Record<LedgerService, readonly ("return" | "issue")[]>> = {
  deliver: ["issue"],
  remove: ["return"],
  swap: ["return", "issue"],
}

/** The container a stop holds back from another booking: a planned delivery's own, or a planned swap's replacement; none otherwise. */
export function reservedContainerOf(stop: { service: PickupService; status: PickupStatus; containerId: string | null; replacementContainerId: string | null }): string | null {
  if (stop.status !== "planned") return null
  if (stop.service === "deliver") return stop.containerId
  if (stop.service === "swap") return stop.replacementContainerId
  return null
}

/** The container a stop takes away from where it serves, held back from another removal or swap: a planned removal's or swap's own; none otherwise. */
export function takenContainerOf(stop: { service: PickupService; status: PickupStatus; containerId: string | null }): string | null {
  return stop.status === "planned" && (stop.service === "remove" || stop.service === "swap") ? stop.containerId : null
}

/** What the work is, where: the facts every ticket about it names. */
type Work = { service: LedgerService; containerLabel: string; replacementLabel: string | null; address: string | null }

/** The work as a subject spells it: "Delivery of BIN-7 to Parkvej 18", "Swap of BIN-1 for BIN-7 at Parkvej 18". */
function workOf(facts: Work): string {
  const noun = SERVICE_NOUNS[facts.service]
  const what = `${noun[0].toUpperCase()}${noun.slice(1)} of ${facts.containerLabel}${facts.service === "swap" && facts.replacementLabel !== null ? ` for ${facts.replacementLabel}` : ""}`
  if (facts.address === null) return what
  return `${what} ${facts.service === "deliver" ? "to" : "at"} ${facts.address}`
}

type LedgerTask = { kind: "internal-task"; priority: "high"; subject: string; description: string }

/** The ticket a movement the ledger refused opens: the office's task to record by hand what was done, at the driver's completion or the office's correction to completed. */
export function ledgerNotRecorded(facts: Work & { by: "driver" | "office"; completedAt: string; sentence: string }): LedgerTask {
  const sentence = facts.sentence.replace(/[.\s]+$/, "")
  const done = facts.by === "driver" ? "The driver completed the stop" : "The office corrected the stop to completed"
  return {
    kind: "internal-task",
    priority: "high",
    subject: `${workOf(facts)} not recorded`,
    description: `${done} at ${facts.completedAt}, but the ledger refused the ${SERVICE_NOUNS[facts.service]}: ${sentence}. Record it through the container's commands.`,
  }
}

/** The ticket a completed work order corrected to skipped or failed opens: the ledger's movements stand, for the office to put back if the work did not happen. */
export function ledgerMovedThenCorrected(facts: Work & { outcome: "skipped" | "failed"; correctedAt: string }): LedgerTask {
  const noun = SERVICE_NOUNS[facts.service]
  return {
    kind: "internal-task",
    priority: "high",
    subject: `${workOf(facts)} recorded, stop now ${facts.outcome}`,
    description: `The ledger recorded the ${noun} when the stop was completed; the office corrected the stop to ${facts.outcome} at ${facts.correctedAt}. If the ${noun} did not happen, put the containers back through their commands.`,
  }
}
