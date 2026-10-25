// Why a station refused a load (O9 of #290), as the office's weights desk and
// the Driver App both say it: the domain's reasons in a person's words, and
// the contract's sentence for a refusal for another reason without its words,
// spelled again here since the web imports the contracts as types only and
// held equal by lib/api/__tests__/weights.test.ts.
import type { UnloadRefusalReason } from "@waste/domain/execution/vocabulary"

/** Why a station refused a load, as a person reads it. */
export const REFUSAL_LABELS: Readonly<Record<UnloadRefusalReason, string>> = {
  contamination: "Contamination",
  "fraction-not-accepted": "Fraction not accepted",
  hazardous: "Hazardous waste",
  overweight: "Overweight",
  other: "Other",
}

/** What a refusal for another reason is told without its words (`SAY_WHY_REFUSED`, @waste/contracts/unloads). */
export const SAY_WHY_REFUSED = "Say why the station refused the load"
