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

/** The one place the settlement machine is spelled: status by status, what each command does. */
export function settlementTransition(status: SettlementStatus, command: SettlementCommand, label: string): Transition<SettlementStatus> {
  switch (status) {
    case "open":
      switch (command) {
        case "calculate":
          return { kind: "move", to: "calculated" }
        case "close":
          return { kind: "refuse", sentence: notCalculated(label) }
        case "reopen":
          return { kind: "stay" }
      }
    case "calculated":
      switch (command) {
        case "calculate":
          // A recalculation moves: the lines change, and the history gets its row.
          return { kind: "move", to: "calculated" }
        case "close":
          return { kind: "move", to: "closed" }
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
