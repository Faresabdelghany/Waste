// How a Route Scheme record carries its recurrence and its seasons in its
// submitted form values (the `route-studio.schemes` field ids): the service
// days as a comma list, the cadence's fields one by one, and the seasons as
// JSON under `SCHEME_SEASONS_KEY`, each as the wire spells it. The adapter
// writes that JSON from the API's resource and sends it back whole, and
// `recurrenceFromValues` reads it, so the fixture preview and the API's
// occurrence read run a season alike. The rules are Planning's
// (@waste/domain/planning/recurrence, seasons, scheme-seasons).

import { isIsoDate, SERVICE_DAYS, type ServiceDay } from "@waste/domain/days"
import { isRecurrenceFrequency, sortServiceDays, type SchemeRecurrence } from "@waste/domain/planning/recurrence"
import { schemeSeasonsOf, seasonProblems, type StoredSchemeSeason } from "@waste/domain/planning/scheme-seasons"
import { isMonthDay, type SchemeSeason } from "@waste/domain/planning/seasons"
import { SEASON_FREQUENCIES, WEEK_ROTATIONS, type SeasonFrequency, type WeekRotation } from "@waste/domain/planning/vocabulary"

export function parseServiceDays(value: string): ServiceDay[] {
  const tokens = value
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token): token is ServiceDay => (SERVICE_DAYS as readonly string[]).includes(token))
  return sortServiceDays([...new Set(tokens)])
}

/**
 * The shared guard for reading a record's structured `serviceDays` out of its
 * submitted form values: the values object may be missing entirely, and the
 * field may hold a non-string in merged or hand-edited stores. Returns []
 * when nothing parses. The project's weekend (`values.weekend`) is another
 * field, with its own read.
 */
export function serviceDaysFromValues(
  values: Record<string, unknown> | null | undefined,
): ServiceDay[] {
  const raw = values?.serviceDays
  return parseServiceDays(typeof raw === "string" ? raw : "")
}

const isRotation = (value: unknown): value is WeekRotation =>
  value === "odd" || value === "even"

/**
 * Reads a scheme's recurrence from its submitted form values (the
 * `route-studio.schemes` field ids, also kept on created records as
 * `submittedValues`). Returns null while the recurrence is still incomplete:
 * no frequency, no service day, no effective-from, or an every-2-weeks
 * frequency without a week rotation. The seasons ride along where the record
 * carries a set the date math may read (below).
 */
export function recurrenceFromValues(
  values: Record<string, string | boolean | undefined>,
): SchemeRecurrence | null {
  const frequency = values.frequency
  if (!isRecurrenceFrequency(frequency)) return null
  // Daily always serves the full week; a partial stored list cannot narrow it.
  const serviceDays = frequency === "daily" ? [...SERVICE_DAYS] : serviceDaysFromValues(values)
  if (serviceDays.length === 0) return null
  const effectiveFrom = typeof values.effectiveFrom === "string" ? values.effectiveFrom : ""
  // Malformed dates (possible in hand-edited or corrupted submittedValues)
  // must not reach the date walk — an invalid cursor would throw mid-render.
  if (!isIsoDate(effectiveFrom)) return null
  const effectiveTo = typeof values.effectiveTo === "string" ? values.effectiveTo : ""
  if (effectiveTo && !isIsoDate(effectiveTo)) return null
  const weekRotation = isRotation(values.weekRotation) ? values.weekRotation : undefined
  if (frequency === "every-2-weeks" && !weekRotation) return null
  // A daily scheme has no seasons (O17 of #290); any other carries the record's, where it has some.
  const seasons = frequency === "daily" ? [] : seasonsFromValues(values)
  return {
    frequency,
    serviceDays,
    ...(frequency === "every-2-weeks" ? { weekRotation } : {}),
    effectiveFrom,
    effectiveTo,
    ...(typeof values.plannedStartTime === "string" && values.plannedStartTime
      ? { startTime: values.plannedStartTime }
      : {}),
    ...(seasons.length === 0 ? {} : { seasons }),
  }
}

/** The record's key the seasons ride under, as JSON. */
export const SCHEME_SEASONS_KEY = "seasons"

const isSeasonFrequency = (value: unknown): value is SeasonFrequency => typeof value === "string" && (SEASON_FREQUENCIES as readonly string[]).includes(value)
const isSeasonRotation = (value: unknown): value is WeekRotation => typeof value === "string" && (WEEK_ROTATIONS as readonly string[]).includes(value)

/** One stored season, or null where an entry of hand-edited JSON is not one. */
function storedSeasonOf(value: unknown): StoredSchemeSeason | null {
  if (typeof value !== "object" || value === null) return null
  const { name, startsOn, endsOn, frequency, weekRotation } = value as Record<string, unknown>
  if (typeof name !== "string" || typeof startsOn !== "string" || typeof endsOn !== "string") return null
  if (!isMonthDay(startsOn) || !isMonthDay(endsOn) || startsOn === endsOn || !isSeasonFrequency(frequency)) return null
  const rotation = isSeasonRotation(weekRotation) ? weekRotation : null
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

/** The record's seasons for the date math; none where it has none, or they are not ones the date math may read together. */
export function seasonsFromValues(values: Record<string, unknown> | null | undefined): SchemeSeason[] {
  const stored = storedSeasonsFromValues(values)
  return seasonProblems(stored).length === 0 ? schemeSeasonsOf(stored) : []
}

/** The JSON a record carries for a set of seasons, by the day each starts. */
export const seasonsValue = (seasons: readonly StoredSchemeSeason[]): string =>
  JSON.stringify([...seasons].sort((a, b) => a.startsOn.localeCompare(b.startsOn)))
