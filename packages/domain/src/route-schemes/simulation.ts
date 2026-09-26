// "Simulate next N occurrences" (Issue #40): the guided setup's step 2 runs
// the occurrence generator twice — over the draft as it stands and over the
// draft with a candidate change — across the span of the draft's next N
// collections, and answers the delta row by row. Both sides go through
// generateOccurrences (occurrences.ts), the one implementation the next-dates
// preview and route generation share, so a simulated row is a row the preview
// would show and generation would write; nothing here re-derives a date.
// Pure date math — no UI, store, or fixture dependencies.

import {
  generateOccurrences,
  occurrencePreview,
  type Occurrence,
  type OccurrencePreview,
  type OccurrencePreviewInput,
  type OccurrenceWindow,
} from "./occurrences"
import { isIsoDate } from "./recurrence"

/** The horizons the simulation offers, in collections. */
export const SIMULATION_COUNTS = [5, 10, 20, 50] as const
export const DEFAULT_SIMULATION_COUNT = 10

/**
 * What a recurrence date became under the candidate: the collection is on the
 * same operating date (unchanged), only the candidate makes it (added), only
 * the current draft makes it (removed), or both make it on different dates
 * (moved — a holiday policy that shifts the other way, or a list change).
 */
export type OccurrenceChange = "unchanged" | "added" | "removed" | "moved"

export type SimulatedOccurrence = {
  /** The recurrence date both sides are matched on — the route's identity. */
  plannedDate: string
  /** The row the draft as it stands yields on that date; null when it has none. */
  current: Occurrence | null
  /** The row the candidate yields on that date; null when it has none. */
  candidate: Occurrence | null
  change: OccurrenceChange
}

export type OccurrenceSimulation = {
  /** Every recurrence date either side yields inside the window, in date order. */
  rows: SimulatedOccurrence[]
  /**
   * The span compared: from the earlier effective-from — or from `from`
   * (today) when the scheme already runs — to the current draft's Nth
   * collection from there (the candidate's when the draft has none, the
   * preview horizon when neither reaches N); null when neither side yields
   * a date.
   */
  window: OccurrenceWindow | null
  /** Collections (skipped rows excluded) the draft as it stands makes inside the window. */
  before: number
  /** Collections the candidate makes inside the window. */
  after: number
  added: number
  removed: number
  moved: number
}

export type SimulateOccurrencesInput = {
  /** The draft as it stands; null while it has no recurrence (no service days or start date). */
  current: OccurrencePreviewInput | null
  /** The draft with the candidate change; null when the change leaves it without a recurrence. */
  candidate: OccurrencePreviewInput | null
  /** How many collections of the current draft the comparison spans. */
  count: number
  /**
   * The first date the comparison may cover — today, so a scheme that
   * started in the past simulates its *next* N collections, not its first N.
   * The window never starts before either side's effective-from; omitted or
   * not an ISO date, the window starts at the earlier effective-from.
   */
  from?: string
}

const EMPTY_SIMULATION: OccurrenceSimulation = {
  rows: [],
  window: null,
  before: 0,
  after: 0,
  added: 0,
  removed: 0,
  moved: 0,
}

const collects = (row: Occurrence | null): row is Occurrence =>
  row !== null && row.status !== "skipped"

const later = (a: string, b: string) => (a > b ? a : b)
const earlier = (a: string, b: string) => (a < b ? a : b)

/**
 * One side's preview from the window's start — its rows over the effective
 * window, or PREVIEW_HORIZON_MONTHS from there when open-ended — walked once;
 * the window's `to` reads the Nth collection and the horizon from it.
 */
type Side = { input: OccurrencePreviewInput; preview: OccurrencePreview }

/** The recurrence date of the side's Nth collection, or null when it makes fewer. */
function nthPlannedDate(side: Side | null, count: number): string | null {
  if (!side) return null
  const dates = side.preview.rows
    .filter(collects)
    .map((row) => row.plannedDate)
    .sort()
  return dates[count - 1] ?? null
}

/**
 * The delta between the draft as it stands and a candidate over the draft's
 * next `count` collections: one row per recurrence date either side yields,
 * classified by what the candidate does to it.
 */
export function simulateOccurrences(input: SimulateOccurrencesInput): OccurrenceSimulation {
  const count = Math.max(1, Math.floor(input.count))
  const inputs = [input.current, input.candidate]
  const starts = inputs
    .map((side) => side?.recurrence.effectiveFrom)
    .filter((start): start is string => typeof start === "string" && isIsoDate(start))
  if (starts.length === 0) return EMPTY_SIMULATION

  // The window opens at the earlier start, or today when the scheme already
  // runs — "next" counts from now, not from a start in the past.
  const earliestStart = starts.reduce(earlier)
  const from =
    input.from !== undefined && isIsoDate(input.from) ? later(earliestStart, input.from) : earliestStart

  const [current, candidate] = inputs.map(
    (side): Side | null => (side ? { input: side, preview: occurrencePreview(side, from) } : null),
  )
  const horizons = [current, candidate]
    .map((side) => side?.preview.horizon ?? null)
    .filter((horizon): horizon is string => horizon !== null)
  const to =
    nthPlannedDate(current, count) ??
    nthPlannedDate(candidate, count) ??
    (horizons.length > 0 ? horizons.reduce(later) : null)
  if (to === null || to < from) return EMPTY_SIMULATION
  const window: OccurrenceWindow = { from, to }

  const rowsOf = (side: Side | null) =>
    new Map(
      (side ? generateOccurrences({ ...side.input, window }) : []).map((row) => [row.plannedDate, row]),
    )
  const currentRows = rowsOf(current)
  const candidateRows = rowsOf(candidate)

  const rows: SimulatedOccurrence[] = [...new Set([...currentRows.keys(), ...candidateRows.keys()])]
    .sort()
    .map((plannedDate) => {
      const before = currentRows.get(plannedDate) ?? null
      const after = candidateRows.get(plannedDate) ?? null
      const change: OccurrenceChange =
        collects(before) && collects(after)
          ? before.date === after.date
            ? "unchanged"
            : "moved"
          : collects(before)
            ? "removed"
            : collects(after)
              ? "added"
              : "unchanged"
      return { plannedDate, current: before, candidate: after, change }
    })

  const tally = (change: OccurrenceChange) => rows.filter((row) => row.change === change).length
  return {
    rows,
    window,
    before: rows.filter((row) => collects(row.current)).length,
    after: rows.filter((row) => collects(row.candidate)).length,
    added: tally("added"),
    removed: tally("removed"),
    moved: tally("moved"),
  }
}
