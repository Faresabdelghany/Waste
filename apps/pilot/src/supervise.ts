// The supervisor: one container, two children — the API (`apps/api`) and the
// worker (`apps/worker`), each run as its own image would run it — under the
// rules the worker-shape decision set (#128, Q6–Q7) and #134 measured on the
// host:
//
//   - the host's PORT goes to the API; the worker gets its own port on
//     loopback, its probes internal (main.ts hands both in);
//   - every line a child writes is relayed under `[name] `, so one log holds
//     both processes apart;
//   - the worker is restarted with exponential backoff, 5 s doubling to a
//     5-minute cap, the delay reset to 5 s once a run lasted 10 minutes,
//     while the API keeps answering — a worker that exits because its
//     database does not answer at boot (its own rule) is tried again, and a
//     worker that crashes every time never spins;
//   - the container exits when the API exits, with the API's code, after
//     stopping the worker: the host's restart policy answers that;
//   - SIGTERM and SIGINT are forwarded to both children and both are waited
//     for, so each runs its own shutdown (the API's drain, the worker's
//     handler grace); a child still up after `killAfterMs` is killed;
//   - a child is over when its output has been relayed (`close`, not
//     `exit`), so the line saying why it stopped is in the log before the
//     container exits; a child that never spawned counts as exited 1.
//
// Nothing here knows a port, a path or a database: main.ts composes the two
// `ChildSpec`s from the environment, and a test hands in `node -e` scripts
// with small timings. Third process in a 256 MiB container, so no dependency:
// Node's child_process and nothing else.
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process"
import type { EventEmitter } from "node:events"
import { constants as osConstants } from "node:os"

/** The decision's numbers, in milliseconds. A test hands in small ones. */
export type Timings = {
  /** The first restart delay after the worker exits. */
  backoffInitialMs: number
  /** The delay's cap. */
  backoffMaxMs: number
  /** A worker run at least this long resets the delay to its initial value. */
  healthyAfterMs: number
  /** How long a child may take to exit after the forwarded signal before it is killed. */
  killAfterMs: number
}

export const TIMINGS: Timings = Object.freeze({
  backoffInitialMs: 5_000,
  backoffMaxMs: 300_000,
  healthyAfterMs: 600_000,
  killAfterMs: 20_000,
})

/** One child: what to run, where, and the environment merged over the supervisor's own. */
export type ChildSpec = {
  name: string
  command: string
  args: readonly string[]
  cwd?: string
  env?: Readonly<Record<string, string | undefined>>
}

/** Where a line goes: process.stdout, or a test's collector. */
export type Sink = { write(text: string): unknown }

export type SuperviseOptions = {
  api: ChildSpec
  worker: ChildSpec
  spawn?: typeof nodeSpawn
  timings?: Timings
  /** Where SIGTERM and SIGINT arrive; `process` by default. */
  signals?: EventEmitter
  out?: Sink
  err?: Sink
  now?: () => number
  /** Told the children's pids whenever one starts or ends; main.ts hands them to the memory line. */
  children?: (pids: ChildPids) => void
}

type Exit = { code: number | null; signal: NodeJS.Signals | null }

/** Relays a child's stream line by line under `[name] `; a partial last line is flushed on end. */
function relay(stream: NodeJS.ReadableStream | null, name: string, target: Sink): void {
  if (stream === null) return
  let rest = ""
  stream.setEncoding("utf8")
  stream.on("data", (chunk: string) => {
    rest += chunk
    let at: number
    while ((at = rest.indexOf("\n")) !== -1) {
      target.write(`[${name}] ${rest.slice(0, at)}\n`)
      rest = rest.slice(at + 1)
    }
  })
  stream.on("end", () => {
    if (rest !== "") target.write(`[${name}] ${rest}\n`)
  })
}

const hasExited = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null

/** A signalled process exits as the shell would report it: 128 + the signal's number. */
const exitCodeOf = ({ code, signal }: Exit): number => code ?? (signal !== null ? 128 + (osConstants.signals[signal] ?? 0) : 1)

/** A child as the supervisor holds it: the process, when it started, and the one promise that settles when it is over. */
type Running = {
  child: ChildProcess
  startedAt: number
  /**
   * Settles once the child is over and its output relayed: on `close`, which
   * Node fires after the process exited and both pipes ended — where `exit`
   * may fire with the last lines still unread, and a `process.exit` on that
   * would drop them from the log — or on `error`, which a process that
   * never spawned (ENOENT on the command, a missing directory) emits in
   * place of any exit, taken as an exit with code 1.
   */
  ended: Promise<Exit>
}

/** Which children are up right now, by pid: what the memory line reads. */
export type ChildPids = { api?: number; worker?: number }

/**
 * Runs both children until the API exits or a signal arrives; resolves with
 * the code the container should exit with. `children`, where given, hears
 * the two pids whenever one starts or ends.
 */
export function supervise({
  api,
  worker,
  spawn = nodeSpawn,
  timings = TIMINGS,
  signals = process,
  out = process.stdout,
  err = process.stderr,
  now = Date.now,
  children,
}: SuperviseOptions): Promise<number> {
  return new Promise((resolve) => {
    const log = (line: string) => out.write(`[pilot] ${line}\n`)
    let shuttingDown = false
    let apiExit: Exit | undefined
    let running: Running | undefined
    let restartTimer: ReturnType<typeof setTimeout> | undefined
    let backoffMs = timings.backoffInitialMs
    const pids: ChildPids = {}
    const report = (name: "api" | "worker", pid: number | undefined) => {
      pids[name] = pid
      children?.({ ...pids })
    }

    const start = (spec: ChildSpec, name: "api" | "worker"): Running => {
      const child = spawn(spec.command, [...spec.args], {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        stdio: ["ignore", "pipe", "pipe"],
      })
      relay(child.stdout, spec.name, out)
      relay(child.stderr, spec.name, err)
      const ended = new Promise<Exit>((settle) => {
        child.once("close", (code, signal) => settle({ code, signal }))
        child.once("error", (error) => {
          log(`${spec.name} failed to start: ${error.message}`)
          settle({ code: 1, signal: null })
        })
      })
      if (child.pid !== undefined) log(`${spec.name} started pid=${child.pid}`)
      report(name, child.pid)
      void ended.then(() => report(name, undefined))
      return { child, startedAt: now(), ended }
    }

    /** Sends `signal`, escalates to SIGKILL after `killAfterMs`, answers the exit once the child is over and relayed; undefined for a worker never started. */
    const terminate = async (target: Running | undefined, name: string, signal: NodeJS.Signals): Promise<Exit | undefined> => {
      if (target === undefined) return undefined
      const { child, ended } = target
      if (hasExited(child)) return ended
      child.kill(signal)
      const timer = setTimeout(() => {
        if (!hasExited(child)) {
          log(`${name} did not exit within ${timings.killAfterMs} ms after ${signal}; killing it`)
          child.kill("SIGKILL")
        }
      }, timings.killAfterMs)
      const exit = await ended
      clearTimeout(timer)
      log(`${name} exited code=${exit.code} signal=${exit.signal}`)
      return exit
    }

    const runWorker = () => {
      const started = start(worker, "worker")
      running = started
      void started.ended.then(({ code, signal }) => {
        if (shuttingDown) return
        const upMs = now() - started.startedAt
        if (upMs >= timings.healthyAfterMs) backoffMs = timings.backoffInitialMs
        const delay = backoffMs
        backoffMs = Math.min(backoffMs * 2, timings.backoffMaxMs)
        log(`worker exited code=${code} signal=${signal} after ${(upMs / 1000).toFixed(1)} s; restarting in ${delay / 1000} s`)
        restartTimer = setTimeout(() => {
          if (!shuttingDown) runWorker()
        }, delay)
      })
    }

    // The API first, so the worker's own dial finds nothing this process should have started before it; the API's exit handler and the signal handlers below share one shutdown.
    const apiRunning = start(api, "api")

    const shutdown = async (reason: string, signal: NodeJS.Signals) => {
      if (shuttingDown) return
      shuttingDown = true
      clearTimeout(restartTimer)
      log(reason)
      const [apiTerminated] = await Promise.all([terminate(apiRunning, "api", signal), terminate(running, "worker", signal)])
      const code = exitCodeOf(apiExit ?? apiTerminated ?? { code: 0, signal: null })
      log(`exiting with ${code}`)
      resolve(code)
    }

    void apiRunning.ended.then((exit) => {
      apiExit = exit
      if (shuttingDown) return
      void shutdown(`api exited code=${exit.code} signal=${exit.signal}; stopping the worker and exiting with the api's code`, "SIGTERM")
    })
    runWorker()

    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      signals.on(signal, () => void shutdown(`${signal} received; forwarding it to both children`, signal))
    }
  })
}
