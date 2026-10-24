// Proof objects (O1 of #290): the bytes of a driver's photo or signature,
// which live in the private `proofs` Storage bucket under the key the
// command names (`<companyId>/<routeId>/<commandId>.<ext>`, `ObjectKey`).
// The API holds Storage's service-role key and signs, and no byte passes
// through it: a device asks `POST /driver/uploads` for the upload URL of one
// of its own commands' objects, behind the driver door's assignment fence,
// and puts the bytes straight to Storage before it sends the command; the
// office asks `GET /pickups/:id/proof-objects` for read URLs of a stop's
// objects, behind its project fence. A URL lapses; a key does not.
import * as z from "zod"

import { IsoDateTime } from "./dates"
import { OBJECT_EXTENSIONS, ObjectKey } from "./execution"
import { Id } from "./ids"

/** The one private bucket proofs' bytes live in. */
export const PROOF_BUCKET = "proofs"

/** The largest object the bucket takes, its own refusal of anything larger: a phone's photo as the Driver App sends it, about 1600 px of JPEG, with room to spare; a signature is a few kilobytes. */
export const PROOF_OBJECT_MAX_BYTES = 2 * 1024 * 1024

/** `POST /driver/uploads`: the object of a command of the device's own, on a route assigned to the driver, in one of the bucket's formats. The API names the key. */
export const ProofUploadRequest = z.strictObject({
  routeId: Id,
  commandId: Id,
  extension: z.enum(OBJECT_EXTENSIONS),
})
export type ProofUploadRequest = z.infer<typeof ProofUploadRequest>

/** What the device does next: put the bytes to `uploadUrl` until `expiresAt`, or nothing, Storage holding the object already (a retry after an upload whose answer was lost). */
export const ProofUpload = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("upload"), objectKey: ObjectKey, uploadUrl: z.url(), expiresAt: IsoDateTime }),
  z.strictObject({ state: z.literal("uploaded"), objectKey: ObjectKey }),
])
export type ProofUpload = z.infer<typeof ProofUpload>

/** A read URL for one of a stop's proofs that names an object, until `expiresAt`; null where Storage holds none — never uploaded, or purged after its days. */
export const ProofObjectLink = z.strictObject({
  proofId: Id,
  objectKey: ObjectKey,
  url: z.url().nullable(),
  expiresAt: IsoDateTime,
})
export type ProofObjectLink = z.infer<typeof ProofObjectLink>

/** `GET /pickups/:id/proof-objects`: the stop's proofs that name an object, in recording order. */
export const ProofObjectLinks = z.strictObject({ items: z.array(ProofObjectLink) })
export type ProofObjectLinks = z.infer<typeof ProofObjectLinks>
