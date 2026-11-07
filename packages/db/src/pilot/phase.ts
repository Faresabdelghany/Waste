// A Pilot operation's phases and what each phase is given (Issue #152). An
// operation of the protected workflow (.github/workflows/pilot-database.yml)
// is a list of phases run in order, one workflow step each (apps/pilot's
// operations.ts holds the six lists, and its test holds the workflow's jobs to
// them). Between two phases the workflow does only what a step of its own
// must: move an artifact, which no script can, or hand a secret to the one
// phase that reads it. Everything else is here, once:
//
// - the order, which is the list's;
// - the Pilot-target check: a phase reaches its database only through
//   `adminUrl`, which holds the owner's URL to the Pilot's Supabase project
//   (PILOT_SUPABASE_REF) — or, outside the workflow, to the local stack —
//   every time it is read, so no phase can forget it;
// - admission: with the Pilot as the target the run must be on main, and an
//   operation's own conditions (the services stopped, a source run named)
//   hold before each of its phases;
// - the names: every file a phase writes and every artifact the workflow
//   stores (`layout`), which a phase hands the workflow as step outputs, so
//   the workflow types none of them.
//
// The restore rehearsal runs the restore's phases through the same context on
// the local stack (rehearsal.ts).
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { failureMessage } from "../sqlstate"
import { BARRIER_ROLES, LOGIN_STATE_FILE } from "./barrier"
import { expectPilot, unreachableHint } from "./identity"
import { LOCAL_RUN, type RunRef } from "./run"

export type Environment = Readonly<Record<string, string | undefined>>

/** The operations, as the workflow's `operation` input offers them. */
export const PILOT_OPERATIONS = ["check", "release", "reset-to-seed", "grant-logins", "restore", "recover-logins"] as const
export type PilotOperation = (typeof PILOT_OPERATIONS)[number]

/** The kinds of artifact the workflow stores, each named `<kind>-<run>-<attempt>`. */
export const BACKUP_ARTIFACT = "pilot-backup"
export const LOGIN_STATE_ARTIFACT = "login-state"
export type ArtifactKind = typeof BACKUP_ARTIFACT | typeof LOGIN_STATE_ARTIFACT

/** An artifact's name: its kind, the run and the attempt that stored it. */
export const artifactName = (kind: ArtifactKind, run: RunRef): string => `${kind}-${run.id}-${run.attempt}`

/** A run's artifacts of one kind, the attempt captured: what `artifactName` writes, read back. */
export const artifactsOf = (kind: ArtifactKind, runId: string): RegExp => new RegExp(`^${kind}-${runId}-(\\d+)$`)

/** Where an artifact of a run a restore or a recovery reads from is downloaded, beside the choice that names it. */
const SOURCE_DIRECTORY: Record<ArtifactKind, string> = { [BACKUP_ARTIFACT]: "pilot-source", [LOGIN_STATE_ARTIFACT]: "login-state-source" }

/** Every file and artifact one run's phases share, under the runner's temporary directory (or the rehearsal's own). */
export function layout(temp: string, run: RunRef) {
  const backup = artifactName(BACKUP_ARTIFACT, run)
  return {
    /** This run's encrypted backup, stored as its artifact. */
    backup: { artifact: backup, file: path.join(temp, BACKUP_ARTIFACT, `${backup}.tar.age`) },
    /** This run's login record, stored as its artifact and read back into `copy`. */
    loginState: { artifact: artifactName(LOGIN_STATE_ARTIFACT, run), file: path.join(temp, LOGIN_STATE_ARTIFACT, LOGIN_STATE_FILE), copy: path.join(temp, `${LOGIN_STATE_ARTIFACT}-copy`) },
    /** Where another run's artifact of a kind is downloaded, and the file naming which run and artifact it is. */
    source: (kind: ArtifactKind) => ({ dir: path.join(temp, SOURCE_DIRECTORY[kind]), pick: path.join(temp, `${SOURCE_DIRECTORY[kind]}.json`) }),
    /** The decrypted backup a restore applies. */
    restore: path.join(temp, "pilot-restore"),
    /** What holds a database's rows in the clear, or an encrypted copy of them, removed after every run: the directories above and the scripts' own temporary ones (`<prefix>.XXXXXX`). */
    plaintext: { directories: [path.join(temp, BACKUP_ARTIFACT), path.join(temp, "pilot-restore"), path.join(temp, SOURCE_DIRECTORY[BACKUP_ARTIFACT])], prefixes: [`${BACKUP_ARTIFACT}.`, "pilot-restore-key."], temp },
  }
}
export type Layout = ReturnType<typeof layout>

/** A run a restore or a recovery reads from, as the choice of its artifact found it. */
export type SourceRun = { run: RunRef; commit: string; artifact: { id: number; name: string } }

export type Context = {
  readonly env: Environment
  /** The run the phases belong to: the workflow's own, or LOCAL_RUN. */
  readonly run: RunRef
  readonly commit: string
  readonly layout: Layout
  /** The roles the write barrier switches off: BARRIER_ROLES, unless a suite closes it on throwaway roles of its own. */
  readonly barrierRoles: readonly string[]
  /** A variable the phase cannot go on without, refused by name. */
  required(name: string): string
  /** The owner's URL, held to the Pilot or, outside the workflow, the local stack, every time it is read. */
  adminUrl(): string
  /** A step output the workflow reads (`steps.<id>.outputs.<name>`). */
  output(name: string, value: string): void
  /** A line of the run's summary, and of the log. */
  summary(line: string): void
  log(line: string): void
}

export type ContextOptions = {
  env: Environment
  /** The run and commit the phases belong to; the workflow's (GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_SHA) where it sets them, else LOCAL_RUN. */
  run?: { run: RunRef; commit: string }
  /** Where the layout lives: RUNNER_TEMP, else the system's. */
  temp?: string
  barrierRoles?: readonly string[]
  log?: (line: string) => void
  output?: (name: string, value: string) => void
  summary?: (line: string) => void
}

const set = (value: string | undefined): value is string => value !== undefined && value !== ""

export function createContext({ env, run, temp, barrierRoles = BARRIER_ROLES, log = (line) => console.log(line), output, summary }: ContextOptions): Context {
  const required = (name: string): string => {
    const value = env[name]
    if (!set(value)) throw new Error(`${name} is not set`)
    return value
  }
  const own = run ?? (set(env.GITHUB_RUN_ID) ? { run: { id: env.GITHUB_RUN_ID, attempt: required("GITHUB_RUN_ATTEMPT") }, commit: required("GITHUB_SHA") } : LOCAL_RUN)
  const append = (variable: string, line: string): boolean => {
    const file = env[variable]
    if (!set(file)) return false
    appendFileSync(file, `${line}\n`)
    return true
  }
  return {
    env,
    run: own.run,
    commit: own.commit,
    layout: layout(temp ?? (set(env.RUNNER_TEMP) ? env.RUNNER_TEMP : tmpdir()), own.run),
    barrierRoles,
    required,
    adminUrl: () => {
      const url = required("DATABASE_ADMIN_URL")
      expectPilot(url, env.PILOT_SUPABASE_REF)
      return url
    },
    output:
      output ??
      ((name, value) => {
        if (/[\r\n]/.test(value)) throw new Error(`the output ${name} spans lines`)
        if (!append("GITHUB_OUTPUT", `${name}=${value}`)) log(`${name}=${value}`)
      }),
    summary:
      summary ??
      ((line) => {
        log(line)
        append("GITHUB_STEP_SUMMARY", line)
      }),
    log,
  }
}

/** A refusal before anything ran, said as the workflow's error annotation. */
export class Refusal extends Error {}

export type Phase = {
  readonly name: string
  /** A phase that runs whatever came before (`if: always()`): admitted unconditionally, since it only removes what the run left. */
  readonly cleanup?: true
  run(context: Context): Promise<void>
}

export type Operation = {
  readonly name: PilotOperation
  /** What must hold before any of its phases runs. */
  readonly admit: (context: Context) => void
  readonly phases: readonly Phase[]
}

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

export async function runPhase(operation: Operation, phase: Phase, context: Context): Promise<void> {
  if (phase.cleanup !== true) operation.admit(context)
  await phase.run(context)
}

/** The choice a restore's or a recovery's first phase made, for the phases after the download. */
export function writeSourceRun(context: Context, kind: ArtifactKind, source: SourceRun): void {
  const { pick } = context.layout.source(kind)
  mkdirSync(path.dirname(pick), { recursive: true })
  writeFileSync(pick, `${JSON.stringify(source)}\n`)
}

export function readSourceRun(context: Context, kind: ArtifactKind): SourceRun {
  const source = JSON.parse(readFileSync(context.layout.source(kind).pick, "utf8")) as SourceRun
  if (source.run.id !== context.required("SOURCE_RUN_ID")) throw new Error(`the chosen artifact is of run ${source.run.id}, not the source run ${context.env.SOURCE_RUN_ID}`)
  return source
}

/** The one file of a name a downloaded artifact holds, at its top or one directory down, as download-artifact may unpack it. */
export function theOneFile(dir: string, matches: (name: string) => boolean, what: string): string {
  const found: string[] = []
  const entries = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []
  for (const entry of entries) if (entry.isFile() && matches(entry.name)) found.push(path.join(dir, entry.name))
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    for (const inner of readdirSync(path.join(dir, entry.name), { withFileTypes: true })) if (inner.isFile() && matches(inner.name)) found.push(path.join(dir, entry.name, inner.name))
  }
  if (found.length !== 1) throw new Error(`the downloaded artifact holds ${found.length} ${what}, not one`)
  return found[0]
}

/** The last phase of every operation that wrote a backup: its plaintext, and the encrypted copies, removed whatever happened before. */
export const removePlaintext: Phase = {
  name: "remove-plaintext",
  cleanup: true,
  async run({ layout: { plaintext } }) {
    for (const directory of plaintext.directories) rmSync(directory, { recursive: true, force: true })
    for (const name of readdirSync(plaintext.temp)) {
      if (plaintext.prefixes.some((prefix) => name.startsWith(prefix))) rmSync(path.join(plaintext.temp, name), { recursive: true, force: true })
    }
  },
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
