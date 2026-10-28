// A Route Scheme record's Seasons (O17 of #290): how the web's record carries
// them and what the scheme page's editor checks before it saves. The record
// keeps the set as JSON under `SCHEME_SEASONS_KEY`, each season as the wire
// spells it (the rotation null for every cadence but every-2-weeks); the
// adapter writes that JSON from the API's resource and sends it back whole,
// and `recurrenceFromValues` reads it, so the fixture preview and the API's
// occurrence read run a season alike. The date math is seasons.ts's.

import { SEASON_FREQUENCIES, WEEK_ROTATIONS, type SeasonFrequency, type WeekRotation } from "../planning/vocabulary"
import { isMonthDay, overlappingSeasons, SEASONS_MAX, type SchemeSeason } from "./seasons"

/** The record's key the seasons ride under, as JSON. */
export const SCHEME_SEASONS_KEY = "seasons"

/** A season as the record and the wire spell it: the rotation null where the cadence takes none. */
export type StoredSchemeSeason = {
  name: string
  startsOn: string
  endsOn: string
  frequency: SeasonFrequency
  weekRotation: WeekRotation | null
}

const isSeasonFrequency = (value: unknown): value is SeasonFrequency => typeof value === "string" && (SEASON_FREQUENCIES as readonly string[]).includes(value)
const isRotation = (value: unknown): value is WeekRotation => typeof value === "string" && (WEEK_ROTATIONS as readonly string[]).includes(value)

/** One stored season, or null where an entry of hand-edited JSON is not one. */
function storedSeasonOf(value: unknown): StoredSchemeSeason | null {
  if (typeof value !== "object" || value === null) return null
  const { name, startsOn, endsOn, frequency, weekRotation } = value as Record<string, unknown>
  if (typeof name !== "string" || typeof startsOn !== "string" || typeof endsOn !== "string") return null
  if (!isMonthDay(startsOn) || !isMonthDay(endsOn) || startsOn === endsOn || !isSeasonFrequency(frequency)) return null
  const rotation = isRotation(weekRotation) ? weekRotation : null
  if ((frequency === "every-2-weeks") !== (rotation !== null)) return null
  return { name, startsOn, endsOn, frequency, weekRotation: rotation }
}

/** The record's seasons as stored, entries that are not seasons left out; none where the key is absent or not JSON. */
export function storedSeasonsFromValues(values: Record<string, unknown> | null | undefined): StoredSchemeSeason[] {
  const raw = values?.[SCHEME_SEASONS_KEY]
  if (typeof raw !== "string" || raw.trim() === "") return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.flatMap((entry) => storedSeasonOf(entry) ?? []) : []
  } catch {
    return []
  }
}

/** The domain's seasons from the stored ones, the null rotation left out. */
export const schemeSeasonsOf = (stored: readonly StoredSchemeSeason[]): SchemeSeason[] =>
  stored.map(({ weekRotation, ...season }) => ({ ...season, ...(weekRotation === null ? {} : { weekRotation }) }))

/** The record's seasons for the date math; none where it has none, or they are not ones the date math may read together. */
export function seasonsFromValues(values: Record<string, unknown> | null | undefined): SchemeSeason[] {
  const stored = storedSeasonsFromValues(values)
  return seasonProblems(stored).length === 0 ? schemeSeasonsOf(stored) : []
}

/** The JSON a record carries for a set of seasons, by the day each starts. */
export const seasonsValue = (seasons: readonly StoredSchemeSeason[]): string =>
  JSON.stringify([...seasons].sort((a, b) => a.startsOn.localeCompare(b.startsOn)))

/**
 * Every sentence a set of seasons fails, in the contracts' words where they
 * have one, so the editor refuses what the API would before it is sent.
 */
export function seasonProblems(seasons: readonly StoredSchemeSeason[]): string[] {
  const problems: string[] = []
  if (seasons.length > SEASONS_MAX) problems.push(`A scheme has at most ${SEASONS_MAX} seasons`)
  for (const season of seasons) {
    const label = season.name.trim() === "" ? "A season" : season.name
    if (season.name.trim() === "") problems.push("Every season needs a name")
    if (!isMonthDay(season.startsOn) || !isMonthDay(season.endsOn)) problems.push(`${label}: a day of the year that every year has (29 February is not one)`)
    else if (season.startsOn === season.endsOn) problems.push(`${label}: a season ends on another day than it starts; a season of the whole year is the scheme's own cadence`)
    if ((season.frequency === "every-2-weeks") !== (season.weekRotation !== null)) problems.push(`${label}: pick the week rotation for every 2 weeks`)
  }
  const names = seasons.map((season) => season.name.trim())
  if (new Set(names).size !== names.length) problems.push("A season name is used once in a scheme")
  const valid = seasons.filter((season) => isMonthDay(season.startsOn) && isMonthDay(season.endsOn))
  const pair = overlappingSeasons(valid)
  if (pair !== undefined) problems.push(`Seasons share no day: ${valid[pair[1]].name} overlaps ${valid[pair[0]].name}`)
  return problems
}
