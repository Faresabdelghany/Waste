// A device's commands as they travel (Issue #104, ADR-0004): the Driver App
// drains its queue in batches, one `POST /driver/commands` each, every
// command's id once, since an id is the command's idempotency key and a second
// with the same id is its replay. The door answers each command with the
// outcome its receipt stores — applied, or rejected with its problem — or
// `replayed` for an id already received, the wire's word, never stored.
import { eachOnceSentence } from "../requests"
import { COMMAND_OUTCOMES, type DriverCommandKind } from "./vocabulary"

/** The most commands a batch carries; two hundred is a long day. */
export const BATCH_MAX = 200

/** What a batch naming a command's id twice is told. */
export const EACH_COMMAND_ONCE = eachOnceSentence("command", "one id is one command, and a second with the same id is its replay")

/** What the door answers per command: the stored outcomes, and `replayed` for an id already received. */
export const WIRE_OUTCOMES = [...COMMAND_OUTCOMES, "replayed"] as const
export type WireOutcome = (typeof WIRE_OUTCOMES)[number]

/** What a receipt with a problem and an applied outcome, or none and a rejected one, is told. */
export const PROBLEM_WITH_A_REJECTION = "A rejected command carries its problem, and an applied one none"

/**
 * The commands that say nothing of where the device stood: the ones a driver
 * gives away from a stop (a pause, a weight, a note), and the ones whose body
 * is a reading of its own (the fixes, a fill, a tank's volume). Every other
 * command carries the device's position and its accuracy, where the phone
 * knew them.
 */
export const UNLOCATED_COMMAND_KINDS = ["pause", "resume", "add-weight", "add-note", "record-fill", "record-positions", "record-volume"] as const satisfies readonly DriverCommandKind[]

export const carriesLocation = (kind: DriverCommandKind): boolean => !(UNLOCATED_COMMAND_KINDS as readonly DriverCommandKind[]).includes(kind)
