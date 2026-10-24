// The proofs' bucket (O1 of #290): the private Storage bucket a driver's
// photos and signatures live in, made by the migration that owns it, the one
// spelling `proof-storage-rendering.test.ts` holds the file to. Private: no
// object is read without a URL the API signs, and the API alone holds the key
// that signs (`@waste/db/storage`). The size and the formats are the bucket's
// own refusal of anything else, whatever an upload URL says.
//
// Guarded twice. A database with no Storage — `pnpm db:start`'s database
// alone, a test's fresh database — has no `storage.buckets`, and the
// statement does nothing there; a Storage older than the two limit columns
// gets the private bucket without them. The owner runs it, as every file:
// locally the superuser, on the Pilot `postgres`, which Supabase grants the
// `storage` tables to.
import { PROOF_BUCKET } from "@waste/contracts/proof-objects"

/** The largest object the bucket takes: a phone's photo as the Driver App sends it, about 1600 px of JPEG, with room to spare; a signature is a few kilobytes. */
export const PROOF_OBJECT_MAX_BYTES = 2 * 1024 * 1024

/** The formats the bucket takes: the four extensions of an object key (`OBJECT_EXTENSIONS`), jpg and jpeg being one. */
export const PROOF_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const

/** The one statement: the private bucket, made or kept private, its limits where Storage has the columns. */
export function proofBucketStatement(): string {
  const types = PROOF_MIME_TYPES.map((type) => `'${type}'`).join(", ")
  return `DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO storage.buckets (id, name, public) VALUES ('${PROOF_BUCKET}', '${PROOF_BUCKET}', false)
    ON CONFLICT (id) DO UPDATE SET public = false;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name IN ('file_size_limit', 'allowed_mime_types')) = 2 THEN
    UPDATE storage.buckets SET file_size_limit = ${PROOF_OBJECT_MAX_BYTES}, allowed_mime_types = ARRAY[${types}] WHERE id = '${PROOF_BUCKET}';
  END IF;
END
$$;`
}
