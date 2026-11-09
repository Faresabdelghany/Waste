// A record's own fields as every reader of it reads them — its kind by its id
// and its form's record kind, its typed values, a wire token as its status
// reads — and the refusal a write is answered with before the API sees it.
// The adapters (lib/api/records) and the record rules (lib/data) both read
// them here, so neither reaches into the other for them.
import { capitalised } from "@/lib/format/words"
import type { BusinessRecord } from "@/lib/prototype/prototype-record"

/** A write the adapter refused before the API saw it, in the API's own words: a 400 with the field it names. */
export type LocalRefusal = { path: string; message: string }

export const isLocalRefusal = (value: unknown): value is LocalRefusal =>
  typeof value === "object" && value !== null && typeof (value as LocalRefusal).path === "string" && typeof (value as LocalRefusal).message === "string"

/** `<prefix>-<uuid>`: a resource's web id. */
export const webIdOf = (prefix: string, serverId: string) => `${prefix}-${serverId.toLowerCase()}`

/** True for a record whose id carries the prefix — a browser-minted one or a `webIdOf`. */
export const hasPrefix = (prefix: string) => (record: Pick<BusinessRecord, "id">) => record.id.startsWith(`${prefix}-`)

/**
 * The rule every adapter's `owns` follows: a record is of a kind when its id
 * carries the kind's prefix — a `webIdOf` — or, for a record
 * the workspace has just made (whose id is `<moduleId>-<slug of the form's
 * recordKind>-<clock>`, `organization-project-1700000000000`), when its
 * `recordKind` is the kind's. A form's `recordKind` is the one word the
 * generic create path stamps on every record it makes, so it is what a new
 * row is recognised by until the server has answered and the adapter's own
 * id has replaced the minted one.
 */
export const ofKind = (prefix: string, recordKinds: readonly string[]) => (record: Pick<BusinessRecord, "id" | "recordKind">) =>
  hasPrefix(prefix)(record) || (record.recordKind !== undefined && recordKinds.includes(record.recordKind))

/** `active` → `Active`, `service-contact` → `Service contact`: a wire token as a status or a fact reads. */
export function statusLabel(token: string): string {
  return capitalised(token.replace(/[-_]+/g, " "))
}

/** The inverse: `Active` → `active`, `Service contact` → `service-contact`. */
export function statusToken(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, "-")
}

/** A typed form value read as a non-blank string, or undefined. */
export function typed(record: Pick<BusinessRecord, "submittedValues">, key: string): string | undefined {
  const value = record.submittedValues?.[key]
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

/** A typed form value read as a boolean, or undefined when it is not one. */
export function typedFlag(record: Pick<BusinessRecord, "submittedValues">, key: string): boolean | undefined {
  const value = record.submittedValues?.[key]
  return typeof value === "boolean" ? value : undefined
}
