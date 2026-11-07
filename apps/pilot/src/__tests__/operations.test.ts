// The protected workflow is the operations' thin caller (Issue #152): each of
// its jobs runs its operation's phases (operations.ts) in order, one step
// each, and between them only stores or fetches the artifacts the phases name.
// Read without a YAML parser: a job key is two spaces in, a step six.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, test } from "node:test"

import { PILOT_OPERATIONS } from "@waste/db/pilot/phase"
import { GRANTED_ROLES, OWNER } from "@waste/db/roles"

import { OPERATIONS, WORKFLOW } from "../operations"

const workflow = readFileSync(new URL(`../../../../${WORKFLOW}`, import.meta.url), "utf8")

type Step = { text: string; run?: string; uses?: string; env: Map<string, string>; with: Map<string, string> }

/** The steps of each job, by job key, in order. */
function jobs(text: string): Map<string, Step[]> {
  const found = new Map<string, Step[]>()
  const lines = text.slice(text.indexOf("\njobs:\n")).split("\n")
  let steps: Step[] | undefined
  let step: string[] = []
  const close = () => {
    if (steps === undefined || step.length === 0) return
    const body = step.join("\n")
    const block = (name: string) =>
      new Map(
        [...(new RegExp(`\\n {8}${name}:\\n((?: {10}.*\\n?)*)`).exec(`\n${body}\n`)?.[1] ?? "").matchAll(/^ {10}([A-Za-z0-9_-]+): (.*)$/gm)].map(([, key, value]) => [key, value.trim()]),
      )
    steps.push({ text: body, run: /^ {8}run: (.*)$/m.exec(body)?.[1], uses: /^ {6}- uses: (\S+)|^ {8}uses: (\S+)/m.exec(body)?.slice(1).find(Boolean), env: block("env"), with: block("with") })
    step = []
  }
  for (const line of lines) {
    const job = /^ {2}([a-z-]+):\s*$/.exec(line)
    if (job !== null) {
      close()
      steps = []
      found.set(job[1], steps)
      continue
    }
    if (/^ {6}- /.test(line)) close()
    if (steps !== undefined && (/^ {6}- /.test(line) || (step.length > 0 && /^ {8}/.test(line)))) step.push(line)
  }
  close()
  return found
}

const JOBS = jobs(workflow)
const PHASE_CALL = /^node --import tsx src\/operate\.ts ([a-z-]+) ([a-z-]+)$/

describe("the Pilot database workflow", () => {
  test("offers exactly the operations, in their order", () => {
    const options = /\n {8}options:\n((?: {10}- .*\n)+)/.exec(workflow)?.[1] ?? ""
    assert.deepEqual([...options.matchAll(/- (\S+)/g)].map(([, name]) => name), [...PILOT_OPERATIONS])
    assert.deepEqual(
      OPERATIONS.map((operation) => operation.name),
      [...PILOT_OPERATIONS],
    )
  })

  test("runs each operation's phases in order, one step each, and no other script", () => {
    const called = new Map<string, string[]>()
    for (const [job, steps] of JOBS) {
      for (const step of steps) {
        if (step.run === undefined) continue
        const call = PHASE_CALL.exec(step.run)
        assert.ok(call !== null, `${job} runs ${step.run}, not a phase`)
        assert.match(step.text, /^ {8}working-directory: apps\/pilot$/m, `${job}'s ${call[2]} step runs from apps/pilot`)
        called.set(call[1], [...(called.get(call[1]) ?? []), call[2]])
      }
    }
    for (const operation of OPERATIONS) {
      assert.deepEqual(
        called.get(operation.name),
        operation.phases.map((phase) => phase.name),
        operation.name,
      )
    }
    assert.deepEqual([...JOBS.keys()], ["check", "resolve", "release", "reset-to-seed", "grant-logins", "restore", "recover-logins"])
  })

  test("runs the cleanup whatever happened before, and every other phase only while the job has not failed", () => {
    for (const [job, steps] of JOBS) {
      for (const step of steps) {
        const phase = step.run === undefined ? undefined : PHASE_CALL.exec(step.run)?.[2]
        if (phase === undefined) continue
        const cleanup = OPERATIONS.flatMap((operation) => operation.phases).find((candidate) => candidate.name === phase)?.cleanup === true
        assert.equal(/^ {8}if: always\(\)$/m.test(step.text), cleanup, `${job}'s ${phase}`)
        assert.doesNotMatch(step.text.replace(/^ {8}if: always\(\)$/m, ""), /^ {8}if:/m, `${job}'s ${phase} decides for itself whether it has anything to do`)
      }
    }
  })

  test("types no file or artifact name: a store or a download takes it from the phase before", () => {
    for (const name of ["login-state.json", ".tar.age", "pilot-backup-$", "login-state-$", "runner.temp", "RUNNER_TEMP"]) assert.ok(!workflow.includes(name), name)
    for (const [job, steps] of JOBS) {
      for (const step of steps.filter((candidate) => candidate.uses !== undefined && /artifact|pilot-backup|write-barrier/.test(candidate.uses))) {
        for (const [input, value] of step.with) {
          if (input === "github-token" || input === "digest-mismatch" || input === "run-id") continue
          assert.match(value, /^\$\{\{ steps\.[a-z]+\.outputs\.[a-z]+ \}\}$/, `${job}: ${step.uses} ${input}`)
        }
      }
    }
  })

  test("hands a secret only to a phase, as its step's environment", () => {
    for (const [job, steps] of JOBS) {
      for (const step of steps) {
        if (!step.text.includes("secrets.")) continue
        assert.ok(step.run !== undefined && PHASE_CALL.test(step.run), `${job}: a secret reaches a step that runs no phase`)
        for (const line of step.text.split("\n").filter((candidate) => candidate.includes("secrets."))) assert.match(line, /^ {10}[A-Z_]+: \$\{\{ secrets\.[A-Z_]+ \}\}$/, `${job}: ${line.trim()}`)
      }
    }
  })

  test("gives grant-logins the owner's URL and one secret for every role the table gives a URL of its own, each under its own name", () => {
    const [grant] = (JOBS.get("grant-logins") ?? []).filter((step) => step.run !== undefined)
    assert.deepEqual(Object.fromEntries(grant.env), {
      [OWNER.urls.local]: `\${{ secrets.${OWNER.urls.pilot} }}`,
      ...Object.fromEntries(GRANTED_ROLES.map((role) => [role.urls.pilot, `\${{ secrets.${role.urls.pilot} }}`])),
    })
  })
})
