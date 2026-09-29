// The supervisor's rules (#128 Q6–Q7, measured in #134) over real children:
// `node -e` scripts standing in for the API and the worker, with small
// timings in place of the decision's 5 s / 5 min / 10 min / 20 s. Every run
// goes through `supervised`, which stops the children however the body
// ends, so a failed assertion cannot leave a child keeping the runner alive.
import assert from "node:assert/strict"
import { spawn as nodeSpawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { describe, test } from "node:test"

import { supervise, TIMINGS, type ChildPids, type ChildSpec, type SuperviseOptions, type Timings } from "../supervise"

const SMALL: Timings = { backoffInitialMs: 50, backoffMaxMs: 200, healthyAfterMs: 300, killAfterMs: 400 }

const SCRIPTS = {
  alive: `process.on("SIGTERM", () => { console.log("got SIGTERM"); process.exit(0) }); console.log("up"); setInterval(() => {}, 1000)`,
  exitsAtOnce: `process.exit(2)`,
  exitsLater: `setTimeout(() => { console.log("bye"); console.error("last words"); process.exit(3) }, 100); setInterval(() => {}, 1000)`,
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

type Run = { out: ReturnType<typeof collector>; err: ReturnType<typeof collector>; signals: EventEmitter; done: Promise<number>; pids: ChildPids[] }

/** Runs the supervisor over `options`, then `body`; whatever `body` does, SIGTERM goes out and the run is awaited, so no child outlives its test. Answers the exit code. */
async function supervised(options: Pick<SuperviseOptions, "api" | "worker" | "spawn">, body: (run: Run) => Promise<void>): Promise<number> {
  const out = collector()
  const err = collector()
  const signals = new EventEmitter()
  const pids: ChildPids[] = []
  const done = supervise({ ...options, timings: SMALL, signals, out, err, children: (seen) => void pids.push(seen) })
  try {
    await body({ out, err, signals, done, pids })
  } finally {
    signals.emit("SIGTERM")
    await done
  }
  return done
}

describe("supervise", () => {
  test("the decision's timings: 5 s doubling to 5 min, reset after 10 min up, 20 s before a kill", () => {
    assert.deepEqual(TIMINGS, { backoffInitialMs: 5_000, backoffMaxMs: 300_000, healthyAfterMs: 600_000, killAfterMs: 20_000 })
  })

  test("prefixes each child's output with its name, stderr included, and forwards SIGTERM to both children once, exiting 0", async () => {
    const code = await supervised({ api: child("api", SCRIPTS.alive), worker: child("worker", SCRIPTS.toStderr) }, async ({ out, err, signals, done }) => {
      await until(() => out.lines.includes("[api] up") && err.lines.includes("[worker] a warning"))
      signals.emit("SIGTERM")
      signals.emit("SIGTERM")
      assert.equal(await done, 0)
      assert.equal(out.lines.filter((line) => line === "[api] got SIGTERM").length, 1, "the API saw the signal once")
      assert.ok(out.lines.some((line) => line.startsWith("[pilot] SIGTERM received")))
      assert.ok(out.lines.includes("[pilot] exiting with 0"))
    })
    assert.equal(code, 0)
  })

  test("restarts the worker with doubling backoff up to the cap while the API keeps running", async () => {
    await supervised({ api: child("api", SCRIPTS.alive), worker: child("worker", SCRIPTS.exitsAtOnce) }, async ({ out }) => {
      await until(() => restartDelays(out.lines).length >= 4)
      assert.deepEqual(restartDelays(out.lines).slice(0, 4), [0.05, 0.1, 0.2, 0.2])
      assert.ok(out.lines.some((line) => /^\[pilot\] worker exited code=2 signal=null after [\d.]+ s; restarting in 0\.05 s$/.test(line)))
      assert.ok(out.lines.filter((line) => line.startsWith("[pilot] worker started pid=")).length >= 4)
      assert.equal(out.lines.filter((line) => line.startsWith("[pilot] api started pid=")).length, 1, "the API was started once and never restarted")
    })
  })

  test("resets the backoff to its initial delay once a worker run lasted past healthyAfterMs", async () => {
    let workerSpawns = 0
    const spawn: typeof nodeSpawn = ((command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      if (options.env?.PILOT_ROLE !== "worker") return nodeSpawn(command, args, options)
      workerSpawns += 1
      // The first two runs die at once; the third lives past healthyAfterMs; the fourth dies at once again.
      const script = workerSpawns === 3 ? SCRIPTS.healthyThenExits : SCRIPTS.exitsAtOnce
      return nodeSpawn(command, ["-e", script], options)
    }) as typeof nodeSpawn
    await supervised({ api: child("api", SCRIPTS.alive), worker: child("worker", SCRIPTS.exitsAtOnce), spawn }, async ({ out }) => {
      await until(() => restartDelays(out.lines).length >= 4)
      assert.deepEqual(restartDelays(out.lines).slice(0, 4), [0.05, 0.1, 0.05, 0.1])
    })
  })

  test("exits with the API's code once the API exits, stopping the worker first and restarting nothing, with the API's last lines relayed before the exit", async () => {
    await supervised({ api: child("api", SCRIPTS.exitsLater), worker: child("worker", SCRIPTS.alive) }, async ({ out, err, done }) => {
      assert.equal(await done, 3)
      assert.ok(out.lines.includes("[api] bye"), "stdout written in the exiting tick is in the log")
      assert.ok(err.lines.includes("[api] last words"), "stderr written in the exiting tick is in the log")
      assert.ok(out.lines.some((line) => line.startsWith("[pilot] api exited code=3 signal=null; stopping the worker")))
      assert.equal(out.lines.filter((line) => line === "[worker] got SIGTERM").length, 1)
      assert.equal(restartDelays(out.lines).length, 0)
      assert.ok(out.lines.includes("[pilot] exiting with 3"))
    })
  })

  test("exits as the shell reports a signalled API: 128 plus the signal's number", async () => {
    await supervised({ api: child("api", SCRIPTS.stubborn), worker: child("worker", SCRIPTS.alive) }, async ({ out, signals, done }) => {
      await until(() => out.lines.includes("[api] up"))
      signals.emit("SIGTERM")
      // The API ignores SIGTERM and is killed after killAfterMs: SIGKILL is 9.
      assert.equal(await done, 137)
      assert.ok(out.lines.some((line) => line.startsWith("[pilot] api exited code=null signal=SIGKILL")))
    })
  })

  test("kills a child that ignores the forwarded signal after killAfterMs, and says so", async () => {
    await supervised({ api: child("api", SCRIPTS.alive), worker: child("worker", SCRIPTS.stubborn) }, async ({ out, signals, done }) => {
      await until(() => out.lines.includes("[worker] up") && out.lines.includes("[api] up"))
      const startedAt = Date.now()
      signals.emit("SIGTERM")
      assert.equal(await done, 0)
      assert.ok(Date.now() - startedAt < 2_000, "the kill came with the grace, not later")
      assert.ok(out.lines.includes("[worker] ignoring SIGTERM"))
      assert.ok(out.lines.some((line) => line.startsWith("[pilot] worker did not exit within 400 ms after SIGTERM; killing it")))
      assert.ok(out.lines.some((line) => line.startsWith("[pilot] worker exited code=null signal=SIGKILL")))
    })
  })

  test("a worker that cannot be spawned is logged as failed to start and retried with backoff, the API untouched", async () => {
    await supervised({ api: child("api", SCRIPTS.alive), worker: { ...child("worker", SCRIPTS.alive), command: "/nonexistent/node" } }, async ({ out }) => {
      // The spawn failures come at once, the API's first line after node has booted: wait for both.
      await until(() => restartDelays(out.lines).length >= 2 && out.lines.includes("[api] up"))
      assert.ok(out.lines.some((line) => /^\[pilot\] worker failed to start: spawn \/nonexistent\/node ENOENT/.test(line)))
      assert.ok(out.lines.some((line) => /^\[pilot\] worker exited code=1 signal=null after [\d.]+ s; restarting in 0\.05 s$/.test(line)))
      assert.equal(out.lines.filter((line) => line.startsWith("[pilot] worker started pid=")).length, 0, "nothing started, so no pid")
    })
  })

  test("an API that cannot be spawned ends the container with exit 1, the worker stopped", async () => {
    const code = await supervised({ api: { ...child("api", SCRIPTS.alive), command: "/nonexistent/node" }, worker: child("worker", SCRIPTS.alive) }, async ({ out, done }) => {
      assert.equal(await done, 1)
      assert.ok(out.lines.some((line) => /^\[pilot\] api failed to start: spawn \/nonexistent\/node ENOENT/.test(line)))
      assert.ok(out.lines.some((line) => line.startsWith("[pilot] api exited code=1 signal=null; stopping the worker")))
      assert.ok(out.lines.includes("[pilot] exiting with 1"))
    })
    assert.equal(code, 1)
  })

  test("a child's environment is the supervisor's with the spec's values over it", async () => {
    const echo = `console.log("PORT=" + process.env.PORT + " PATH=" + (process.env.PATH ? "inherited" : "missing")); process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000)`
    await supervised({ api: { ...child("api", echo), env: { PORT: "4001" } }, worker: { ...child("worker", echo), env: { PORT: "4002" } } }, async ({ out }) => {
      await until(() => out.lines.includes("[api] PORT=4001 PATH=inherited") && out.lines.includes("[worker] PORT=4002 PATH=inherited"))
    })
  })

  test("reports the children's pids as they start and end: both up, the worker gone between its runs, both gone at the end", async () => {
    const { pids, out } = await (async () => {
      let run!: Run
      await supervised({ api: child("api", SCRIPTS.alive), worker: child("worker", SCRIPTS.exitsAtOnce) }, async (seen) => {
        run = seen
        await until(() => restartDelays(seen.out.lines).length >= 1)
      })
      return run
    })()
    const started = Number(/pid=(\d+)/.exec(out.lines.find((line) => line.startsWith("[pilot] api started pid="))!)![1])
    assert.ok(pids.some((seen) => seen.api === started && typeof seen.worker === "number"), "both pids reported together while both were up")
    assert.ok(pids.some((seen) => seen.api === started && seen.worker === undefined), "the worker's pid withdrawn once it exited")
    assert.deepEqual(pids.at(-1), { api: undefined, worker: undefined }, "both withdrawn at the end")
  })
})
