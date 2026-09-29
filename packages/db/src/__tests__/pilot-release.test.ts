// The release's last two steps (Issue #152): the Render deploy hook called
// with the image by digest, and the proof that the released build answers —
// three consecutive observations ten seconds apart, each /healthz 200 naming
// the released commit with a fresh, advancing clock and /readyz 200, both
// uncached. The observer runs here over a scripted API and a pinned clock, so
// every reason a count resets is its own case.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { judgeObservation, observeRelease, triggerDeploy, type Observation } from "../pilot/release"

const COMMIT = "5f1501d6a2b3c4d5e6f708192a3b4c5d6e7f8091"
const OLD = "21e7e2c0c8f1b4d9a3e5f6a7b8c9d0e1f2a3b4c5"
const IMAGE = `ghcr.io/faresabdelghany/waste-pilot@sha256:${"a".repeat(64)}`

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
        apiUrl: "https://waste-pilot.onrender.com",
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

  test("fails after ten minutes naming the commit and the last thing it saw", async () => {
    const api = scripted([{ healthz: "fail", readyz: ready }])
    await assert.rejects(observeRelease({ ...api.options, image: IMAGE }), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /No three consecutive observations of build 5f1501d6a2b3c4d5e6f708192a3b4c5d6e7f8091 \(ghcr\.io\/faresabdelghany\/waste-pilot@sha256:a{64}\) within 600 s/)
      assert.match(error.message, /last: GET \/healthz failed: connect ECONNREFUSED/)
      return true
    })
  })
})

describe("triggerDeploy", () => {
  const HOOK = "https://api.render.com/deploy/srv-abc123?key=k3y"
  // A fetch that records the request and answers as told: the hook's URL is a secret, so no request leaves the test.
  const recording = (status: number, body: unknown) => {
    const calls: { url: string; method: string }[] = []
    const fetch = async (input: URL | string, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" })
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
    }
    return { calls, fetch }
  }

  test("posts the hook with the image by digest and answers the deploy id", async () => {
    const render = recording(200, { deploy: { id: "dep-d3adb33f" } })
    assert.deepEqual(await triggerDeploy(HOOK, IMAGE, { fetch: render.fetch }), { deployId: "dep-d3adb33f" })
    const [call] = render.calls
    assert.equal(call.method, "POST")
    const url = new URL(call.url)
    assert.equal(url.origin + url.pathname, "https://api.render.com/deploy/srv-abc123")
    assert.equal(url.searchParams.get("key"), "k3y")
    assert.equal(url.searchParams.get("imgURL"), IMAGE)
  })

  test("refuses an image not pinned by digest, a hook that is not Render's, a refusal and an answer without an id, never printing the hook", async () => {
    const unused = recording(200, {})
    await assert.rejects(triggerDeploy(HOOK, "ghcr.io/faresabdelghany/waste-pilot:main", { fetch: unused.fetch }), /is not an image pinned by digest/)
    for (const hook of ["https://example.com/deploy/srv-abc?key=secret", "http://api.render.com/deploy/srv-abc?key=secret", "https://api.render.com/deploy/srv-abc"]) {
      await assert.rejects(triggerDeploy(hook, IMAGE, { fetch: unused.fetch }), (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /PILOT_RENDER_DEPLOY_HOOK is not a Render deploy hook/)
        assert.doesNotMatch(error.message, /secret/)
        return true
      })
    }
    assert.equal(unused.calls.length, 0)
    await assert.rejects(triggerDeploy("https://api.render.com/deploy/srv-abc?key=secret", IMAGE, { fetch: recording(404, "not found").fetch }), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, "The deploy hook answered 404")
      return true
    })
    await assert.rejects(triggerDeploy(HOOK, IMAGE, { fetch: recording(200, { ok: true }).fetch }), /The deploy hook answered no deploy id/)
  })
})
