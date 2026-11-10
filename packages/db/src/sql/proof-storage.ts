// The proofs' bucket (O1 of #290): the private Storage bucket a driver's
// photos and signatures live in, made by migration 0018 and held private with
// its limits by the API's boot (`ensureBucket`, `@waste/db/storage`). Private:
// no object is read without a URL the API signs, and the API alone holds the
// key that signs. The size and the formats are the bucket's own refusal of
// anything else, whatever an upload URL says; `proof-storage.test.ts` holds
// the formats to the ones an object key may name.
//
// The bucket statement is 0018's own text. That file's comment names this
// module as "the one spelling this file is copied from" and a
// proof-storage-rendering test that held it: both went once 0018 merged
// (migrations/README.md: a merged file is its hash's). What holds the bucket
// now is `ensureBucket` at the API's boot and its test (storage.test.ts).

/** The formats the bucket takes: the image extensions an object key takes (`IMAGE_EXTENSIONS`), jpg and jpeg being one. */
export const PROOF_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const
