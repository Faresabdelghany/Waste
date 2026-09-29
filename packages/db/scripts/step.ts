// What every script of this package shares (Issue #152) — migrate.ts,
// check.ts and fingerprint.ts here, and the Pilot's under pilot/: a required
// variable read or refused by name, a step output written for the workflow,
// and a line for the run's summary. Each script is one fixed step of
// .github/workflows/pilot-database.yml or of CI and reads what it needs from
// its environment: no argument an operator typed ever reaches a statement.
import { appendFileSync } from "node:fs"

import { unreachableHint } from "../src/pilot/identity"
import { messageWithoutStatement } from "../src/sqlstate"

export function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === "") {
    console.error(`${name} is not set`)
    process.exit(1)
  }
  return value
}

/** A step output (`steps.<id>.outputs.<name>`); printed where there is no workflow. */
export function output(name: string, value: string): void {
  if (/[\r\n]/.test(value)) throw new Error(`the output ${name} spans lines`)
  const file = process.env.GITHUB_OUTPUT
  if (file === undefined || file === "") console.log(`${name}=${value}`)
  else appendFileSync(file, `${name}=${value}\n`)
}

/** A line of the run's summary, and of the log. */
export function summary(line: string): void {
  console.log(line)
  const file = process.env.GITHUB_STEP_SUMMARY
  if (file !== undefined && file !== "") appendFileSync(file, `${line}\n`)
}

/**
 * What a failure says: the error's message with a statement's text and
 * parameters cut off (src/sqlstate.ts's rule), since a repair's failing
 * statement would otherwise put a row's values in a public log, and the
 * database's own sentence kept where Drizzle wrapped one.
 */
function said(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const message = messageWithoutStatement(error.message)
  if (message === error.message) return message
  const { cause } = error
  return cause instanceof Error ? `${message}: ${messageWithoutStatement(cause.message)}` : message
}

/**
 * Runs a script's body, printing a failure's message alone — never a stack a
 * secret could sit in, never a statement's parameters — with the
 * paused-Supabase-project hint where the Pilot could not be reached, and
 * exiting 1.
 */
export async function step(body: () => Promise<void>): Promise<void> {
  try {
    await body()
  } catch (error) {
    console.error(said(error))
    const hint = unreachableHint(process.env.DATABASE_ADMIN_URL ?? "", error)
    if (hint !== undefined) console.error(hint)
    process.exit(1)
  }
}
