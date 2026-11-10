// The proofs' bucket's limits (O1 of #290), which the API's boot holds the
// bucket to (`ensureBucket`, src/storage.ts): two megabytes, and the image
// formats an object key may name. No database.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { IMAGE_EXTENSIONS, PROOF_OBJECT_MAX_BYTES } from "@waste/domain/storage-objects"

import { PROOF_MIME_TYPES } from "../sql/proof-storage"

describe("the proofs' bucket", () => {
  test("its limits: two megabytes, and the image formats an object key may name", () => {
    assert.equal(PROOF_OBJECT_MAX_BYTES, 2_097_152)
    const mime = (extension: string) => (extension === "jpg" ? "image/jpeg" : `image/${extension}`)
    assert.deepEqual([...new Set(IMAGE_EXTENSIONS.map(mime))].sort(), [...PROOF_MIME_TYPES].sort())
  })
})
