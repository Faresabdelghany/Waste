// The process environment, read once at startup and never again. Two
// variables so far: where to listen. Every value arrives as a string, so the
// schema does the reading, and an empty variable counts as not set. Anything
// else in the environment is dropped, not carried around.
import * as z from "zod"

/** Set-but-empty is how a shell says "not set". */
const unsetIfEmpty = (value: unknown) => (value === "" ? undefined : value)

/** A TCP port from a string of decimal digits, 1..65535. */
const Port = z.preprocess(
  unsetIfEmpty,
  z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.int().min(1).max(65535))
    .default(3001),
)

export const Env = z.object({
  /** The address to bind. Loopback by default; a container sets `0.0.0.0`. */
  HOST: z.preprocess(unsetIfEmpty, z.string().min(1).default("127.0.0.1")),
  PORT: Port,
})
export type Env = z.infer<typeof Env>

/** Reads the environment, or throws one error naming every bad variable. */
export function parseEnv(source: Readonly<Record<string, string | undefined>>): Env {
  const result = Env.safeParse(source)
  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`)
  }
  return result.data
}
