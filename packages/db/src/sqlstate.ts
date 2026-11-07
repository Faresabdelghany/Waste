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
// the package both consume, and each imports it from here. What of a
// failure may be logged (`loggable`) is read here for the same reason.

/** Two rows with the same key. */
export const UNIQUE_VIOLATION = "23505"
/** Two rows whose periods overlap: an `EXCLUDE USING gist` refused. */
export const EXCLUSION_VIOLATION = "23P01"
/** A row alone whose own value a `CHECK` refused. */
export const CHECK_VIOLATION = "23514"
/** A row lock asked for `NOWAIT` that another transaction holds. */
export const LOCK_NOT_AVAILABLE = "55P03"

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
export function constraintOf(error: unknown, code: string): string | undefined {
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

/** How Drizzle's wrapper begins its message: `Failed query: <statement>\nparams: <values>`, the statement and what was bound to it. */
export const DRIZZLE_QUERY = "Failed query: "

/**
 * An error's message with the statement cut off. Drizzle's wrapper spells its
 * message as the statement and its parameters, so a log line, a run row or a
 * workflow summary that carried it whole would carry a row's values; its
 * first line names nothing but the statement's head, so the message is cut at
 * the statement, and the cause — postgres.js's error, whose message is the
 * database's own sentence — carries what matters. `loggable` below and
 * `failureMessage` both read it; any other message is returned as it is.
 */
export function messageWithoutStatement(message: string): string {
  return message.startsWith(DRIZZLE_QUERY) ? "Failed query" : message
}

/**
 * What a script or a Pilot operation's phase says when it fails, in a log
 * that may be public: the error's message with a statement's text and
 * parameters cut off, and the database's own sentence kept where Drizzle
 * wrapped one. Never the stack, where a secret could sit.
 */
export function failureMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const message = messageWithoutStatement(error.message)
  if (message === error.message) return message
  const { cause } = error
  return cause instanceof Error ? `${message}: ${messageWithoutStatement(cause.message)}` : message
}

/** How far down a `cause` chain `loggable` goes; Drizzle wraps postgres.js, which wraps nothing. */
const LOG_CAUSE_DEPTH = 3

/**
 * What a failure leaves in a log or on a run row: a projection of the error,
 * never the error itself. A postgres.js error carries the statement it sent
 * and the `parameters` it bound, and Drizzle's wrapper spells both into its
 * message and stack, so logging either whole would print an invitee's e-mail
 * address, a company's registration number or whatever else a row held into
 * the operator's log. What is kept is what an operator debugs with: who
 * threw, what it said with the statement cut (`messageWithoutStatement`), the
 * SQLSTATE and the constraint when Postgres named one, the stack, and the
 * same projection of the cause, where Drizzle keeps the database's own error.
 */
export function loggable(error: unknown, depth: number = LOG_CAUSE_DEPTH): unknown {
  if (typeof error !== "object" || error === null) return error
  const { name, message, code, constraint_name: constraint, stack, cause } = error as Record<string, unknown>
  // The stack begins with the message, so the statement is cut from it the same way.
  const stackOf = (text: string): string => (typeof message === "string" && message.startsWith(DRIZZLE_QUERY) ? text.replace(message, messageWithoutStatement(message)) : text)
  return {
    ...(typeof name === "string" ? { name } : {}),
    ...(typeof message === "string" ? { message: messageWithoutStatement(message) } : {}),
    ...(typeof code === "string" ? { code } : {}),
    ...(typeof constraint === "string" ? { constraint_name: constraint } : {}),
    ...(typeof stack === "string" ? { stack: stackOf(stack) } : {}),
    ...(cause === undefined || depth <= 0 ? {} : { cause: loggable(cause, depth - 1) }),
  }
}
