// The Driver App's commands (Issue #145, decided on #125; O1, O2, O8 and O13
// of #290, M23 of #293): the driver door's seventeen kinds, each an
// envelope of `@waste/contracts/driver-commands`, imported as a type only, so
// no zod reaches the browser (CLAUDE.md, contracts). The door parses each
// body against its kind and answers a shape mistake as that command's
// rejection, so nothing here validates: the browser sends and the server
// decides (ADR-0004).
//
// The ids. A command's id is its idempotency key and the id of the row it
// makes, minted at the tap as a UUIDv7 through @waste/domain/ids over the
// browser's clock and `crypto.getRandomValues`, the way apps/api/src/ids.ts
// supplies them for the server. Each id follows the last (`nextId`), and the
// minter starts after the newest id the queue already holds, so the queue's
// key order is the order of the taps even when the phone's clock ran
// backwards across a reload.
import type { DriverCommand } from "@waste/contracts/driver-commands"
import type { ObjectExtension } from "@waste/domain/execution/commands"
import { ID_RANDOM_BYTES, mintId, nextId } from "@waste/domain/ids"

/** The kinds the pilot's Driver App sends. */
export const PILOT_COMMAND_KINDS = [
  "start-route",
  "complete-pickup",
  "skip-pickup",
  "fail-pickup",
  "report-problem",
  "pause",
  "resume",
  "end-route",
  "record-unload",
  "arrive",
  "add-weight",
  "add-note",
  "add-photo",
  "add-signature",
  "record-positions",
  "pre-trip-check",
  "record-fill",
] as const
export type PilotCommandKind = (typeof PILOT_COMMAND_KINDS)[number]

/** One of the seventeen, as the door takes it: `{ id, kind, routeId, occurredAt, deviceId, body }`. */
export type PilotCommand = Extract<DriverCommand, { kind: PilotCommandKind }>

/** The kinds whose command names an object in Storage (O1 of #290): its bytes are put there before the command is sent, under the key the API names. */
export const OBJECT_KINDS = ["add-photo", "add-signature"] as const
export type ObjectKind = (typeof OBJECT_KINDS)[number]

/** A photo's or a signature's bytes as the screen made them: a JPEG photo, a PNG signature. */
export type ProofBytes = { extension: ObjectExtension; contentType: string; bytes: ArrayBuffer }

/** The most commands one batch carries: the contracts' `BATCH_MAX`, spelled again so no zod reaches the browser, and held equal to it by a test. */
export const BATCH_LIMIT = 200

/** Whole kilograms as a form's field holds them, or undefined: `Number`, not `parseInt`, so "1e3" is a thousand rather than one, and "12.5" or "" no weight at all. */
export function wholeKilograms(value: string): number | undefined {
  const parsed = Number(value)
  return value.trim() !== "" && Number.isInteger(parsed) ? parsed : undefined
}

/** The longest note a command carries: the contracts' `PARAGRAPH_MAX`, spelled again and held equal to it, so a form stops a longer one before it is queued and lost to a rejection. */
export const NOTE_MAX = 2000

/** The body a kind takes. */
export type PilotBody<Kind extends PilotCommandKind> = Extract<PilotCommand, { kind: Kind }>["body"]

/** The kinds whose strict bodies take no position: `pause` and `resume` carry nothing at all, a weight, a note and a fill estimate only themselves, and `record-positions` its fixes, each with its own (O8 of #290). */
const WITHOUT_LOCATION: ReadonlySet<PilotCommandKind> = new Set(["pause", "resume", "add-weight", "add-note", "record-fill", "record-positions"])

/** Whether the kind's body takes the tap's position. */
export function takesLocation(kind: PilotCommandKind): boolean {
  return !WITHOUT_LOCATION.has(kind)
}

/** The stop a command names, or null for a route-level one. */
export function pickupIdOf(command: Pick<PilotCommand, "kind" | "body">): string | null {
  const pickupId = (command.body as { pickupId?: unknown }).pickupId
  return typeof pickupId === "string" ? pickupId : null
}

export type CommandIdSource = {
  now?: () => number
  fill?: (bytes: Uint8Array) => Uint8Array
  /** The newest id already queued: every id minted here comes after it. */
  after?: string
}

/** A sequence of command ids over the browser's clock and randomness, or those a test hands in. */
export function createCommandIds({ now = Date.now, fill = (bytes) => crypto.getRandomValues(bytes), after }: CommandIdSource = {}): () => string {
  let previous = after
  return () => {
    const random = fill(new Uint8Array(ID_RANDOM_BYTES))
    const id = previous === undefined ? mintId(now(), random) : nextId(previous, now(), random)
    previous = id
    return id
  }
}
