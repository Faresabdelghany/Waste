// The Driver App's commands (Issue #145, decided on #125): nine of the driver
// door's fourteen kinds — `arrive` and the evidence kinds (`add-photo`,
// `add-signature`, `add-weight`, `add-note`) are not in the pilot — each an
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
export const PILOT_COMMAND_KINDS = ["start-route", "complete-pickup", "skip-pickup", "fail-pickup", "report-problem", "pause", "resume", "end-route", "record-unload"] as const
export type PilotCommandKind = (typeof PILOT_COMMAND_KINDS)[number]

/** One of the nine, as the door takes it: `{ id, kind, routeId, occurredAt, deviceId, body }`. */
export type PilotCommand = Extract<DriverCommand, { kind: PilotCommandKind }>

/** The most commands one batch carries: the contracts' `BATCH_MAX`, spelled again so no zod reaches the browser, and held equal to it by a test. */
export const BATCH_LIMIT = 200

/** The body a kind takes. */
export type PilotBody<Kind extends PilotCommandKind> = Extract<PilotCommand, { kind: Kind }>["body"]

/** `pause` and `resume` carry nothing at all — their bodies are strict and empty — so they are the two that go without a position. */
export function takesLocation(kind: PilotCommandKind): boolean {
  return kind !== "pause" && kind !== "resume"
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
