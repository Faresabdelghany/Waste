// The proofs' bucket on the API's boot (O1 of #290): where the deployment
// holds Storage's key, Storage is asked for the private `proofs` bucket as
// migration 0018 makes it, so a database that gained Storage after the
// migration ran — a restore into another project, a stack started without
// storage-api — gets its bucket all the same. Best-effort: a Storage that
// refuses or is silent is told to the error sink, and the boot goes on; the
// proof-object routes answer for themselves.
import type { SupabaseStorage } from "@waste/db/storage"

export type ProofBucketLog = { info: (line: string) => void; error: (line: string) => void }

export async function ensureProofBucket(storage: Pick<SupabaseStorage, "ensureBucket">, log: ProofBucketLog): Promise<void> {
  try {
    log.info(`proofs: the private bucket ${(await storage.ensureBucket()) === "made" ? "was made" : "is in place"}`)
  } catch (error) {
    log.error(`proofs: the private bucket could not be ensured (${error instanceof Error ? error.message : String(error)}); photos and signatures wait on Storage`)
  }
}
