// The proofs' bucket on the API's boot (O1 of #290): made where Storage lacks
// it, found in place where it has it, and a Storage that refuses or is
// silent told to the error sink, never thrown at the boot. No database.
import assert from "node:assert/strict"
import { test } from "node:test"

import { StorageRefused, StorageSilent } from "@waste/db/storage"

import { ensureProofBucket } from "../proof-bucket"

test("is made where Storage lacks it or found in place, and a Storage that refuses or is silent goes to the error sink, never thrown at the boot", async () => {
  const answers: Array<() => Promise<"made" | "kept">> = [
    async () => "made",
    async () => "kept",
    async () => {
      throw new StorageRefused("Storage answered 400: invalid compact JWS")
    },
    async () => {
      throw new StorageSilent("Storage did not answer POST /bucket")
    },
  ]
  const info: string[] = []
  const error: string[] = []
  for (const answer of answers) await ensureProofBucket({ ensureBucket: answer }, { info: (line) => void info.push(line), error: (line) => void error.push(line) })
  assert.deepEqual(info, ["proofs: the private bucket was made", "proofs: the private bucket is in place"])
  assert.deepEqual(error, [
    "proofs: the private bucket could not be ensured (Storage answered 400: invalid compact JWS); photos and signatures wait on Storage",
    "proofs: the private bucket could not be ensured (Storage did not answer POST /bucket); photos and signatures wait on Storage",
  ])
})
