// The pieces each app's env.ts declares its variables with. A process reads
// its environment once at startup and never again; every value arrives as a
// string, so the schemas do the reading. An empty variable counts as not set,
// applied once in parseEnvironment for every variable, so a variable is a
// plain schema with a default, or without one when the process cannot run
// without it. Anything else in the environment is dropped, not carried around.
import * as z from "zod"

import { TRANSACTION_POOLER_PORT, withoutEmpty, type Environment } from "./process"

/** The address to bind. Loopback by default; a container sets `0.0.0.0`. */
export const Host = z
  .string()
  .regex(/^[A-Za-z0-9._:-]+$/, {
    error: "must be an IP address or a host name: no spaces, brackets, scheme or IPv6 zone id",
  })
  .default("127.0.0.1")

/** A string of decimal digits read as a number; `what` completes the refusal's "must be a whole number". */
const digits = (what: string) => z.string().regex(/^\d+$/, { error: `must be a whole number${what}` }).transform(Number)

/** A TCP port, 1..65535, `fallback` unless set. */
export const Port = (fallback: number) => digits("").pipe(z.int().min(1).max(65535)).default(fallback)

/** A whole number of at least `min`, absent unless set; `what` names its unit, as " of seconds, at least 1". */
export const wholeNumber = (min: number, what: string) => digits(what).pipe(z.int().min(min)).optional()

function isPostgresUrl(value: string): boolean {
  if (!/^postgres(ql)?:\/\//.test(value)) return false
  try {
    return new URL(value).hostname !== ""
  } catch {
    return false
  }
}

/**
 * A Postgres URL with a host, `role` saying whose connection string it is. No
 * default: a process without its database refuses to start rather than answer
 * 503 forever. Only the shape is checked; whether the database answers is
 * /readyz's question, asked on every probe, since it may come and go while
 * the process stays up.
 */
export const PostgresUrl = (role: string) => z.string().refine(isPostgresUrl, { error: `must be a postgresql:// URL with a host, ${role}` })

const notOnTransactionPooler = (value: string): boolean => {
  try {
    return new URL(value).port !== TRANSACTION_POOLER_PORT
  } catch {
    // Not a URL at all: the shape's refusal has already named the variable.
    return true
  }
}

/** A Postgres URL that holds a session, refused on the transaction pooler by its port; `needs` says who needs the session. */
export const SessionUrl = (role: string, needs: string) =>
  PostgresUrl(role).refine(notOnTransactionPooler, {
    error: `port ${TRANSACTION_POOLER_PORT} is the transaction pooler; ${needs} a session (the direct connection or the session pooler on port 5432)`,
  })

/** Reads the environment against an app's declaration, or throws one error naming every bad variable. */
export function parseEnvironment<Schema extends z.ZodType>(schema: Schema, source: Environment): z.output<Schema> {
  const result = schema.safeParse(withoutEmpty(source))
  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`)
  }
  return result.data
}
