// A transfer station's haul-out (M17 of #293, row 28.3): the material a
// Transfer Station holds, and the Outbound Loads that take it on to the site
// that treats or disposes of it, each reconciled against that site's own
// ticket.
//
// What a station holds is a reading, never a stored figure: by project and
// fraction, what our Unloads tipped there (by their weight review, as the
// tonnage report counts them: approved and not yet reviewed, never a rejected
// weight nor one a correction superseded, and never a load the station
// refused), less what left on Outbound Loads that were not cancelled, plus
// the office's adjustments after a stock count. It may read below zero: the
// weighings at either end are evidence, not a balance the API holds, and a
// count's adjustment is how the office brings the figure back to the heap.
//
// The load machine: `departed` by its creation; `departed → received` when
// the receiving site's ticket is recorded; `received → reconciled` when the
// office accepts it, or `→ disputed` when it does not; a disputed load is
// reconciled once the difference is settled. Recording the receipt again on a
// received or disputed load corrects it and reads the load as received. Only
// a load that has not been received is cancelled; `reconciled` and
// `cancelled` are terminal. The transitions answer as Execution's do
// (transitions.ts): the next status, a command already done, or the sentence
// the API answers as its 409.
//
// The receipt reads as an Unload's load does (O9 of #290): the receiving
// site's net against our out-weighing, in percent of ours, and whether that
// is within the project's weight tolerance.
import type { Transition } from "./transitions"
import { loadReading } from "./unloads"
import type { OutboundLoadStatus } from "./vocabulary"

/** What moves an Outbound Load after it departs. */
export const OUTBOUND_LOAD_COMMANDS = ["receive", "reconcile", "dispute", "cancel"] as const
export type OutboundLoadCommand = (typeof OUTBOUND_LOAD_COMMANDS)[number]

/** A load in a terminal status, asked to change. */
export const loadDoesNotChange = (status: "reconciled" | "cancelled"): string => `The load is ${status} and does not change`
/** Reconciling or disputing a load the receiving site has not answered for. */
export const LOAD_NOT_RECEIVED = "The load is not received yet; record the receiving site's ticket first"
/** Cancelling a load the receiving site took. */
export const LOAD_RECEIVED_NOT_CANCELLED = "The load was received; a received load is reconciled or disputed, never cancelled"
/** A load sent to the station it left from. */
export const SAME_STATION = "A load goes to another station than the one it leaves"
/** A load from a station that holds nothing. */
export const notATransferStation = (name: string): string => `${name} is not a transfer station; only a transfer station sends material on`
/** A dispute or a cancellation without its reason. */
export const SAY_WHY = "Say why"

/** What `command` does to a load in `status`. */
export function outboundLoadTransition(status: OutboundLoadStatus, command: OutboundLoadCommand): Transition<OutboundLoadStatus> {
  if (status === "reconciled") return command === "reconcile" ? { kind: "stay" } : { kind: "refuse", sentence: loadDoesNotChange("reconciled") }
  if (status === "cancelled") return command === "cancel" ? { kind: "stay" } : { kind: "refuse", sentence: loadDoesNotChange("cancelled") }
  switch (command) {
    case "receive":
      return { kind: "move", to: "received" }
    case "reconcile":
      return status === "departed" ? { kind: "refuse", sentence: LOAD_NOT_RECEIVED } : { kind: "move", to: "reconciled" }
    case "dispute":
      if (status === "departed") return { kind: "refuse", sentence: LOAD_NOT_RECEIVED }
      return status === "disputed" ? { kind: "stay" } : { kind: "move", to: "disputed" }
    case "cancel":
      return status === "departed" ? { kind: "move", to: "cancelled" } : { kind: "refuse", sentence: LOAD_RECEIVED_NOT_CANCELLED }
  }
}

/** Whether a load in `status` carries the receiving site's ticket. */
export const isReceived = (status: OutboundLoadStatus): boolean => status === "received" || status === "reconciled" || status === "disputed"

/** The receiving site's net against our out-weighing: the difference in kilograms, in percent of ours to one decimal, and whether that is within the tolerance. */
export function receiptReading(load: { netKg: number; receivedNetKg: number }, tolerancePercent: number): { differenceKg: number; deviationPercent: number; withinTolerance: boolean } {
  // Our out-weighing is always given and positive, so the reading is never null here.
  const reading = loadReading({ netKg: load.receivedNetKg, onBoardKg: load.netKg }, tolerancePercent)!
  return { differenceKg: load.receivedNetKg - load.netKg, deviationPercent: reading.deviationPercent, withinTolerance: reading.withinTolerance }
}

/** What a transfer station holds of one fraction for one project, in kilograms: tipped in, less sent on, plus the counts' adjustments. */
export function materialOnHand(stock: { inKg: number; outKg: number; adjustedKg: number }): number {
  return stock.inKg - stock.outKg + stock.adjustedKg
}
