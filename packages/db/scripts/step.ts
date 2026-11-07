// What every script of this package shares — migrate.ts, check.ts and
// fingerprint.ts here, and the backup's helpers under pilot/: a required
// variable read or refused by name, and a line for the run's summary. Each
// script reads what it needs from its environment: no argument an operator
// typed ever reaches a statement. The Pilot's operations run through their
// own phases (src/pilot/phase.ts).
import { appendFileSync } from "node:fs"

import { failureMessage } from "../src/sqlstate"

export function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === "") {
    console.error(`${name} is not set`)
    process.exit(1)
  }
  return value
}

/** A line of the run's summary, and of the log. */
export function summary(line: string): void {
  console.log(line)
  const file = process.env.GITHUB_STEP_SUMMARY
  if (file !== undefined && file !== "") appendFileSync(file, `${line}\n`)
}

/** Runs a script's body, printing a failure's message alone (`failureMessage`) and exiting 1. */
export async function step(body: () => Promise<void>): Promise<void> {
  try {
    await body()
  } catch (error) {
    console.error(failureMessage(error))
    process.exit(1)
  }
}
