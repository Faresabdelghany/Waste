// A Route Scheme's Seasons (O17 of #290) as the wire spells them — the
// rotation null for every cadence but every-2-weeks — read into the date
// math's seasons, and what the scheme page's editor checks before it saves,
// in the contracts' words. The date math is seasons.ts's.

import type { SeasonFrequency, WeekRotation } from "./vocabulary"
import { isMonthDay, overlappingSeasons, SEASONS_MAX, type SchemeSeason } from "./seasons"

/** A season as the record and the wire spell it: the rotation null where the cadence takes none. */
export type StoredSchemeSeason = {
  name: string
  startsOn: string
  endsOn: string
  frequency: SeasonFrequency
  weekRotation: WeekRotation | null
}

/** The domain's seasons from the stored ones, the null rotation left out. */
export const schemeSeasonsOf = (stored: readonly StoredSchemeSeason[]): SchemeSeason[] =>
  stored.map(({ weekRotation, ...season }) => ({ ...season, ...(weekRotation === null ? {} : { weekRotation }) }))

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
