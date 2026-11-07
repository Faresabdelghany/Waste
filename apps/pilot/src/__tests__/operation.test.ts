// An operation's admission (Issue #152): before any of its phases runs, the
// run is on main where the Pilot is the target, and the inputs its operation
// needs say what they must — the services stopped, a source run named — each
// refused with the sentence the workflow's own steps once said. The cleanup
// runs whatever came before.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { createContext, Refusal, removePlaintext, type Environment } from "@waste/db/pilot/phase"

import { admitting, fromMain, runPhase, servicesSuspended, sourceRunNamed, type Operation } from "../operation"

const REF = "abcdefghijklmnopqrst"
const quiet = (env: Environment) => createContext({ env, temp: "/runner/_temp", log: () => {} })

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
