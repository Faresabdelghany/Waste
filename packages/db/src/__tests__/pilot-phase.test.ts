// What every phase of a Pilot operation is given (Issue #152): the run it
// belongs to, the owner's URL held to the Pilot or the local stack on every
// read, the admission its operation asks, and the names of the files and
// artifacts the workflow moves between phases — the names the workflow once
// typed itself, which restores and recoveries of runs already stored still
// read.
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, test } from "node:test"

import {
  admitting,
  artifactName,
  artifactsOf,
  BACKUP_ARTIFACT,
  createContext,
  fromMain,
  LOGIN_STATE_ARTIFACT,
  readSourceRun,
  Refusal,
  removePlaintext,
  runPhase,
  servicesSuspended,
  sourceRunNamed,
  theOneFile,
  writeSourceRun,
  type Environment,
  type Operation,
} from "../pilot/phase"
import { LOCAL_RUN } from "../pilot/run"

const REF = "abcdefghijklmnopqrst"
const PILOT_URL = `postgresql://postgres.${REF}:secret@aws-0-eu-north-1.pooler.supabase.com:5432/postgres`
const LOCAL_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
const WORKFLOW_RUN = { GITHUB_RUN_ID: "18000000001", GITHUB_RUN_ATTEMPT: "2", GITHUB_SHA: "5f1501d6a2b3c4d5e6f708192a3b4c5d6e7f8091" }

const quiet = (env: Environment) => createContext({ env, temp: "/runner/_temp", log: () => {} })

describe("a phase's context", () => {
  test("belongs to the workflow's run where Actions names one, and to the local run outside it", () => {
    const workflow = quiet(WORKFLOW_RUN)
    assert.deepEqual([workflow.run, workflow.commit], [{ id: "18000000001", attempt: "2" }, WORKFLOW_RUN.GITHUB_SHA])
    const local = quiet({})
    assert.deepEqual([local.run, local.commit], [LOCAL_RUN.run, LOCAL_RUN.commit])
  })

  test("hands out the owner's URL only held to the Pilot's Supabase project, or without one to the local stack, on every read", () => {
    assert.equal(quiet({ DATABASE_ADMIN_URL: PILOT_URL, PILOT_SUPABASE_REF: REF }).adminUrl(), PILOT_URL)
    assert.equal(quiet({ DATABASE_ADMIN_URL: LOCAL_URL }).adminUrl(), LOCAL_URL)
    assert.throws(() => quiet({ DATABASE_ADMIN_URL: PILOT_URL }).adminUrl(), /PILOT_SUPABASE_REF is not set: outside the protected workflow a Pilot operation runs against the local stack only/)
    assert.throws(() => quiet({ DATABASE_ADMIN_URL: PILOT_URL, PILOT_SUPABASE_REF: "zyxwvutsrqponmlkjihg" }).adminUrl(), /not the Pilot's \(zyxwvutsrqponmlkjihg\)/)
    assert.throws(() => quiet({ DATABASE_ADMIN_URL: LOCAL_URL, PILOT_SUPABASE_REF: REF }).adminUrl(), /points at the local stack, not the Pilot's/)
    assert.throws(() => quiet({}).adminUrl(), /^Error: DATABASE_ADMIN_URL is not set$/)
  })

  test("writes a step output and a summary line where the workflow reads them", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "waste-phase-"))
    try {
      const files = { GITHUB_OUTPUT: path.join(dir, "output"), GITHUB_STEP_SUMMARY: path.join(dir, "summary") }
      const logged: string[] = []
      const context = createContext({ env: files, log: (line) => logged.push(line) })
      context.output("taken", "true")
      context.summary("Backed up.")
      assert.equal(readFileSync(files.GITHUB_OUTPUT, "utf8"), "taken=true\n")
      assert.equal(readFileSync(files.GITHUB_STEP_SUMMARY, "utf8"), "Backed up.\n")
      assert.deepEqual(logged, ["Backed up."])
      assert.throws(() => context.output("taken", "a\nb"), /spans lines/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("the layout", () => {
  test("names every artifact and file as the workflow always stored them, so an earlier run's are found by the same names", () => {
    const { layout } = quiet(WORKFLOW_RUN)
    assert.deepEqual(layout.backup, { artifact: "pilot-backup-18000000001-2", file: "/runner/_temp/pilot-backup/pilot-backup-18000000001-2.tar.age" })
    assert.deepEqual(layout.loginState, { artifact: "login-state-18000000001-2", file: "/runner/_temp/login-state/login-state.json", copy: "/runner/_temp/login-state-copy" })
    assert.deepEqual(layout.source(BACKUP_ARTIFACT), { dir: "/runner/_temp/pilot-source", pick: "/runner/_temp/pilot-source.json" })
    assert.deepEqual(layout.source(LOGIN_STATE_ARTIFACT), { dir: "/runner/_temp/login-state-source", pick: "/runner/_temp/login-state-source.json" })
    assert.equal(layout.restore, "/runner/_temp/pilot-restore")
  })

  test("reads an artifact's attempt back from the name it was given, and only for its own kind and run", () => {
    const name = artifactName(LOGIN_STATE_ARTIFACT, { id: "18000000001", attempt: "3" })
    assert.equal(artifactsOf(LOGIN_STATE_ARTIFACT, "18000000001").exec(name)?.[1], "3")
    assert.equal(artifactsOf(BACKUP_ARTIFACT, "18000000001").test(name), false)
    assert.equal(artifactsOf(LOGIN_STATE_ARTIFACT, "1800000000").test(name), false)
  })

  test("finds the one file a downloaded artifact holds, at its top or one directory down, and refuses none or two", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "waste-download-"))
    try {
      assert.throws(() => theOneFile(path.join(dir, "absent"), (name) => name.endsWith(".tar.age"), "encrypted backups"), /holds 0 encrypted backups, not one/)
      mkdirSync(path.join(dir, "inner"))
      writeFileSync(path.join(dir, "inner", "pilot-backup-1-1.tar.age"), "x")
      writeFileSync(path.join(dir, "notes.txt"), "x")
      assert.equal(theOneFile(dir, (name) => name.endsWith(".tar.age"), "encrypted backups"), path.join(dir, "inner", "pilot-backup-1-1.tar.age"))
      writeFileSync(path.join(dir, "pilot-backup-1-2.tar.age"), "x")
      assert.throws(() => theOneFile(dir, (name) => name.endsWith(".tar.age"), "encrypted backups"), /holds 2 encrypted backups, not one/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("keeps a restore's choice of source run for the phases after the download, refusing one of another run", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "waste-source-"))
    try {
      const context = createContext({ env: { SOURCE_RUN_ID: "18000000001" }, temp: dir, log: () => {} })
      const source = { run: { id: "18000000001", attempt: "2" }, commit: WORKFLOW_RUN.GITHUB_SHA, artifact: { id: 77, name: "pilot-backup-18000000001-2" } }
      writeSourceRun(context, BACKUP_ARTIFACT, source)
      assert.deepEqual(readSourceRun(context, BACKUP_ARTIFACT), source)
      const other = createContext({ env: { SOURCE_RUN_ID: "18000000002" }, temp: dir, log: () => {} })
      assert.throws(() => readSourceRun(other, BACKUP_ARTIFACT), /is of run 18000000001, not the source run 18000000002/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("removes every plaintext directory and the scripts' own temporary ones, and nothing else", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "waste-plaintext-"))
    try {
      for (const name of ["pilot-backup", "pilot-restore", "pilot-source", "pilot-backup.Ab12Cd", "pilot-restore-key.Ef34Gh", "login-state", "login-state-copy"]) mkdirSync(path.join(dir, name))
      await removePlaintext.run(createContext({ env: {}, temp: dir, log: () => {} }))
      assert.deepEqual(readdirSync(dir).sort(), ["login-state", "login-state-copy"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("admission", () => {
  const ran: string[] = []
  const operation: Operation = {
    name: "restore",
    admit: admitting(fromMain("The Pilot's database is operated from main only"), servicesSuspended("restore"), sourceRunNamed),
    phases: [
      { name: "choose", run: async () => void ran.push("choose") },
      { ...removePlaintext, run: async () => void ran.push("remove-plaintext") },
    ],
  }
  const [choose, cleanup] = operation.phases
  const admitted = { PILOT_SUPABASE_REF: REF, GITHUB_REF: "refs/heads/main", SERVICES_SUSPENDED: "true", SOURCE_RUN_ID: "18000000001" }

  test("holds every phase to main where the Pilot is the target, and to its operation's inputs, before it runs", async () => {
    await runPhase(operation, choose, quiet(admitted))
    assert.deepEqual(ran.splice(0), ["choose"])
    const refusals: [Environment, RegExp][] = [
      [{ ...admitted, GITHUB_REF: "refs/heads/db/152" }, /^The Pilot's database is operated from main only$/],
      [{ ...admitted, SERVICES_SUSPENDED: "false" }, /^Stop the Pilot's Suga service first, then dispatch the restore with services_suspended on$/],
      [{ ...admitted, SOURCE_RUN_ID: "18000000001; rm" }, /^source_run_id names no run$/],
      [{ ...admitted, SOURCE_RUN_ID: "" }, /^source_run_id names no run$/],
    ]
    for (const [env, reason] of refusals) {
      await assert.rejects(runPhase(operation, choose, quiet(env)), (error: unknown) => error instanceof Refusal && reason.test(error.message))
    }
    assert.deepEqual(ran, [], "no refused phase ran")
  })

  test("asks no ref off the Pilot, so the rehearsal runs on any branch, and lets a cleanup run whatever came before", async () => {
    await runPhase(operation, choose, quiet({ GITHUB_REF: "refs/pull/600/merge", SERVICES_SUSPENDED: "true", SOURCE_RUN_ID: "0" }))
    await runPhase(operation, cleanup, quiet({ PILOT_SUPABASE_REF: REF, GITHUB_REF: "refs/heads/db/152" }))
    assert.deepEqual(ran.splice(0), ["choose", "remove-plaintext"])
  })
})
