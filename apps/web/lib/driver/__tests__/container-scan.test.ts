// Confirming a stop's container by its code (O19 of #290): what the screen
// offers, what it says of the door's answer, and the camera's detector where
// the browser has one.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { DriverIdentification, DriverIdentifiedStop } from "@waste/contracts/driver-commands"

import { barcodeDetectorOf, binDetector, BIN_BARCODE_FORMATS, firstCode, scanOffered, scanVerdict, type BarcodeDetectorClass } from "../container-scan"
import { pickup, pickupId } from "./driver-fixtures"

const named = (n: number, over: Partial<DriverIdentifiedStop> = {}): DriverIdentifiedStop => ({ pickupId: pickupId(n), position: n, containerId: `01950000-0000-7000-8000-00000000050${n}`, containerLabel: `BIN-9100${n}`, matchedBy: "barcode", replacement: false, ...over })
const answer = (stops: DriverIdentifiedStop[], code = "WH91001"): DriverIdentification => ({ code, stops })
const numbers = new Map([
  [pickupId(1), 1],
  [pickupId(2), 4],
])
const numberOf = (id: string) => numbers.get(id)

describe("Scan container", () => {
  test("is offered on a stop with a container while it takes a report, never on an address-only stop", () => {
    assert.equal(scanOffered(pickup(1), { report: true }), true)
    assert.equal(scanOffered(pickup(1), { report: false }), false)
    assert.equal(scanOffered(pickup(1, { containerId: null, containerLabel: null }), { report: true }), false)
  })

  test("says what the door answered: this stop's container, another stop's by the screen's number, a swap's replacement, or none on the route", () => {
    assert.deepEqual(scanVerdict(answer([named(1)]), pickupId(1), numberOf), { kind: "this-stop", containerLabel: "BIN-91001" })
    assert.deepEqual(scanVerdict(answer([named(2)]), pickupId(1), numberOf), { kind: "elsewhere", sentence: "BIN-91002 is stop 4's container, not this one" })
    assert.deepEqual(scanVerdict(answer([named(3)]), pickupId(1), numberOf), { kind: "elsewhere", sentence: "BIN-91003 is another stop's container, not this one" })
    assert.deepEqual(scanVerdict(answer([named(1, { replacement: true })]), pickupId(1), numberOf), { kind: "elsewhere", sentence: "BIN-91001 is the replacement a swap brings at stop 1, not this stop's container" })
    assert.deepEqual(scanVerdict(answer([named(2), named(1)]), pickupId(1), numberOf).kind, "this-stop", "a container on two stops is this one's here")
    assert.deepEqual(scanVerdict(answer([], "NOPE"), pickupId(1), numberOf), { kind: "not-on-route", sentence: "NOPE names no container on this route" })
  })

  test("reads with the camera only where the browser has a BarcodeDetector and a camera to feed it", () => {
    class Detector {
      detect = async () => []
    }
    const camera = { mediaDevices: { getUserMedia: () => undefined } }
    assert.equal(barcodeDetectorOf({ BarcodeDetector: Detector, navigator: camera }), Detector)
    assert.equal(barcodeDetectorOf({ navigator: camera }), null, "most desktop browsers: the code is typed")
    assert.equal(barcodeDetectorOf({ BarcodeDetector: Detector, navigator: {} }), null, "no camera")
    assert.equal(barcodeDetectorOf({ BarcodeDetector: Detector }), null)
  })

  test("asks the detector for the bin formats it reads, and for its defaults where it reads none of them or cannot say", async () => {
    const built: Array<{ formats?: string[] } | undefined> = []
    const detectorReading = (supported: (() => Promise<string[]>) | undefined): BarcodeDetectorClass => {
      class Detector {
        static getSupportedFormats = supported
        constructor(options?: { formats?: string[] }) {
          built.push(options)
        }
        detect = async () => []
      }
      return Detector
    }
    await binDetector(detectorReading(async () => ["qr_code", "ean_13", "aztec"]))
    await binDetector(detectorReading(async () => ["aztec"]))
    await binDetector(detectorReading(async () => Promise.reject(new Error("no"))))
    await binDetector(detectorReading(undefined))
    assert.deepEqual(built, [{ formats: ["ean_13", "qr_code"] }, undefined, undefined, undefined])
    assert.ok(BIN_BARCODE_FORMATS.includes("code_128"))
  })

  test("takes the first code a frame holds that says something, trimmed", () => {
    assert.equal(firstCode([{ rawValue: "  " }, { rawValue: " WH91001 " }]), "WH91001")
    assert.equal(firstCode([]), null)
  })
})
