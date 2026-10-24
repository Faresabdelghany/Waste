// The Driver App's commands (Issue #145, decided on #125; O2 of #290): twelve
// of the driver door's fourteen kinds — `add-photo` and `add-signature` wait
// for a store to hold their bytes (O1) — each an
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
import { ID_RANDOM_BYTES, mintId, nextId } from "@waste/domain/ids"

/** The kinds the pilot's Driver App sends. */
export const PILOT_COMMAND_KINDS = ["start-route", "complete-pickup", "skip-pickup", "fail-pickup", "report-problem", "pause", "resume", "end-route", "record-unload", "arrive", "add-weight", "add-note"] as const
export type PilotCommandKind = (typeof PILOT_COMMAND_KINDS)[number]

/** One of the twelve, as the door takes it: `{ id, kind, routeId, occurredAt, deviceId, body }`. */
export type PilotCommand = Extract<DriverCommand, { kind: PilotCommandKind }>

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

/** The kinds whose strict bodies take no position: `pause` and `resume` carry nothing at all, a weight and a note only themselves. */
const WITHOUT_LOCATION: ReadonlySet<PilotCommandKind> = new Set(["pause", "resume", "add-weight", "add-note"])

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
