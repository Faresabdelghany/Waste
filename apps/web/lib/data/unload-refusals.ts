// Why a station refused a load (O9 of #290), as the office's weights desk and
// the Driver App both say it: the domain's reasons in a person's words.
import type { UnloadRefusalReason } from "@waste/domain/execution/vocabulary"

export const REFUSAL_LABELS: Readonly<Record<UnloadRefusalReason, string>> = {
  contamination: "Contamination",
  "fraction-not-accepted": "Fraction not accepted",
  hazardous: "Hazardous waste",
  overweight: "Overweight",
  other: "Other",
}
