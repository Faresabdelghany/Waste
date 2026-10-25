// The spellings the weighbridge (O9 of #290) gave `project` and `unload`,
// which weighbridge-rendering, execution-rendering and
// organisation-access-rendering all read: the project's tolerance and its
// range, the unload's refusal and its shape.
import { ref } from "./rendering"

/** The tolerance's range, as drizzle-kit spells the check. */
export const TOLERANCE_RANGE = `${ref("project", "weight_tolerance_percent")} between 1 and 100`

/** A refusal's note goes with its reason, and `other` says it in words. */
export const REFUSAL_SHAPE = `(${ref("unload", "refusal_note")} is null or ${ref("unload", "refusal_reason")} is not null) and (${ref("unload", "refusal_reason")} is distinct from 'other' or ${ref("unload", "refusal_note")} is not null)`

/** The refusal's reasons, as the one-of check spells them. */
export const REFUSAL_REASONS = ["contamination", "fraction-not-accepted", "hazardous", "overweight", "other"] as const
