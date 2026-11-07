// A scheme's cadence reconciled against what its containers are promised
// (issue #21, O22 of #290): each container a scheme collects carries a
// promised service frequency, and the scheme's recurrence — at every cadence
// it runs at in a year — under- or over-serves it. The comparison is on one
// scale, collections per week, so an every-N-weeks promise orders against a
// cadence without a counterpart of its own. The API's scheme reconciliation
// reads it over the database's rows, and the web's scheme validation over its
// records; each resolves a container's promise its own way and hands the
// result here.

import { SERVICE_DAY_SHORT_LABELS, SERVICE_DAYS, type ServiceDay } from "../days"
import { occurrencesPerWeek, RECURRENCE_FREQUENCY_LABELS, RECURRENCE_WEEKLY_RATES, sortServiceDays, type RecurrenceFrequency } from "./recurrence"
import { seasonsCoverYear, seasonSpanLabel, type SchemeSeason } from "./seasons"

/** A promise's interval, as `service_frequency` stores it: collections per week, and the weeks or days between them. null collections per week is on demand. */
export type FrequencyInterval = {
  collectionsPerWeek: number | null
  /** Weeks between collections when collectionsPerWeek is 1. */
  weeksBetween: number | null
  /** Days between collections when collectionsPerWeek is above 1. */
  daysBetween: number | null
}

/**
 * An interval's nominal collections per week, the promise side of the
 * reconciliation (issue #21 asks for interval comparison, not a hard-coded
 * cadence ladder). weeks-between divides; days-between promises already
 * state a weekly count; a rate with neither interval is the store's monthly
 * (`service_frequency.collections_per_week`'s comment: 1 with neither
 * interval is monthly), which reads the scheme-cadence rate. null = on
 * demand — no standing cadence to reconcile.
 */
export function intervalCollectionsPerWeek(interval: FrequencyInterval): number | null {
  if (interval.collectionsPerWeek === null) return null
  if (interval.weeksBetween !== null) return interval.collectionsPerWeek / interval.weeksBetween
  if (interval.daysBetween !== null) return interval.collectionsPerWeek
  return interval.collectionsPerWeek === 1 ? RECURRENCE_WEEKLY_RATES.monthly : interval.collectionsPerWeek
}

/** One linked container's promised cadence, on the collections-per-week scale. */
export type SchemeFrequencyPromise = {
  containerName: string
  /** Catalog display name of the promised cadence ("Every week"). */
  promisedName: string
  /** Promised collections per week — the interval-model comparison value. */
  promisedRate: number
  /**
   * The days the scheme collects the container on, when the caller resolved
   * them: a weekly scheme serving it Mon and Thu collects it twice a week. A
   * promise without them is served at the cadence's one-day rate.
   */
  servedDays?: readonly ServiceDay[]
}

export type SchemeFrequencyReconciliationInput = {
  /** The scheme's recurrence cadence. */
  frequency: RecurrenceFrequency
  promises: SchemeFrequencyPromise[]
  /**
   * The scheme's seasons (O17 of #290): every cadence it runs at in a year is
   * judged against the promise, so a winter that breaks one warns in May.
   */
  seasons?: readonly SchemeSeason[]
}

const shortDays = (days: readonly ServiceDay[]): string =>
  sortServiceDays(days)
    .map((day) => SERVICE_DAY_SHORT_LABELS[day])
    .join(", ")

// Rates are quotients of small integers from one shared constant table, so
// genuine equality is exact; the epsilon only absorbs float noise.
const RATE_EPSILON = 1e-9

const namedContainers = (names: readonly string[]): string => {
  const sorted = [...names].sort((a, b) => a.localeCompare(b))
  const shown = sorted.slice(0, 3)
  const more = sorted.length - shown.length
  return more > 0 ? `${shown.join(", ")}, +${more} more` : shown.join(", ")
}

/**
 * The days each container is collected on, from a scheme's resolved per-day
 * plans: what a promise's `servedDays` is read from, by the browser's
 * resolution and the API's alike.
 */
export function servedDaysByContainer(
  plans: ReadonlyArray<{ day: ServiceDay; containerIds: readonly string[] }>,
): Map<string, ServiceDay[]> {
  const days = new Map<string, ServiceDay[]>()
  for (const plan of plans) {
    for (const containerId of plan.containerIds) {
      const served = days.get(containerId)
      if (served === undefined) days.set(containerId, [plan.day])
      else if (!served.includes(plan.day)) served.push(plan.day)
    }
  }
  for (const [containerId, served] of days) days.set(containerId, sortServiceDays(served))
  return days
}

/**
 * The promises of the containers a scheme's plans collect, each with the
 * days it is collected on; `promiseOf` resolves a container's promise (the
 * caller's), so this module stays free of where promises come from.
 */
export function servedFrequencyPromises<C extends { id: string }>(
  plans: ReadonlyArray<{ day: ServiceDay; containerIds: readonly string[] }>,
  containers: readonly C[],
  promiseOf: (container: C) => Omit<SchemeFrequencyPromise, "servedDays"> | null,
): SchemeFrequencyPromise[] {
  const served = servedDaysByContainer(plans)
  return containers.flatMap((container) => {
    const days = served.get(container.id)
    const promise = days === undefined ? null : promiseOf(container)
    return promise === null ? [] : [{ ...promise, servedDays: days }]
  })
}

/**
 * The reconciliation caveats of issue #21, compared on the collections-per-week scale so every-N-weeks
 * promises order without a scheme-cadence counterpart. Under-service — the
 * scheme's cadence falls short of a linked container's promise — is the
 * promise-breaking direction and leads; over-service also warns (decided
 * here: it is visible scheme-vs-agreement drift and usually a configuration
 * or cost error, not a promise kept extra well), phrased as such. A container
 * whose served days are known is collected at the cadence's rate on each of
 * them (`occurrencesPerWeek`), and its days are named where it is collected
 * on more than one. One warning per promised cadence and served days,
 * containers named up to three. A scheme with seasons (O17 of #290) is judged
 * at every cadence it runs at in a year — its own, unless the seasons hold
 * every day, and each season's, named with its days — so a season that breaks
 * a promise warns when it is written, not when it begins. All non-blocking.
 */
export function schemeFrequencyReconciliationWarnings(
  reconciliation: SchemeFrequencyReconciliationInput,
): string[] {
  const seasons = reconciliation.seasons ?? []
  // The scheme's own cadence runs on the days no season holds, if there is one; each season's under its name and span.
  const own = seasonsCoverYear(seasons) ? [] : cadenceWarnings(reconciliation.frequency, reconciliation.promises)
  const seasonal = seasons.flatMap((season) =>
    cadenceWarnings(season.frequency, reconciliation.promises).map((warning) => `${season.name} (${seasonSpanLabel(season)}): ${warning}`),
  )
  return [...own, ...seasonal]
}

/** One cadence's warnings against the promises: under-served first, then over-served. */
function cadenceWarnings(frequency: RecurrenceFrequency, promises: readonly SchemeFrequencyPromise[]): string[] {
  const schemeLabel = RECURRENCE_FREQUENCY_LABELS[frequency]
  const groups = new Map<
    string,
    { promisedName: string; promisedRate: number; servedRate: number; served: string; names: string[] }
  >()
  for (const promise of promises) {
    const days = promise.servedDays
    const known = days !== undefined && days.length > 0
    const servedRate = known ? occurrencesPerWeek(frequency, days) : RECURRENCE_WEEKLY_RATES[frequency]
    // The days are named where the cadence's label alone would mislead: several days, or a daily scheme's part of the week.
    const daily = frequency === "daily"
    const served =
      known && (daily ? days.length < SERVICE_DAYS.length : days.length > 1)
        ? `${schemeLabel} on ${shortDays(days)}`
        : schemeLabel
    const key = `${promise.promisedName}|${served}`
    const group = groups.get(key)
    if (group) group.names.push(promise.containerName)
    else {
      groups.set(key, {
        promisedName: promise.promisedName,
        promisedRate: promise.promisedRate,
        servedRate,
        served,
        names: [promise.containerName],
      })
    }
  }
  // Under-served promises first (most frequent promise first), then
  // over-served — deterministic regardless of caller record order.
  const ordered = Array.from(groups.values()).sort(
    (a, b) =>
      b.promisedRate - a.promisedRate ||
      a.promisedName.localeCompare(b.promisedName) ||
      a.served.localeCompare(b.served),
  )
  const underServed: string[] = []
  const overServed: string[] = []
  for (const group of ordered) {
    const count = group.names.length
    const containers = `${count} container${count === 1 ? "" : "s"} promised ${group.promisedName} (${namedContainers(group.names)})`
    if (group.servedRate < group.promisedRate - RATE_EPSILON) {
      underServed.push(
        `Recurrence ${group.served} under-serves ${containers} — raise the frequency or adjust the promised service frequency`,
      )
    } else if (group.servedRate > group.promisedRate + RATE_EPSILON) {
      overServed.push(
        `Recurrence ${group.served} over-serves ${containers} — collections run more often than the promised service frequency`,
      )
    }
  }
  return [...underServed, ...overServed]
}
