// A stop's fill estimate (M23 of #293) in a person's words: how full the
// driver judged the container when they emptied it, a quarter at a time and
// past full. The Driver App offers the six, and a stop's details on the
// office's side say the one the driver last gave.
import { FILL_LEVELS, type FillLevel } from "@waste/domain/execution/vocabulary"

/** Each level as a button and a fact read it. */
export const FILL_LABELS: Readonly<Record<FillLevel, string>> = {
  empty: "Empty",
  quarter: "A quarter full",
  half: "Half full",
  "three-quarters": "Three quarters full",
  full: "Full",
  overflowing: "Overflowing",
}

/** The levels in the order the Driver App offers them, emptiest first. */
export const FILL_OPTIONS: readonly { value: FillLevel; label: string }[] = FILL_LEVELS.map((value) => ({ value, label: FILL_LABELS[value] }))
