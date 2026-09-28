// Which run a restore or a recovery may read from (Issue #152): a run of the
// protected workflow on main, dispatched by hand, and the newest valid
// artifact of the kind asked for among its attempts. The GitHub API answers
// are scripted; the shapes are the REST API's.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { checkSourceRun, fetchSourceArtifact, selectArtifact, type RunArtifact, type WorkflowRun } from "../pilot/github"

const RUN: WorkflowRun = {
  id: 18000000001,
  path: ".github/workflows/pilot-database.yml",
  head_branch: "main",
  head_sha: "5f1501d6a2b3c4d5e6f708192a3b4c5d6e7f8091",
  event: "workflow_dispatch",
  repository: { full_name: "Faresabdelghany/Waste" },
}
const artifact = (name: string, overrides: Partial<RunArtifact> = {}): RunArtifact => ({
  id: 1,
  name,
  expired: false,
  created_at: "2026-09-29T08:00:00Z",
  workflow_run: { id: RUN.id, head_branch: "main", head_sha: RUN.head_sha },
  ...overrides,
})
const expected = { repository: "Faresabdelghany/Waste", workflowPath: ".github/workflows/pilot-database.yml" }

describe("checkSourceRun", () => {
  test("takes a dispatched run of this workflow on main", () => {
    assert.doesNotThrow(() => checkSourceRun(RUN, expected))
  })

  test("refuses another workflow, another branch, another trigger and another repository", () => {
    assert.throws(() => checkSourceRun({ ...RUN, path: ".github/workflows/ci.yml" }, expected), /Run 18000000001 is a run of \.github\/workflows\/ci\.yml, not of \.github\/workflows\/pilot-database\.yml/)
    assert.throws(() => checkSourceRun({ ...RUN, head_branch: "db/152" }, expected), /Run 18000000001 ran on db\/152, not main/)
    assert.throws(() => checkSourceRun({ ...RUN, event: "push" }, expected), /Run 18000000001 was triggered by push, not by hand/)
    assert.throws(() => checkSourceRun({ ...RUN, repository: { full_name: "someone/fork" } }, expected), /Run 18000000001 is a run of someone\/fork/)
  })
})

describe("selectArtifact", () => {
  test("picks the newest attempt's artifact of the kind among the run's", () => {
    const picked = selectArtifact(
      [artifact(`pilot-backup-${RUN.id}-1`, { id: 11 }), artifact(`login-state-${RUN.id}-1`, { id: 12 }), artifact(`pilot-backup-${RUN.id}-2`, { id: 13 }), artifact("playwright-report", { id: 14 })],
      { prefix: "pilot-backup", run: RUN },
    )
    assert.deepEqual(picked, { id: 13, name: `pilot-backup-${RUN.id}-2`, attempt: "2" })
  })

  test("refuses none, an expired newest one, one from another run and an ambiguous pair", () => {
    assert.throws(() => selectArtifact([artifact("playwright-report")], { prefix: "login-state", run: RUN }), /Run 18000000001 has no login-state artifact/)
    assert.throws(() => selectArtifact([artifact(`login-state-${RUN.id}-1`, { expired: true })], { prefix: "login-state", run: RUN }), /login-state-18000000001-1 has expired/)
    assert.throws(
      () => selectArtifact([artifact(`login-state-${RUN.id}-1`, { workflow_run: { id: 7, head_branch: "main", head_sha: RUN.head_sha } })], { prefix: "login-state", run: RUN }),
      /login-state-18000000001-1 was uploaded by run 7/,
    )
    assert.throws(() => selectArtifact([artifact(`login-state-${RUN.id}-2`, { id: 1 }), artifact(`login-state-${RUN.id}-2`, { id: 2 })], { prefix: "login-state", run: RUN }), /2 artifacts are named login-state-18000000001-2/)
  })
})

describe("fetchSourceArtifact", () => {
  test("reads the run and its artifacts through the API with the token, and answers the pick with the run's commit", async () => {
    const asked: string[] = []
    const fetch = async (input: URL | string, init?: RequestInit) => {
      asked.push(`${String(input)} ${new Headers(init?.headers).get("authorization")}`)
      const url = new URL(String(input))
      const body = url.pathname.endsWith("/artifacts") ? { total_count: 1, artifacts: [artifact(`login-state-${RUN.id}-1`, { id: 77 })] } : RUN
      return new Response(JSON.stringify(body), { status: 200 })
    }
    const pick = await fetchSourceArtifact({ api: "https://api.github.com", token: "t0ken", runId: String(RUN.id), prefix: "login-state", ...expected, fetch })
    assert.deepEqual(pick, { id: 77, name: `login-state-${RUN.id}-1`, attempt: "1", commit: RUN.head_sha })
    assert.deepEqual(asked, [
      `https://api.github.com/repos/Faresabdelghany/Waste/actions/runs/18000000001 Bearer t0ken`,
      `https://api.github.com/repos/Faresabdelghany/Waste/actions/runs/18000000001/artifacts?per_page=100 Bearer t0ken`,
    ])
    await assert.rejects(fetchSourceArtifact({ api: "https://api.github.com", token: "t", runId: "18000000001; rm", prefix: "login-state", ...expected, fetch }), /is not a run id/)
  })
})
