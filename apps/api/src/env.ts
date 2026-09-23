// The process environment, read once at startup and never again. Three
// variables: where to listen, and the database. Every value arrives as a
// string, so the schemas do the reading. An empty variable counts as not set,
// applied once in parseEnv for every variable, so a new field is a plain
// schema with a default, or without one when the process cannot run without
// it. Anything else in the environment is dropped, not carried around.
import * as z from "zod"

/** The address to bind. Loopback by default; a container sets `0.0.0.0`. */
const Host = z
  .string()
  .regex(/^[A-Za-z0-9._:-]+$/, {
    error: "must be an IP address or a host name: no spaces, brackets, scheme or IPv6 zone id",
  })
  .default("127.0.0.1")

/** A TCP port from a string of decimal digits, 1..65535. */
const Port = z
  .string()
  .regex(/^\d+$/, { error: "must be a whole number" })
  .transform(Number)
  .pipe(z.int().min(1).max(65535))
  .default(3001)

/**
 * The database, as the API role `wms_api` (see .env.example at the repository
 * root; through Supabase's pooler the user is `wms_api.<project-ref>`). No
 * default: a process without a database is not the API, so it refuses to
 * start rather than answer 503 forever. Only the shape is checked here, a
 * Postgres URL with a host; whether it answers is /readyz's question, asked
 * on every probe, because the database may come and go while the process
 * stays up.
 */
const DatabaseUrl = z.string().refine(isPostgresUrl, {
  error: "must be a postgresql:// URL with a host, the API role's connection string",
})

function isPostgresUrl(value: string): boolean {
  if (!/^postgres(ql)?:\/\//.test(value)) return false
  try {
    return new URL(value).hostname !== ""
  } catch {
    return false
  }
}

export const Env = z.object({
  HOST: Host,
  PORT: Port,
  DATABASE_URL: DatabaseUrl,
})
export type Env = z.infer<typeof Env>

/** Set-but-empty is how a shell says "not set". */
const withoutEmpty = (source: Readonly<Record<string, string | undefined>>) =>
  Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined && value !== ""))

/** Reads the environment, or throws one error naming every bad variable. */
export function parseEnv(source: Readonly<Record<string, string | undefined>>): Env {
  const result = Env.safeParse(withoutEmpty(source))
  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`)
  }
  return result.data
}
