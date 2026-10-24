// The two state machines of Finance & Contracting (Issue #112 §2), as pure
// functions over the vocabulary's tokens with their sentences: what a
// Settlement does under `calculate`, `close` and `reopen`, and what an
// Unload's review status does under a decision. The API reads a row under its
// lock, asks here, and either writes the next status — and appends the
// history row or the review row — or answers the sentence as its 409; the
// shape is Execution's `Transition` (execution/transitions.ts), so a reader of
// one machine reads the other.
//
// The settlement machine: `open | calculated → calculated` by `calculate` (a
// recalculation is a move, since the lines change), `calculated → closed` by
// `close`, `closed → open` by `reopen`. `close` on `closed` and `reopen` on
// `open` or `calculated` are `stay`, which the API answers 200 without a
// write; `close` on `open` is a refusal, "Settlement NordRen · July 2026 has
// not been calculated; calculate it first", and `calculate` on `closed` is a
// refusal, "Settlement … is closed; reopen it first" — a closed settlement's
// totals are what the provider was told, and a correction is a reopening with
// its reason in the history. A settlement is named by what the office calls
// it, the provider and the period, which the caller spells.
//
// The period is read on the project's day, which the caller hands in (#260):
// `calculate` is refused while the period has not begun — its first day is
// after today — "Settlement NordRen · July 2026 has not begun; calculate it
// from its first day", since nothing in it has been delivered; and `close`
// is refused until it has ended — its last day is before today — "…has not
// ended; close it after its last day", since a closed settlement prices
// nothing more and the rest of the period would be settled nowhere. The
// status is judged first: an open settlement is calculated before anything
// else is said of its close, a closed one reopened before its calculation,
// and `reopen` reads no day.
//
// The review machine: `captured | approved | rejected → approved | rejected |
// corrected` by the decision named, the same decision again `stay`, and
// anything on `corrected` a refusal, "This unload was corrected by unload
// <id>; review that one" — the correction is a new Unload row, and it is that
// row a person reviews from here on.
import type { Transition } from "../execution/transitions"
import { type SettlementStatus, type WeightReviewDecision, type WeightReviewStatus } from "./vocabulary"

export type { Transition }

/** What moves a settlement: the three commands. */
export const SETTLEMENT_COMMANDS = ["calculate", "close", "reopen"] as const
export type SettlementCommand = (typeof SETTLEMENT_COMMANDS)[number]

/** A close asked of a settlement nobody has calculated. */
export const notCalculated = (label: string): string => `Settlement ${label} has not been calculated; calculate it first`
/** A calculation asked of a closed settlement. */
export const closedSettlement = (label: string): string => `Settlement ${label} is closed; reopen it first`
/** A calculation asked of a settlement whose period has not begun. */
export const periodNotBegun = (label: string): string => `Settlement ${label} has not begun; calculate it from its first day`
/** A close asked of a settlement whose period has not ended. */
export const periodNotEnded = (label: string): string => `Settlement ${label} has not ended; close it after its last day`

/** A settlement as its machine reads it: its status, its name in the sentences, and its period by its first and last day in (the wire's `validTo` is the day after the last). */
export type SettlementState = { status: SettlementStatus; label: string; firstDay: string; lastDay: string }

/** The one place the settlement machine is spelled: status by status, what each command does on the project's `today`. */
export function settlementTransition({ status, label, firstDay, lastDay }: SettlementState, command: SettlementCommand, today: string): Transition<SettlementStatus> {
  // Days as `YYYY-MM-DD` compare as text: begun from its first day, ended once its last day is behind.
  const begun = firstDay <= today
  const ended = lastDay < today
  const calculation: Transition<SettlementStatus> = begun ? { kind: "move", to: "calculated" } : { kind: "refuse", sentence: periodNotBegun(label) }
  switch (status) {
    case "open":
      switch (command) {
        case "calculate":
          return calculation
        case "close":
          return { kind: "refuse", sentence: notCalculated(label) }
        case "reopen":
          return { kind: "stay" }
      }
    case "calculated":
      switch (command) {
        case "calculate":
          // A recalculation moves: the lines change, and the history gets its row.
          return calculation
        case "close":
          return ended ? { kind: "move", to: "closed" } : { kind: "refuse", sentence: periodNotEnded(label) }
        case "reopen":
          return { kind: "stay" }
      }
    case "closed":
      switch (command) {
        case "calculate":
          return { kind: "refuse", sentence: closedSettlement(label) }
        case "close":
          return { kind: "stay" }
        case "reopen":
          return { kind: "move", to: "open" }
      }
  }
}

/** A decision asked of an unload that was corrected: the new row is the one to review. */
export const correctedUnload = (correctionUnloadId: string): string => `This unload was corrected by unload ${correctionUnloadId}; review that one`

/**
 * The review machine: a captured, approved or rejected unload takes the
 * decision named — the same decision again being nothing to do — and a
 * corrected one takes none, naming the row that replaced it. The correction's
 * id is what the sentence names, so the caller hands it in where the status
 * is `corrected`; it is unread otherwise.
 */
export function weightReviewTransition(status: WeightReviewStatus, decision: WeightReviewDecision, correctionUnloadId: string | null): Transition<WeightReviewStatus> {
  if (status === "corrected") return { kind: "refuse", sentence: correctedUnload(correctionUnloadId ?? "unknown") }
  if (status === decision) return { kind: "stay" }
  return { kind: "move", to: decision }
}
