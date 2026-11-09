// The Storage objects the system keeps: a driver's photo or signature and an
// inspection's photo in the private `proofs` bucket (O1 of #290), and a
// ticket's attachment in its own (#109 §7.23). Each lives under a key of its
// own layout, agreed before the upload and held by the API to the row's own
// ids, so a device cannot name another tenant's object (#104 §3); the formats
// are each kind's, and are what keep a key of the one from reading as a key of
// another. The proofs bucket's name and size limit are the migration's that
// makes it, and the wire's that names them.

/** The private bucket proofs and inspection photos live in. */
export const PROOF_BUCKET = "proofs"

/** The largest object the bucket takes, its own refusal of anything larger: a phone's photo as the Driver App sends it, about 1600 px of JPEG, with room to spare; a signature is a few kilobytes. */
export const PROOF_OBJECT_MAX_BYTES = 2 * 1024 * 1024

/** The longest key a client may hand back: three ids, a prefix and a format, with room to spare. */
export const OBJECT_KEY_MAX = 256

/** The image formats an object may be, as its key's extension: a proof's, an inspection's photo. */
export const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp"] as const
export type ImageExtension = (typeof IMAGE_EXTENSIONS)[number]

/** The formats a ticket's attachment may be: the images, and a document. */
export const ATTACHMENT_EXTENSIONS = [...IMAGE_EXTENSIONS, "pdf"] as const
export type AttachmentExtension = (typeof ATTACHMENT_EXTENSIONS)[number]

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

const threeIdsAndFormat = (extensions: readonly string[]): string => `^${UUID}/${UUID}/${UUID}\\.(${extensions.join("|")})$`

/** A proof's object key: `<companyId>/<routeId>/<commandId>.<ext>`, one of the image formats. */
export const PROOF_KEY_PATTERN = threeIdsAndFormat(IMAGE_EXTENSIONS)
export const PROOF_KEY_SHAPE = "An object key is <companyId>/<routeId>/<commandId>.<jpg|jpeg|png|webp>"

/** The key a command's object is agreed to live under. */
export const objectKeyOf = (ids: { companyId: string; routeId: string; commandId: string }, extension: ImageExtension): string => `${ids.companyId}/${ids.routeId}/${ids.commandId}.${extension}`

/** Whether the key is one of this command's: its company, its route, its id, one of the formats. */
export function objectKeyNames(key: string, ids: { companyId: string; routeId: string; commandId: string }): boolean {
  const prefix = `${ids.companyId}/${ids.routeId}/${ids.commandId}.`
  return key.startsWith(prefix) && (IMAGE_EXTENSIONS as readonly string[]).includes(key.slice(prefix.length))
}

/** A ticket's attachment key: `<companyId>/<ticketId>/<objectId>.<ext>` — a proof's path over the attachment formats. */
export const ATTACHMENT_KEY_PATTERN = threeIdsAndFormat(ATTACHMENT_EXTENSIONS)
export const ATTACHMENT_KEY_SHAPE = "An attachment key is <companyId>/<ticketId>/<objectId>.<jpg|jpeg|png|webp|pdf>"

export type InspectionPhotoIds = { companyId: string; inspectionId: string; photoId: string }

/** Where an inspection photo's bytes live: under the inspections' own prefix, `inspections/<companyId>/<inspectionId>/<photoId>.<ext>`. */
export const inspectionPhotoKeyOf = ({ companyId, inspectionId, photoId }: InspectionPhotoIds, extension: ImageExtension): string => `inspections/${companyId}/${inspectionId}/${photoId}.${extension}`

/** Whether a key is a photo of this inspection: its company, its id, and a photo id and format of the bucket's. */
export function inspectionPhotoKeyNames(key: string, ids: { companyId: string; inspectionId: string }): boolean {
  const prefix = `inspections/${ids.companyId}/${ids.inspectionId}/`
  if (!key.startsWith(prefix)) return false
  const rest = key.slice(prefix.length)
  const dot = rest.lastIndexOf(".")
  if (dot <= 0) return false
  const [photoId, extension] = [rest.slice(0, dot), rest.slice(dot + 1)]
  return new RegExp(`^${UUID}$`).test(photoId) && (IMAGE_EXTENSIONS as readonly string[]).includes(extension)
}

/** The photo id a key of this shape names. */
export const photoIdOf = (key: string): string => key.slice(key.lastIndexOf("/") + 1, key.lastIndexOf("."))

/**
 * The deployment holds no Storage key, so photos and signatures have nowhere
 * to go (O1 of #290): the proof-object routes' refusal (RFC 9457's `type` and
 * title), a lasting state of the deployment rather than a server out of
 * reach, which a device tells apart by this type and answers as the action's
 * refusal instead of waiting on it.
 */
export const NO_PROOF_STORAGE = { type: "urn:waste:problem:no-proof-storage", title: "No proof storage" } as const
