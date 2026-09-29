// The supervisor's rules (#128 Q6–Q7, measured in #134) over real children:
// `node -e` scripts standing in for the API and the worker, with small
// timings in place of the decision's 5 s / 5 min / 10 min / 20 s.
import assert from "node:assert/strict"
import { spawn as nodeSpawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { describe, test } from "node:test"

import { supervise, TIMINGS, type ChildSpec, type Timings } from "../supervise"

const SMALL: Timings = { backoffInitialMs: 50, backoffMaxMs: 200, healthyAfterMs: 300, killAfterMs: 400 }

const SCRIPTS = {
  alive: `process.on("SIGTERM", () => { console.log("got SIGTERM"); process.exit(0) }); console.log("up"); setInterval(() => {}, 1000)`,
  exitsAtOnce: `process.exit(2)`,
  exitsLater: `setTimeout(() => process.exit(3), 100); setInterval(() => {}, 1000)`,
  healthyThenExits: `process.on("SIGTERM", () => process.exit(0)); setTimeout(() => process.exit(0), 400); setInterval(() => {}, 1000)`,
  stubborn: `process.on("SIGTERM", () => console.log("ignoring SIGTERM")); console.log("up"); setInterval(() => {}, 1000)`,
  toStderr: `console.error("a warning"); process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000)`,
}

const child = (name: string, script: string): ChildSpec => ({ name, command: process.execPath, args: ["-e", script], env: { PILOT_ROLE: name } })

/** Lines written, split on newlines; the supervisor writes whole lines. */
const collector = () => {
  const lines: string[] = []
  return { lines, write: (text: string) => void lines.push(...text.split("\n").filter(Boolean)) }
}

const until = async (predicate: () => boolean, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const restartDelays = (lines: string[]) => lines.filter((line) => line.includes("restarting in")).map((line) => Number(/restarting in ([\d.]+) s/.exec(line)![1]))

describe("supervise", () => {
  test("the decision's timings: 5 s doubling to 5 min, reset after 10 min up, 20 s before a kill", () => {
    assert.deepEqual(TIMINGS, { backoffInitialMs: 5_000, backoffMaxMs: 300_000, healthyAfterMs: 600_000, killAfterMs: 20_000 })
  })

  test("prefixes each child's output with its name, stderr included, and forwards SIGTERM to both children once, exiting 0", async () => {
    const out = collector()
    const err = collector()
    const signals = new EventEmitter()
    const done = supervise({ api: child("api", SCRIPTS.alive), worker: child("worker", SCRIPTS.toStderr), timings: SMALL, signals, out, err })
    await until(() => out.lines.includes("[api] up") && err.lines.includes("[worker] a warning"))
    signals.emit("SIGTERM")
    signals.emit("SIGTERM")
    assert.equal(await done, 0)
    assert.equal(out.lines.filter((line) => line === "[api] got SIGTERM").length, 1, "the API saw the signal once")
    assert.ok(out.lines.some((line) => line.startsWith("[pilot] SIGTERM received")))
    assert.ok(out.lines.includes("[pilot] exiting with 0"))
  })

  test("restarts the worker with doubling backoff up to the cap while the API keeps running", async () => {
    const out = collector()
    const signals = new EventEmitter()
    const done = supervise({ api: child("api", SCRIPTS.alive), worker: child("worker", SCRIPTS.exitsAtOnce), timings: SMALL, signals, out, err: out })
    await until(() => restartDelays(out.lines).length >= 4)
    assert.deepEqual(restartDelays(out.lines).slice(0, 4), [0.05, 0.1, 0.2, 0.2])
    assert.ok(out.lines.some((line) => /^\[pilot\] worker exited code=2 signal=null after [\d.]+ s; restarting in 0\.05 s$/.test(line)))
    assert.ok(out.lines.filter((line) => line.startsWith("[pilot] worker started pid=")).length >= 4)
    assert.equal(out.lines.filter((line) => line.startsWith("[pilot] api started pid=")).length, 1, "the API was started once and never restarted")
    signals.emit("SIGTERM")
    assert.equal(await done, 0)
  })

  test("resets the backoff to its initial delay once a worker run lasted past healthyAfterMs", async () => {
    const out = collector()
    const signals = new EventEmitter()
    let workerSpawns = 0
    const spawn: typeof nodeSpawn = ((command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      if (options.env?.PILOT_ROLE !== "worker") return nodeSpawn(command, args, options)
      workerSpawns += 1
      // The first two runs die at once; the third lives past healthyAfterMs; the fourth dies at once again.
      const script = workerSpawns === 3 ? SCRIPTS.healthyThenExits : SCRIPTS.exitsAtOnce
      return nodeSpawn(command, ["-e", script], options)
    }) as typeof nodeSpawn
    const done = supervise({ api: child("api", SCRIPTS.alive), worker: child("worker", SCRIPTS.exitsAtOnce), spawn, timings: SMALL, signals, out, err: out })
    await until(() => restartDelays(out.lines).length >= 4)
    assert.deepEqual(restartDelays(out.lines).slice(0, 4), [0.05, 0.1, 0.05, 0.1])
    signals.emit("SIGTERM")
    assert.equal(await done, 0)
  })

  test("exits with the API's code once the API exits, stopping the worker first and restarting nothing", async () => {
    const out = collector()
    const done = supervise({ api: child("api", SCRIPTS.exitsLater), worker: child("worker", SCRIPTS.alive), timings: SMALL, signals: new EventEmitter(), out, err: out })
    assert.equal(await done, 3)
    assert.ok(out.lines.some((line) => line.startsWith("[pilot] api exited code=3 signal=null; stopping the worker")))
    assert.equal(out.lines.filter((line) => line === "[worker] got SIGTERM").length, 1)
    assert.equal(restartDelays(out.lines).length, 0)
    assert.ok(out.lines.includes("[pilot] exiting with 3"))
  })

  test("exits as the shell reports a signalled API: 128 plus the signal's number", async () => {
    const out = collector()
    const signals = new EventEmitter()
    const done = supervise({ api: child("api", SCRIPTS.stubborn), worker: child("worker", SCRIPTS.alive), timings: SMALL, signals, out, err: out })
    await until(() => out.lines.includes("[api] up"))
    signals.emit("SIGTERM")
    // The API ignores SIGTERM and is killed after killAfterMs: SIGKILL is 9.
    assert.equal(await done, 137)
    assert.ok(out.lines.some((line) => line.startsWith("[pilot] api exited code=null signal=SIGKILL")))
  })

  test("kills a child that ignores the forwarded signal after killAfterMs, and says so", async () => {
    const out = collector()
    const signals = new EventEmitter()
    const done = supervise({ api: child("api", SCRIPTS.alive), worker: child("worker", SCRIPTS.stubborn), timings: SMALL, signals, out, err: out })
    await until(() => out.lines.includes("[worker] up") && out.lines.includes("[api] up"))
    const startedAt = Date.now()
    signals.emit("SIGTERM")
    assert.equal(await done, 0)
    assert.ok(Date.now() - startedAt < 2_000, "the kill came with the grace, not later")
    assert.ok(out.lines.includes("[worker] ignoring SIGTERM"))
    assert.ok(out.lines.some((line) => line.startsWith("[pilot] worker did not exit within 400 ms after SIGTERM; killing it")))
    assert.ok(out.lines.some((line) => line.startsWith("[pilot] worker exited code=null signal=SIGKILL")))
  })

  test("a child's environment is the supervisor's with the spec's values over it", async () => {
    const out = collector()
    const signals = new EventEmitter()
    const echo = `console.log("PORT=" + process.env.PORT + " PATH=" + (process.env.PATH ? "inherited" : "missing")); process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000)`
    const done = supervise({
      api: { ...child("api", echo), env: { PORT: "4001" } },
      worker: { ...child("worker", echo), env: { PORT: "4002" } },
      timings: SMALL,
      signals,
      out,
      err: out,
    })
    await until(() => out.lines.includes("[api] PORT=4001 PATH=inherited") && out.lines.includes("[worker] PORT=4002 PATH=inherited"))
    signals.emit("SIGTERM")
    assert.equal(await done, 0)
  })
})
