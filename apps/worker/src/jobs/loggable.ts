// What a job's failure leaves on its run row, and what it logs: the API's
// projection (apps/api/src/problem.ts's `loggable`), spelled here because the
// worker does not depend on the API, with one thing more. What is kept is
// what an operator debugs with — who threw, what it said, the SQLSTATE and
// the constraint when Postgres named one, the stack, and the same projection
// of the cause, which is where Drizzle keeps the database's own error — and
// what is dropped is the statement and its parameters, which would put a
// row's values on a `generation_run.error` column the office reads.
//
// The thing more: Drizzle's own wrapper spells its message as the statement
// and its parameters (`Failed query: insert into … params: …`), so the
// message of a Drizzle error is itself the thing to drop. Its first line
// names nothing but the statement's head, so the message is cut at the
// statement and the cause — postgres.js's error, whose message is the
// database's sentence (`new row for relation "pickup" violates check
// constraint "fail_on_purpose"`) — carries what matters.
const CAUSE_DEPTH = 3
/** How Drizzle's wrapper begins its message; everything from here is the statement. */
const DRIZZLE_QUERY = "Failed query: "

const messageOf = (message: string): string => (message.startsWith(DRIZZLE_QUERY) ? "Failed query" : message)

export function loggable(error: unknown, depth: number = CAUSE_DEPTH): unknown {
  if (typeof error !== "object" || error === null) return error
  const { name, message, code, constraint_name: constraint, stack, cause } = error as Record<string, unknown>
  // The stack begins with the message, so the statement is cut from it the same way.
  const stackOf = (text: string): string => (typeof message === "string" && message.startsWith(DRIZZLE_QUERY) ? text.replace(message, messageOf(message)) : text)
  return {
    ...(typeof name === "string" ? { name } : {}),
    ...(typeof message === "string" ? { message: messageOf(message) } : {}),
    ...(typeof code === "string" ? { code } : {}),
    ...(typeof constraint === "string" ? { constraint_name: constraint } : {}),
    ...(typeof stack === "string" ? { stack: stackOf(stack) } : {}),
    ...(cause === undefined || depth <= 0 ? {} : { cause: loggable(cause, depth - 1) }),
  }
}
