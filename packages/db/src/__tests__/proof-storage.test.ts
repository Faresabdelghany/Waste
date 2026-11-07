// The proofs' bucket (O1 of #290) as sql/proof-storage.ts spells it, the one
// spelling the migration and the API's boot (src/storage.ts) share: the
// private `proofs` bucket, made or kept private, its limits where Storage has
// the columns, nothing at all where there is no Storage — and that spelling
// held to the formats an object key may name. No database.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { IMAGE_EXTENSIONS, PROOF_BUCKET, PROOF_OBJECT_MAX_BYTES } from "@waste/domain/storage-objects"

import { PROOF_MIME_TYPES, proofBucketStatement } from "../sql/proof-storage"

describe("the proofs' bucket", () => {
  test("does nothing on a database without Storage, and makes the bucket private, never public", () => {
    const statement = proofBucketStatement()
    assert.match(statement, /IF to_regclass\('storage\.buckets'\) IS NULL THEN\s+RETURN;/)
    assert.match(statement, new RegExp(`VALUES \\('${PROOF_BUCKET}', '${PROOF_BUCKET}', false\\)`))
    assert.match(statement, /ON CONFLICT \(id\) DO UPDATE SET public = false;/, "a bucket made public by hand is made private again")
    assert.doesNotMatch(statement, /public = true/)
  })

  test("its limits: two megabytes, and the image formats an object key may name", () => {
    assert.equal(PROOF_OBJECT_MAX_BYTES, 2_097_152)
    const mime = (extension: string) => (extension === "jpg" ? "image/jpeg" : `image/${extension}`)
    assert.deepEqual([...new Set(IMAGE_EXTENSIONS.map(mime))].sort(), [...PROOF_MIME_TYPES].sort())
    assert.match(proofBucketStatement(), /file_size_limit = 2097152, allowed_mime_types = ARRAY\['image\/jpeg', 'image\/png', 'image\/webp'\]/)
  })
})
