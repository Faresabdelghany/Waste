// Confirming a stop's container by its code (O19 of #290): the driver points
// the phone's camera at the bin's barcode — the browser's `BarcodeDetector`,
// where it has one — or types the code off its label or a hand-held RFID
// reader's screen. The screen asks the door which stop of the route the code
// names (`GET /driver/routes/:id/identify`) and says so; a code naming this
// stop's container is sent as an `arrive` carrying it, which the door judges
// against the stop again and keeps as the confirmation. Out of reach, the
// arrival can be queued with the code all the same, and the server's answer
// comes back on the stop as any rejection does. Nothing here decides a match:
// what the screen says is the door's answer.
import type { DriverIdentification, DriverPickup } from "@waste/contracts/driver-commands"

import type { StopActions } from "./route-view"

/** Whether a stop offers Scan container: one with a container, while it takes a report. An address-only stop has nothing to scan. */
export function scanOffered(stop: Pick<DriverPickup, "containerId">, actions: Pick<StopActions, "report">): boolean {
  return actions.report && stop.containerId !== null
}

/** What the door's answer says of a code at a stop. */
export type ScanVerdict =
  /** The code names this stop's container: the arrival goes with it. */
  | { kind: "this-stop"; containerLabel: string }
  /** The code names another stop's container, or the replacement a swap brings. */
  | { kind: "elsewhere"; sentence: string }
  /** The code names no container on this route. */
  | { kind: "not-on-route"; sentence: string }

/**
 * The verdict on a code at one stop, from the door's answer: this stop's own
 * container (never a swap's replacement, which is what the driver brings), or
 * the stop it names, numbered as the screen numbers stops, or none.
 */
export function scanVerdict(answer: DriverIdentification, stopId: string, numberOf: (pickupId: string) => number | undefined): ScanVerdict {
  const here = answer.stops.find((stop) => stop.pickupId === stopId && !stop.replacement)
  if (here !== undefined) return { kind: "this-stop", containerLabel: here.containerLabel }
  const other = answer.stops[0]
  if (other === undefined) return { kind: "not-on-route", sentence: `${answer.code} names no container on this route` }
  if (other.replacement) return { kind: "elsewhere", sentence: `${other.containerLabel} is the replacement a swap brings${numberOf(other.pickupId) === undefined ? "" : ` at stop ${numberOf(other.pickupId)}`}, not this stop's container` }
  const number = numberOf(other.pickupId)
  return { kind: "elsewhere", sentence: `${other.containerLabel} is ${number === undefined ? "another stop's" : `stop ${number}'s`} container, not this one` }
}

/** The barcode formats a bin's label is printed in, asked of the detector where it supports them. */
export const BIN_BARCODE_FORMATS = ["code_128", "code_39", "code_93", "codabar", "ean_13", "ean_8", "itf", "upc_a", "upc_e", "qr_code", "data_matrix"] as const

/** The browser's `BarcodeDetector`, as far as the scan uses it; absent from most desktop browsers and from Safari before 17. */
export type BarcodeDetectorLike = { detect: (source: CanvasImageSource) => Promise<Array<{ rawValue: string }>> }
export type BarcodeDetectorClass = {
  new (options?: { formats?: string[] }): BarcodeDetectorLike
  getSupportedFormats?: () => Promise<string[]>
}

/** The detector class where the browser has one and the phone has a camera to feed it; null where the code is typed. */
export function barcodeDetectorOf(scope: { BarcodeDetector?: unknown; navigator?: { mediaDevices?: { getUserMedia?: unknown } } }): BarcodeDetectorClass | null {
  if (typeof scope.BarcodeDetector !== "function") return null
  if (typeof scope.navigator?.mediaDevices?.getUserMedia !== "function") return null
  return scope.BarcodeDetector as BarcodeDetectorClass
}

/** A detector for the bin formats the browser reads; every format it has where it says none of ours, so a detector is never built over nothing. */
export async function binDetector(Detector: BarcodeDetectorClass): Promise<BarcodeDetectorLike> {
  let supported: string[] = []
  try {
    supported = (await Detector.getSupportedFormats?.()) ?? []
  } catch {
    // A detector that cannot say what it reads is asked for its defaults.
  }
  const formats = BIN_BARCODE_FORMATS.filter((format) => supported.includes(format))
  return formats.length > 0 ? new Detector({ formats }) : new Detector()
}

/** The first code a frame holds that says something, trimmed; null when it holds none. */
export function firstCode(found: ReadonlyArray<{ rawValue: string }>): string | null {
  for (const { rawValue } of found) {
    const code = rawValue.trim()
    if (code !== "") return code
  }
  return null
}
