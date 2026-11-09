// How the wire spells a row's time, for every shape here and every route
// that answers a row of its own: an instant is its ISO string, and a `time`
// column is the contracts' `IsoTime`.

export function stampsOf(row: { createdAt: Date; updatedAt: Date }): { createdAt: string; updatedAt: string } {
  return { createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }
}

export const instantOf = (value: Date | null): string | null => (value === null ? null : value.toISOString())

/** A `time` column as postgres.js hands it over: `HH:MM:SS`, with fractional seconds where the value carried them. */
const TIME_OF_DAY = /^(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/

/**
 * A `time` column as the wire spells it (Issue #97): Postgres answers
 * `HH:MM:SS`, the contracts' `IsoTime` is `HH:MM`, so the seconds go. A value
 * that is not a time of day is a bug in a statement, not a client's, and is
 * thrown to become the server's 500 rather than sliced into a wrong time.
 */
export function timeOf(value: string): string {
  const match = TIME_OF_DAY.exec(value)
  if (match === null) throw new Error(`timeOf: ${JSON.stringify(value)} is not a time of day as Postgres spells one (HH:MM:SS)`)
  return match[1]
}
