// What a Service Area — a provider's award — holds to at the boundary: its
// code as a contract spells it, its sets each once and bounded, and a
// provider's areas read on a day, since a provider holds an area through an
// assignment valid on one.
import { eachOnceSentence } from "../requests"

/** The longest an area's code may be: what a contract spells, `CA-Ø-2`, not a slug and not a sentence. */
export const SERVICE_AREA_CODE_MAX = 40

/** What a longer code is told. */
export const SERVICE_AREA_CODE_TOO_LONG = `A service area's code is at most ${SERVICE_AREA_CODE_MAX} characters`

/** What a set naming a planning area twice is told. */
export const EACH_PLANNING_AREA_ONCE = eachOnceSentence("planning area")

/** What a list asked for a provider's areas without a day is told. */
export const PROVIDER_NEEDS_A_DAY = "Give validOn with serviceProviderId: a provider holds an area through an assignment valid on a day"

/** What an indexation over a provider's prices naming both a provider and an award, or neither, is told. */
export const PROVIDER_OR_AWARD = "Name either a provider or an award"
