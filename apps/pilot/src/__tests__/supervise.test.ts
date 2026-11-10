// The supervisor's rules (#128 Q6–Q7, measured in #134) over real children:
// `node -e` scripts standing in for the API and the worker, with small
// timings in place of the decision's 5 s / 5 min / 10 min / 20 s. The
// backoff runs over scripted children on a clock the test moves, so how long
// a run lasted is what the test says and never what a loaded machine took.
// Every run goes through `supervised`, which stops the children however the
// body ends, so a failed assertion cannot leave a child keeping the runner
// alive.
import assert from "node:assert/strict"
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { describe, test } from "node:test"

import { supervise, TIMINGS, type ChildPids, type ChildSpec, type Schedule, type SuperviseOptions, type Timings } from "../supervise"

const SMALL: Timings = { backoffInitialMs: 50, backoffMaxMs: 200, healthyAfterMs: 300, killAfterMs: 400 }

const SCRIPTS = {
  alive: `process.on("SIGTERM", () => { console.log("got SIGTERM"); process.exit(0) }); console.log("up"); setInterval(() => {}, 1000)`,
  exitsAtOnce: `process.exit(2)`,
  exitsLater: `setTimeout(() => { console.log("bye"); console.error("last words"); process.exit(3) }, 100); setInterval(() => {}, 1000)`,
  stubborn: `process.on("SIGTERM", () => console.log("ignoring SIGTERM")); console.log("up"); setInterval(() => {}, 1000)`,
  toStderr: `console.error("a warning"); process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000)`,
}

const child = (name: string, script: string): ChildSpec => ({ name, command: process.execPath, args: ["-e", script] })

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

/** A child with no process behind it, which the test ends: what the supervisor reads of one. A forwarded signal ends it at once, exiting 0, as the scripts' handlers do. */
class ScriptedChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  constructor(readonly pid: number) {
    super()
  }
  exit(code: number) {
    this.exitCode = code
    this.stdout.end()
    this.stderr.end()
    this.emit("close", code, null)
  }
  kill(): boolean {
    if (this.exitCode === null) this.exit(0)
    return true
  }
}

/** Scripted children by name, spawned as `api` and `worker`. */
const scripted = () => {
  const spawned: Record<string, ScriptedChild[]> = { api: [], worker: [] }
  const spawn = ((command: string) => {
    const started = new ScriptedChild(1000 + spawned.api.length + spawned.worker.length)
    spawned[command].push(started)
    return started as unknown as ChildProcess
  }) as typeof nodeSpawn
  return {
    spawned,
    spawn,
    api: { name: "api", command: "api", args: [] } satisfies ChildSpec,
    worker: { name: "worker", command: "worker", args: [] } satisfies ChildSpec,
    lastWorker: () => spawned.worker.at(-1) ?? assert.fail("no worker spawned"),
  }
}

/** A clock and a scheduler the test moves: `asked` is every delay the supervisor scheduled, `fire` runs the one due first with the clock moved to it. */
const testClock = () => {
  let at = 0
  const pending: { due: number; run: () => void }[] = []
  const asked: number[] = []
  const schedule: Schedule = (run, ms) => {
    asked.push(ms)
    const timer = { due: at + ms, run }
    pending.push(timer)
    return () => {
      const index = pending.indexOf(timer)
      if (index !== -1) pending.splice(index, 1)
    }
  }
  return {
    now: () => at,
    schedule,
    asked,
    pass: (ms: number) => void (at += ms),
    fire: () => {
      pending.sort((a, b) => a.due - b.due)
      const next = pending.shift() ?? assert.fail("nothing scheduled")
      at = Math.max(at, next.due)
      next.run()
    },
  }
}

/** Lets the supervisor answer what the test just did: a child's close settles a promise, and the restart follows it. */
const settled = () => new Promise((resolve) => setImmediate(resolve))

type Run = { out: ReturnType<typeof collector>; err: ReturnType<typeof collector>; signals: EventEmitter; done: Promise<number>; pids: ChildPids[] }

async function supervised(options: Pick<SuperviseOptions, "api" | "worker" | "spawn" | "now" | "schedule">, body: (run: Run) => Promise<void>): Promise<number> {
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
    const children = scripted()
    const clock = testClock()
    await supervised({ api: children.api, worker: children.worker, spawn: children.spawn, now: clock.now, schedule: clock.schedule }, async ({ out }) => {
      for (let run = 0; run < 4; run += 1) {
        children.lastWorker().exit(2)
        await settled()
        clock.fire()
      }
      assert.deepEqual(clock.asked, [50, 100, 200, 200])
      assert.ok(out.lines.includes("[pilot] worker exited code=2 signal=null after 0.0 s; restarting in 0.05 s"))
      assert.equal(children.spawned.worker.length, 5)
      assert.equal(children.spawned.api.length, 1, "the API was started once and never restarted")
    })
  })

  test("resets the backoff to its initial delay once a worker run lasted past healthyAfterMs", async () => {
    const children = scripted()
    const clock = testClock()
    await supervised({ api: children.api, worker: children.worker, spawn: children.spawn, now: clock.now, schedule: clock.schedule }, async () => {
      // The third run lasts exactly healthyAfterMs, at least as long as a healthy run must.
      for (const lastedMs of [0, 0, SMALL.healthyAfterMs, 0]) {
        clock.pass(lastedMs)
        children.lastWorker().exit(0)
        await settled()
        clock.fire()
      }
      assert.deepEqual(clock.asked, [50, 100, 50, 100])
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
    // Node's own timers, each delay noted: the kill is real, and the grace is the one it was given.
    const asked: number[] = []
    const schedule: Schedule = (run, ms) => {
      asked.push(ms)
      const timer = setTimeout(run, ms)
      return () => clearTimeout(timer)
    }
    await supervised({ api: child("api", SCRIPTS.alive), worker: child("worker", SCRIPTS.stubborn), schedule }, async ({ out, signals, done }) => {
      await until(() => out.lines.includes("[worker] up") && out.lines.includes("[api] up"))
      signals.emit("SIGTERM")
      assert.equal(await done, 0)
      assert.ok(asked.length > 0 && asked.every((ms) => ms === SMALL.killAfterMs), `the kill came with the grace, not later: ${asked.join(", ")}`)
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
