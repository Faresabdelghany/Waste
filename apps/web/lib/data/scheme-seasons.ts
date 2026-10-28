// A Route Scheme record's Seasons as the scheme page shows and saves them
// (O17 of #290): one season's line, and the record with its set replaced
// whole. What the set means and how it is checked is the domain's
// (@waste/domain/route-schemes/scheme-seasons, seasons).
import { recurrenceCadenceLabel } from "@waste/domain/route-schemes/recurrence"
import { SCHEME_SEASONS_KEY, seasonsValue, type StoredSchemeSeason } from "@waste/domain/route-schemes/scheme-seasons"
import { seasonSpanLabel } from "@waste/domain/route-schemes/seasons"

import type { BusinessRecord } from "./business-modules"

/** "Summer · 1 May – 30 Sep · Every week": one season as the page lists it. */
export function seasonLine(season: StoredSchemeSeason): string {
  return `${season.name} · ${seasonSpanLabel(season)} · ${recurrenceCadenceLabel({ frequency: season.frequency, ...(season.weekRotation === null ? {} : { weekRotation: season.weekRotation }) })}`
}

/** The record with its seasons replaced whole, its Seasons fact beside them. */
export function withSeasons(record: BusinessRecord, given: readonly StoredSchemeSeason[]): BusinessRecord {
  // By the day each starts, as the API answers them.
  const seasons = [...given].sort((a, b) => a.startsOn.localeCompare(b.startsOn))
  const facts = Object.fromEntries(Object.entries(record.facts ?? {}).filter(([key]) => key !== "Seasons"))
  return {
    ...record,
    updated: "Now",
    freshness: "Now",
    facts: seasons.length === 0 ? facts : { ...facts, Seasons: seasons.map((season) => season.name).join(", ") },
    submittedValues: { ...record.submittedValues, [SCHEME_SEASONS_KEY]: seasonsValue(seasons) },
  }
}
