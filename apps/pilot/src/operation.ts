// What one of the Pilot's operations is (Issue #152): a name the workflow's
// `operation` input offers, what must hold before any of its phases runs, and
// its phases in order (operations.ts holds the six). Admission is the
// workflow's own rule: with the Pilot as the target the run is on main, and an
// operation that replaces what the API reads, or reads another run's
// artifact, has its input say so. The command line a workflow step runs is
// here too: one phase, admitted, and a failure said without a statement or a
// stack.
import { Refusal, createContext, type Context, type Environment, type Phase } from "@waste/db/pilot/phase"
import { unreachableHint } from "@waste/db/pilot/identity"
import { failureMessage } from "@waste/db/sqlstate"

/** The operations, as the workflow's `operation` input offers them. */
export const PILOT_OPERATIONS = ["check", "release", "reset-to-seed", "grant-logins", "restore", "recover-logins"] as const
export type PilotOperation = (typeof PILOT_OPERATIONS)[number]

export type Operation = {
  readonly name: PilotOperation
  /** What must hold before any of its phases runs. */
  readonly admit: (context: Context) => void
  readonly phases: readonly Phase[]
}

const set = (value: string | undefined): boolean => value !== undefined && value !== ""

/** With the Pilot as the target, the run is on main and nowhere else. */
export const fromMain =
  (sentence: string) =>
  (context: Context): void => {
    if (set(context.env.PILOT_SUPABASE_REF) && context.env.GITHUB_REF !== "refs/heads/main") throw new Refusal(sentence)
  }

/** A restore or a reset replaces what the API and the worker read: the operator says the Pilot's service is stopped. */
export const servicesSuspended =
  (operation: string) =>
  (context: Context): void => {
    if (context.env.SERVICES_SUSPENDED !== "true") throw new Refusal(`Stop the Pilot's Suga service first, then dispatch the ${operation} with services_suspended on`)
  }

/** A restore or a recovery reads one run's artifact: the run is named, as a number. */
export const sourceRunNamed = (context: Context): void => {
  if (!/^\d+$/.test(context.env.SOURCE_RUN_ID ?? "")) throw new Refusal("source_run_id names no run")
}

/** Every admission of an operation, in order. */
export const admitting =
  (...checks: readonly ((context: Context) => void)[]) =>
  (context: Context): void => {
    for (const check of checks) check(context)
  }

/** One phase of an operation: admitted unless it is the cleanup, which runs whatever came before, then run. */
export async function runPhase(operation: Operation, phase: Phase, context: Context): Promise<void> {
  if (phase.cleanup !== true) operation.admit(context)
  await phase.run(context)
}

/**
 * The command line every workflow step runs, `<operation> <phase>`: the phase
 * admitted and run, and a failure said by its message alone — never a stack a
 * secret could sit in, never a statement's parameters — with the
 * paused-Supabase-project hint where the Pilot could not be reached, and exit
 * 1. A refusal is said as the workflow's error annotation.
 */
export async function operateFromCommandLine(operations: readonly Operation[], [operationName, phaseName]: readonly string[], env: Environment = process.env): Promise<void> {
  const operation = operations.find((candidate) => candidate.name === operationName)
  const phase = operation?.phases.find((candidate) => candidate.name === phaseName)
  if (operation === undefined || phase === undefined) {
    console.error(`usage: operate.ts <operation> <phase>, one of: ${operations.flatMap((each) => each.phases.map((step) => `${each.name} ${step.name}`)).join("; ")}`)
    process.exit(1)
  }
  try {
    await runPhase(operation, phase, createContext({ env }))
  } catch (error) {
    if (error instanceof Refusal) console.log(`::error::${error.message}`)
    else console.error(failureMessage(error))
    const hint = unreachableHint(env.DATABASE_ADMIN_URL ?? "", error)
    if (hint !== undefined) console.error(hint)
    process.exit(1)
  }
}
