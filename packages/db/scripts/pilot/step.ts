// What every Pilot script shares (Issue #152): a required variable read or
// refused by name, a step output written for the workflow, and a line for the
// run's summary. Each script is one fixed step of .github/workflows/
// pilot-database.yml and reads what it needs from its environment: no
// argument an operator typed ever reaches a statement.
import { appendFileSync } from "node:fs"

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

/** Runs a script's body, printing a failure's message alone — never a stack a secret could sit in — and exiting 1. */
export async function step(body: () => Promise<void>): Promise<void> {
  try {
    await body()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
