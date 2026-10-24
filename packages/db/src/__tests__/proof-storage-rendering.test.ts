// Migration 0016 pinned without a database (O1 of #290): the file is
// hand-written whole, so the test holds it to the one spelling in
// sql/proof-storage.ts — the private `proofs` bucket, made or kept private,
// its limits where Storage has the columns, nothing at all where there is no
// Storage — and holds that spelling to the formats an object key may name.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { OBJECT_EXTENSIONS } from "@waste/contracts/execution"
import { PROOF_BUCKET } from "@waste/contracts/proof-objects"

import { MIGRATIONS_FOLDER } from "../migrate"
import { normalised, statementsOf } from "../sql/hand-written"
import { PROOF_MIME_TYPES, PROOF_OBJECT_MAX_BYTES, proofBucketStatement } from "../sql/proof-storage"

const MIGRATION = "0016_proof_storage.sql"

describe("the proofs' bucket", () => {
  test("the file is the one statement, as sql/proof-storage.ts spells it", async () => {
    const statements = statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))
    assert.deepEqual(statements, [normalised(proofBucketStatement())])
  })

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
    assert.deepEqual([...new Set(OBJECT_EXTENSIONS.map(mime))].sort(), [...PROOF_MIME_TYPES].sort())
    assert.match(proofBucketStatement(), /file_size_limit = 2097152, allowed_mime_types = ARRAY\['image\/jpeg', 'image\/png', 'image\/webp'\]/)
  })
})
