// A photo's and a signature's bytes as the Driver App makes them (O1 of #290):
// a photo scaled to fit 1600 px and sent as JPEG, never larger than the
// bucket takes, and the per-stop photo the deployment turns on; the canvas
// work itself is the browser's, which the API e2e suite drives.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { PROOF_OBJECT_MAX_BYTES } from "@waste/contracts/proof-objects"

import { dataUrlOf, fitWithin, PHOTO_BYTES_MAX, PHOTO_MAX_EDGE, stopPhotosOf } from "../proof-images"

describe("a photo", () => {
  test("is scaled to fit its longer edge within 1600 px, its shape kept, and a smaller one is left as it is", () => {
    assert.equal(PHOTO_MAX_EDGE, 1600)
    assert.deepEqual(fitWithin(4032, 3024, PHOTO_MAX_EDGE), { width: 1600, height: 1200 })
    assert.deepEqual(fitWithin(3024, 4032, PHOTO_MAX_EDGE), { width: 1200, height: 1600 })
    assert.deepEqual(fitWithin(1000, 3000, PHOTO_MAX_EDGE), { width: 533, height: 1600 })
    assert.deepEqual(fitWithin(800, 600, PHOTO_MAX_EDGE), { width: 800, height: 600 })
  })

  test("is never larger than the bucket takes, spelled again here so no zod reaches the browser", () => {
    assert.equal(PHOTO_BYTES_MAX, PROOF_OBJECT_MAX_BYTES)
  })

  test("is shown before it goes as its own bytes, a large one whole", () => {
    assert.equal(dataUrlOf({ extension: "png", contentType: "image/png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer }), "data:image/png;base64,iVBORw==")
    const large = new Uint8Array(100_000).map((_, index) => index % 251)
    const url = dataUrlOf({ extension: "jpg", contentType: "image/jpeg", bytes: large.buffer })
    assert.deepEqual(new Uint8Array(Buffer.from(url.slice("data:image/jpeg;base64,".length), "base64")), large)
  })
})

describe("the per-stop photo", () => {
  test("is offered only where the deployment turns it on", () => {
    assert.equal(stopPhotosOf({ NEXT_PUBLIC_DRIVER_STOP_PHOTOS: "true" }), true)
    assert.equal(stopPhotosOf({ NEXT_PUBLIC_DRIVER_STOP_PHOTOS: " true " }), true)
    assert.equal(stopPhotosOf({ NEXT_PUBLIC_DRIVER_STOP_PHOTOS: "false" }), false)
    assert.equal(stopPhotosOf({ NEXT_PUBLIC_DRIVER_STOP_PHOTOS: "" }), false)
    assert.equal(stopPhotosOf({}), false)
  })
})
