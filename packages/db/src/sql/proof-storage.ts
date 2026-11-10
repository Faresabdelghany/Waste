// The proofs' bucket (O1 of #290): the private Storage bucket a driver's
// photos and signatures live in, made by migration 0018 and held private with
// its limits by the API's boot (`ensureBucket`, `@waste/db/storage`). Private:
// no object is read without a URL the API signs, and the API alone holds the
// key that signs. The size and the formats are the bucket's own refusal of
// anything else, whatever an upload URL says; `proof-storage.test.ts` holds
// the formats to the ones an object key may name.

/** The formats the bucket takes: the image extensions an object key takes (`IMAGE_EXTENSIONS`), jpg and jpeg being one. */
export const PROOF_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const
