// PROTOTYPE — throwaway (#134). The supervisor's rules over fake children
// (`node -e` scripts) with small timings. Run: node --test apps/pilot/
import assert from "node:assert/strict"
import { spawn as nodeSpawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { test } from "node:test"

import { supervise } from "./supervise.mjs"

const TIMINGS = { backoffInitialMs: 50, backoffMaxMs: 200, healthyAfterMs: 300, killAfterMs: 400 }

const SCRIPTS = {
  alive: `process.on("SIGTERM", () => { console.log("got SIGTERM"); process.exit(0) }); console.log("up"); setInterval(() => {}, 1000)`,
  exitsAtOnce: `process.exit(2)`,
  exitsLater: `setTimeout(() => process.exit(3), 100); setInterval(() => {}, 1000)`,
  healthyThenExits: `process.on("SIGTERM", () => process.exit(0)); setTimeout(() => process.exit(0), 400); setInterval(() => {}, 1000)`,
  stubborn: `process.on("SIGTERM", () => console.log("ignoring SIGTERM")); console.log("up"); setInterval(() => {}, 1000)`,
}

const child = (name, script) => ({ name, command: process.execPath, args: ["-e", script], env: { PILOT_ROLE: name } })

const collector = () => {
  const lines = []
  return { lines, write: (s) => void lines.push(...s.split("\n").filter(Boolean)) }
}

const until = async (predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting")
    await new Promise((r) => setTimeout(r, 10))
  }
}

const restartDelays = (lines) => lines.filter((l) => l.includes("restarting in")).map((l) => Number(/restarting in ([\d.]+) s/.exec(l)[1]))

test("prefixes each child's output and forwards SIGTERM to both, once", async () => {
  const out = collector()
  const signals = new EventEmitter()
  const done = supervise({ api: child("api", SCRIPTS.alive), worker: child("worker", SCRIPTS.alive), timings: TIMINGS, signals, out, err: out })
  await until(() => out.lines.includes("[api] up") && out.lines.includes("[worker] up"))
  signals.emit("SIGTERM")
  signals.emit("SIGTERM")
  assert.equal(await done, 0)
  assert.equal(out.lines.filter((l) => l === "[api] got SIGTERM").length, 1)
  assert.equal(out.lines.filter((l) => l === "[worker] got SIGTERM").length, 1)
  assert.ok(out.lines.some((l) => l.startsWith("[pilot] SIGTERM received")))
  assert.ok(out.lines.includes("[pilot] exiting with 0"))
})

test("restarts the worker with doubling backoff up to the cap while the API runs", async () => {
  const out = collector()
  const signals = new EventEmitter()
  const done = supervise({ api: child("api", SCRIPTS.alive), worker: child("worker", SCRIPTS.exitsAtOnce), timings: TIMINGS, signals, out, err: out })
  await until(() => restartDelays(out.lines).length >= 4)
  assert.deepEqual(restartDelays(out.lines).slice(0, 4), [0.05, 0.1, 0.2, 0.2])
  assert.ok(out.lines.filter((l) => l.startsWith("[pilot] worker started")).length >= 4)
  signals.emit("SIGTERM")
  assert.equal(await done, 0)
})

test("resets the backoff after a healthy worker run", async () => {
  const out = collector()
  const signals = new EventEmitter()
  let workerSpawns = 0
  const spawn = (command, args, options) => {
    if (options.env.PILOT_ROLE !== "worker") return nodeSpawn(command, args, options)
    workerSpawns += 1
    // the first two runs die at once, the third lives past healthyAfterMs
    const script = workerSpawns === 3 ? SCRIPTS.healthyThenExits : SCRIPTS.exitsAtOnce
    return nodeSpawn(command, ["-e", script], options)
  }
  const done = supervise({ api: child("api", SCRIPTS.alive), worker: child("worker", SCRIPTS.exitsAtOnce), spawn, timings: TIMINGS, signals, out, err: out })
  await until(() => restartDelays(out.lines).length >= 4)
  assert.deepEqual(restartDelays(out.lines).slice(0, 4), [0.05, 0.1, 0.05, 0.1])
  signals.emit("SIGTERM")
  assert.equal(await done, 0)
})

test("exits with the API's code once the API exits, stopping the worker first", async () => {
  const out = collector()
  const done = supervise({ api: child("api", SCRIPTS.exitsLater), worker: child("worker", SCRIPTS.alive), timings: TIMINGS, signals: new EventEmitter(), out, err: out })
  assert.equal(await done, 3)
  assert.ok(out.lines.some((l) => l.startsWith("[pilot] api exited code=3")))
  assert.equal(out.lines.filter((l) => l === "[worker] got SIGTERM").length, 1)
  assert.equal(restartDelays(out.lines).length, 0)
  assert.ok(out.lines.includes("[pilot] exiting with 3"))
})

test("kills a child that ignores the forwarded signal after killAfterMs", async () => {
  const out = collector()
  const signals = new EventEmitter()
  const done = supervise({ api: child("api", SCRIPTS.alive), worker: child("worker", SCRIPTS.stubborn), timings: TIMINGS, signals, out, err: out })
  await until(() => out.lines.includes("[worker] up") && out.lines.includes("[api] up"))
  const startedAt = Date.now()
  signals.emit("SIGTERM")
  assert.equal(await done, 0)
  assert.ok(Date.now() - startedAt < 2_000)
  assert.ok(out.lines.includes("[worker] ignoring SIGTERM"))
  assert.ok(out.lines.some((l) => l.startsWith("[pilot] worker did not exit within 400 ms after SIGTERM")))
  assert.ok(out.lines.some((l) => l.startsWith("[pilot] worker exited code=null signal=SIGKILL")))
})
