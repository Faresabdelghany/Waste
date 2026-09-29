// The release's last two steps (Issue #152, rewritten for Suga in #149): one
// release commit written on the deploy branch `pilot` through GitHub's git
// data API — main's tree plus apps/pilot/release.json naming the released
// commit, which the image turns into build.json — and the proof that the
// released build answers: three consecutive observations ten seconds apart,
// each /healthz 200 naming the released commit with a fresh, advancing clock
// and /readyz 200, both uncached. The observer runs here over a scripted API
// and a pinned clock, so every reason a count resets is its own case; the
// release commit over a recording GitHub, so the token leaves no test.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { judgeObservation, observeRelease, releaseToDeployBranch, type Observation } from "../pilot/release"

const COMMIT = "5f1501d6a2b3c4d5e6f708192a3b4c5d6e7f8091"
const OLD = "21e7e2c0c8f1b4d9a3e5f6a7b8c9d0e1f2a3b4c5"

const answer = (body: unknown, status = 200, cacheControl: string | null = "no-store") => ({ status, cacheControl, body })
const healthy = (time: string, commit = COMMIT) => answer({ status: "ok", time, build: { commit } })
const ready = answer({ status: "ok", checks: { database: "ok" } })
const at = (seconds: number) => new Date(Date.UTC(2026, 8, 29, 9, 0, seconds)).toISOString()
const observation = (seconds: number, overrides: Partial<Observation> = {}): Observation => ({ at: at(seconds), healthz: healthy(at(seconds)), readyz: ready, ...overrides })

describe("judgeObservation", () => {
  test("passes the released build, fresh, ready and uncached", () => {
    assert.deepEqual(judgeObservation(observation(0), { commit: COMMIT, previousTime: null }), { ok: true, time: at(0) })
    assert.deepEqual(judgeObservation(observation(10), { commit: COMMIT, previousTime: at(0) }), { ok: true, time: at(10) })
  })

  test("refuses an old build, a missing one, a stale or unmoved clock, a cached answer and a non-ready or failed probe, each saying why", () => {
    const cases: [Observation, string | null, RegExp][] = [
      [observation(0, { healthz: healthy(at(0), OLD) }), null, /GET \/healthz is build 21e7e2c0c8f1b4d9a3e5f6a7b8c9d0e1f2a3b4c5, not the released 5f1501d/],
      [observation(0, { healthz: answer({ status: "ok", time: at(0), build: null }) }), null, /GET \/healthz names no build/],
      [observation(0, { healthz: answer({ status: "ok", time: at(0) }) }), null, /GET \/healthz answered a body that is not a health response/],
      [observation(120, { healthz: healthy(at(0)) }), null, /GET \/healthz's clock is 120 s away from this runner's/],
      [observation(10), at(10), /GET \/healthz's clock did not advance/],
      [observation(0, { healthz: healthy(at(0)), readyz: answer({ status: "ok", checks: { database: "ok" } }, 200, "max-age=60") }), null, /GET \/readyz answered Cache-Control: max-age=60, not no-store/],
      [observation(0, { healthz: answer({ status: "ok", time: at(0), build: { commit: COMMIT } }, 200, null) }), null, /GET \/healthz answered Cache-Control: none, not no-store/],
      [observation(0, { readyz: answer({ status: "unavailable", checks: { database: "unreachable" } }, 503) }), null, /GET \/readyz answered 503/],
      [observation(0, { healthz: { error: "connect ECONNREFUSED" } }), null, /GET \/healthz failed: connect ECONNREFUSED/],
    ]
    for (const [seen, previousTime, reason] of cases) {
      const verdict = judgeObservation(seen, { commit: COMMIT, previousTime })
      assert.equal(verdict.ok, false, reason.source)
      if (!verdict.ok) assert.match(verdict.reason, reason)
    }
  })
})

describe("observeRelease", () => {
  // A scripted API: each probe answers from the list, one entry per observation; a pinned clock the sleeps move.
  const scripted = (observations: { healthz: ReturnType<typeof answer> | "fail"; readyz: ReturnType<typeof answer> }[]) => {
    let clock = Date.UTC(2026, 8, 29, 9, 0, 0)
    let index = 0
    const log: string[] = []
    return {
      log,
      options: {
        apiUrl: "https://waste-pilot.suga.run",
        commit: COMMIT,
        now: () => new Date(clock),
        sleep: async (ms: number) => {
          clock += ms
        },
        log: (line: string) => log.push(line),
        probe: async (path: "/healthz" | "/readyz") => {
          const entry = observations[Math.min(index, observations.length - 1)]
          if (path === "/readyz") index += 1
          const chosen = path === "/healthz" ? entry.healthz : entry.readyz
          if (chosen === "fail") throw new Error("connect ECONNREFUSED")
          return chosen
        },
      },
      at: (offsetSeconds: number) => new Date(clock + offsetSeconds * 1000).toISOString(),
    }
  }

  test("counts three consecutive good observations ten seconds apart, and a failure in between resets the count", async () => {
    let base = Date.UTC(2026, 8, 29, 9, 0, 0)
    const stamp = () => new Date(base).toISOString()
    const answers: { healthz: ReturnType<typeof answer> | "fail"; readyz: ReturnType<typeof answer> }[] = []
    // good, good, old build (reset), good, good, good
    for (const commit of [COMMIT, COMMIT, OLD, COMMIT, COMMIT, COMMIT]) {
      answers.push({ healthz: healthy(stamp(), commit), readyz: ready })
      base += 10_000
    }
    const api = scripted(answers)
    const result = await observeRelease(api.options)
    assert.deepEqual(result, { observations: 6 })
    assert.match(api.log.join("\n"), /observation 3: not yet — GET \/healthz is build 21e7e2c/)
    assert.match(api.log.join("\n"), /observation 6: 3 of 3/)
  })

  test("waits through the old build Suga is still serving while it builds the new one — every old-build answer is 'not yet' — and passes once the new one answers steadily", async () => {
    let base = Date.UTC(2026, 8, 29, 9, 0, 0)
    const stamp = () => new Date(base).toISOString()
    const answers: { healthz: ReturnType<typeof answer> | "fail"; readyz: ReturnType<typeof answer> }[] = []
    // the old build for a minute, a refused connection during the rollout, then the new build
    for (const commit of [OLD, OLD, OLD, OLD, OLD, OLD, "fail", COMMIT, COMMIT, COMMIT] as const) {
      answers.push({ healthz: commit === "fail" ? "fail" : healthy(stamp(), commit), readyz: ready })
      base += 10_000
    }
    const api = scripted(answers)
    assert.deepEqual(await observeRelease(api.options), { observations: 10 })
    assert.equal(api.log.filter((line) => /not yet — GET \/healthz is build 21e7e2c/.test(line)).length, 6)
    assert.match(api.log.join("\n"), /observation 7: not yet — GET \/healthz failed: connect ECONNREFUSED/)
  })

  test("fails after ten minutes naming the commit and the last thing it saw", async () => {
    const api = scripted([{ healthz: "fail", readyz: ready }])
    await assert.rejects(observeRelease(api.options), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /^No three consecutive observations of build 5f1501d6a2b3c4d5e6f708192a3b4c5d6e7f8091 within 600 s; last: GET \/healthz failed: connect ECONNREFUSED$/)
      return true
    })
  })
})


describe("releaseToDeployBranch", () => {
  const TOKEN = "ghs_s3cr3tT0ken"
  const base = { repository: "faresabdelghany/waste", branch: "pilot", sha: COMMIT, token: TOKEN }
  const TREE = "d7a1e2b3c4d5e6f708192a3b4c5d6e7f80912345"
  const RELEASE_TREE = "e8b2f3c4d5e6f708192a3b4c5d6e7f8091234567"
  const P1 = "f9c3a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5"
  const P2 = "0ad4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6"
  type Call = { url: string; method: string; headers: Record<string, string>; body: unknown }
  /** A GitHub that answers each request from the script, in order, recording what it was asked; the token appears in no message. */
  const github = (script: { status: number; body?: unknown }[]) => {
    const calls: Call[] = []
    const fetch = async (input: URL | string, init?: RequestInit) => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries())
      calls.push({ url: String(input), method: init?.method ?? "GET", headers, body: typeof init?.body === "string" ? JSON.parse(init.body) : null })
      const next = script.shift()
      if (next === undefined) throw new Error(`unexpected request ${init?.method ?? "GET"} ${String(input)}`)
      return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } })
    }
    return { calls, fetch, left: () => script.length }
  }
  const ref = (sha: string) => ({ ref: "refs/heads/pilot", object: { sha, type: "commit" } })
  const contents = (commit: string) => ({ encoding: "base64", content: Buffer.from(`${JSON.stringify({ commit })}\n`).toString("base64") })
  const api = "https://api.github.com/repos/faresabdelghany/waste"

  test("the first release: reads main's tree, writes one commit with that tree plus apps/pilot/release.json naming the released commit, and creates the branch on it", async () => {
    const gh = github([{ status: 404 }, { status: 200, body: { sha: COMMIT, tree: { sha: TREE } } }, { status: 201, body: { sha: RELEASE_TREE } }, { status: 201, body: { sha: P2 } }, { status: 201, body: ref(P2) }])
    assert.deepEqual(await releaseToDeployBranch({ ...base, fetch: gh.fetch }), { moved: true, previous: null, head: P2, commit: COMMIT })
    assert.deepEqual(
      gh.calls.map((call) => [call.method, call.url]),
      [
        ["GET", `${api}/git/ref/heads/pilot`],
        ["GET", `${api}/git/commits/${COMMIT}`],
        ["POST", `${api}/git/trees`],
        ["POST", `${api}/git/commits`],
        ["POST", `${api}/git/refs`],
      ],
    )
    assert.deepEqual(gh.calls[2].body, { base_tree: TREE, tree: [{ path: "apps/pilot/release.json", mode: "100644", type: "blob", content: `{"commit":"${COMMIT}"}\n` }] })
    const commit = gh.calls[3].body as { message: string; tree: string; parents: string[] }
    assert.equal(commit.tree, RELEASE_TREE)
    assert.deepEqual(commit.parents, [COMMIT], "on main's commit alone: the branch starts here")
    assert.match(commit.message, /^Release 5f1501d6a2b3c4d5e6f708192a3b4c5d6e7f8091 to the Pilot\n/)
    assert.deepEqual(gh.calls[4].body, { ref: "refs/heads/pilot", sha: P2 })
    for (const call of gh.calls) {
      assert.equal(call.headers.authorization, `Bearer ${TOKEN}`)
      assert.equal(call.headers.accept, "application/vnd.github+json")
      assert.equal(call.headers["x-github-api-version"], "2022-11-28")
    }
    assert.equal(gh.left(), 0)
  })

  test("a later release: the new commit has the branch's head and the released commit as parents — a fast-forward for the branch, main's history kept — and the ref moves without force", async () => {
    const gh = github([{ status: 200, body: ref(P1) }, { status: 200, body: contents(OLD) }, { status: 200, body: { sha: COMMIT, tree: { sha: TREE } } }, { status: 201, body: { sha: RELEASE_TREE } }, { status: 201, body: { sha: P2 } }, { status: 200, body: ref(P2) }])
    assert.deepEqual(await releaseToDeployBranch({ ...base, fetch: gh.fetch }), { moved: true, previous: OLD, head: P2, commit: COMMIT })
    assert.deepEqual(
      gh.calls.map((call) => [call.method, call.url]),
      [
        ["GET", `${api}/git/ref/heads/pilot`],
        ["GET", `${api}/contents/apps/pilot/release.json?ref=${P1}`],
        ["GET", `${api}/git/commits/${COMMIT}`],
        ["POST", `${api}/git/trees`],
        ["POST", `${api}/git/commits`],
        ["PATCH", `${api}/git/refs/heads/pilot`],
      ],
    )
    assert.deepEqual((gh.calls[4].body as { parents: string[] }).parents, [P1, COMMIT])
    assert.deepEqual(gh.calls[5].body, { sha: P2, force: false })
    assert.equal(gh.left(), 0)
  })

  test("a release dispatched again leaves a branch already naming the released commit alone", async () => {
    const gh = github([{ status: 200, body: ref(P1) }, { status: 200, body: contents(COMMIT) }])
    assert.deepEqual(await releaseToDeployBranch({ ...base, fetch: gh.fetch }), { moved: false, previous: COMMIT, head: P1, commit: COMMIT })
    assert.equal(gh.calls.length, 2)
  })

  test("a branch made by hand, without release.json, is released over like any other: the tree is main's whatever the branch held", async () => {
    const gh = github([{ status: 200, body: ref(P1) }, { status: 404, body: { message: "Not Found" } }, { status: 200, body: { sha: COMMIT, tree: { sha: TREE } } }, { status: 201, body: { sha: RELEASE_TREE } }, { status: 201, body: { sha: P2 } }, { status: 200, body: ref(P2) }])
    assert.deepEqual(await releaseToDeployBranch({ ...base, fetch: gh.fetch }), { moved: true, previous: null, head: P2, commit: COMMIT })
    assert.deepEqual((gh.calls[4].body as { parents: string[] }).parents, [P1, COMMIT])
  })

  test("refuses a released commit the repository does not have, before writing anything", async () => {
    const gh = github([{ status: 404 }, { status: 422, body: { message: "No commit found for SHA: 5f1501d6a2b3c4d5e6f708192a3b4c5d6e7f8091" } }])
    await assert.rejects(releaseToDeployBranch({ ...base, fetch: gh.fetch }), /GitHub answered 422 reading commit 5f1501d6a2b3c4d5e6f708192a3b4c5d6e7f8091: No commit found for SHA/)
    assert.equal(gh.calls.length, 2)
  })

  test("refuses inputs that are not a repository, a commit or a token before any request, and never prints the token", async () => {
    const gh = github([])
    await assert.rejects(releaseToDeployBranch({ ...base, repository: "waste", fetch: gh.fetch }), /GITHUB_REPOSITORY is not <owner>\/<name>: waste/)
    await assert.rejects(releaseToDeployBranch({ ...base, sha: "abc123", fetch: gh.fetch }), /RELEASE_COMMIT is not a full commit id/)
    await assert.rejects(releaseToDeployBranch({ ...base, branch: "refs/heads/pilot", fetch: gh.fetch }), /PILOT_DEPLOY_BRANCH is not a plain branch name/)
    await assert.rejects(releaseToDeployBranch({ ...base, token: "", fetch: gh.fetch }), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /GITHUB_TOKEN is not set/)
      return true
    })
    assert.equal(gh.calls.length, 0)
  })

  test("names an unexpected answer from GitHub — reading the branch, writing the tree or the commit, moving the ref — with its status and GitHub's message, never the token", async () => {
    const step = async (script: { status: number; body?: unknown }[], expected: RegExp) => {
      const gh = github(script)
      await assert.rejects(releaseToDeployBranch({ ...base, fetch: gh.fetch }), (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, expected)
        assert.doesNotMatch(error.message, /s3cr3t/)
        return true
      })
    }
    const denied = { status: 403, body: { message: "Resource not accessible by integration" } }
    await step([denied], /GitHub answered 403 reading refs\/heads\/pilot: Resource not accessible by integration/)
    await step([{ status: 404 }, { status: 200, body: { sha: COMMIT, tree: { sha: TREE } } }, denied], /GitHub answered 403 writing the release tree: Resource not accessible/)
    await step([{ status: 404 }, { status: 200, body: { sha: COMMIT, tree: { sha: TREE } } }, { status: 201, body: { sha: RELEASE_TREE } }, denied], /GitHub answered 403 writing the release commit: Resource not accessible/)
    await step([{ status: 404 }, { status: 200, body: { sha: COMMIT, tree: { sha: TREE } } }, { status: 201, body: { sha: RELEASE_TREE } }, { status: 201, body: { sha: P2 } }, denied], /GitHub answered 403 creating refs\/heads\/pilot: Resource not accessible/)
    await step(
      [{ status: 200, body: ref(P1) }, { status: 404 }, { status: 200, body: { sha: COMMIT, tree: { sha: TREE } } }, { status: 201, body: { sha: RELEASE_TREE } }, { status: 201, body: { sha: P2 } }, { status: 422, body: { message: "Update is not a fast forward" } }],
      /GitHub answered 422 moving refs\/heads\/pilot: Update is not a fast forward/,
    )
  })
})
