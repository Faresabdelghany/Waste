// What Postgres said when a statement failed, read off the error as
// postgres.js raises it and as Drizzle wraps it (`cause`): the SQLSTATE, and
// the constraint it names where it named one. Three states have a meaning to
// a caller. A unique violation (23505) is two rows with the same key; an
// exclusion violation (23P01) is two rows whose periods overlap (the
// Registry's effective-dated tables, Issue #78); a check violation (23514) is
// a row alone whose own value will not do. The API turns the first two into
// a 409 and the third, where a route foresaw it, into a 400 on the field
// (apps/api/src/problem.ts, routes/shared.ts) — and the worker (Issue #109
// part B) reads the first the way the driver door does, as a key already
// taken meaning the work was done before: an outbox event delivered twice
// meets `ticket_source_event_id_idx` and reads the ticket the first delivery
// made. Both processes read the error the same way, so the reading lives in
// the package both consume; the API's problem.ts re-exports the three
// readers under the names its routes and tests always used.

/** Two rows with the same key. */
export const UNIQUE_VIOLATION = "23505"
/** Two rows whose periods overlap: an `EXCLUDE USING gist` refused. */
export const EXCLUSION_VIOLATION = "23P01"
/** A row alone whose own value a `CHECK` refused. */
export const CHECK_VIOLATION = "23514"

/** The SQLSTATE of a failed statement, through Drizzle's wrapper (`cause`) or straight from postgres.js; undefined for an error that is not the database's. */
export function sqlstate(error: unknown): { code: string; constraint?: string } | undefined {
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    if (typeof candidate !== "object" || candidate === null) continue
    const { code, constraint_name: constraint } = candidate as { code?: unknown; constraint_name?: unknown }
    if (typeof code === "string") return { code, ...(typeof constraint === "string" ? { constraint } : {}) }
  }
  return undefined
}

/** The constraint a failed statement names, when it failed this way and Postgres named one. */
function constraintOf(error: unknown, code: string): string | undefined {
  const failed = sqlstate(error)
  return failed?.code === code ? failed.constraint : undefined
}

/** The constraint a unique violation names, when that is what the error is and Postgres named it: which key was already taken. */
export function uniqueConstraintOf(error: unknown): string | undefined {
  return constraintOf(error, UNIQUE_VIOLATION)
}

/** The same for an exclusion violation: which `EXCLUDE USING gist` refused the period. */
export function exclusionConstraintOf(error: unknown): string | undefined {
  return constraintOf(error, EXCLUSION_VIOLATION)
}

/** The same for a check violation: which `CHECK` refused the value. */
export function checkConstraintOf(error: unknown): string | undefined {
  return constraintOf(error, CHECK_VIOLATION)
}
