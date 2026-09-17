// The process environment, read once at startup and never again. Two
// variables so far: where to listen. Every value arrives as a string, so the
// schemas do the reading. An empty variable counts as not set, applied once
// in parseEnv for every variable, so a new field is a plain schema with a
// default. Anything else in the environment is dropped, not carried around.
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

export const Env = z.object({
  HOST: Host,
  PORT: Port,
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
