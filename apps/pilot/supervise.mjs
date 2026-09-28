#!/usr/bin/env node
// PROTOTYPE — throwaway, ticket #134 (the Pilot image), shape from the
// worker-shape decision #128. Not the implementation: #149 writes
// `apps/pilot` as `@waste/pilot` with `src/supervise.ts` in the turbo gates.
// Plain ESM on purpose: the supervisor is the third process in a 512 MB
// container, and loading tsx for a few dozen lines would cost RSS the gate
// this prototype exists to measure.
//
// One container, two children: the API (`apps/api/src/server.ts`) and the
// worker (`apps/worker/src/main.ts`), each run as `node --import tsx` in its
// own deploy directory, exactly as their own images run them. Rules (#128,
// Q6–Q7):
//   - Render's PORT goes to the API; the worker gets WORKER_PORT (3002) on
//     loopback, its probes internal.
//   - Every line a child writes is prefixed with its name.
//   - The worker is restarted with exponential backoff, 5 s doubling to a
//     5-minute cap, the delay reset to 5 s once a run lasted 10 minutes,
//     while the API keeps answering.
//   - The container exits when the API exits, with the API's code, after
//     stopping the worker; Render's restart answers that.
//   - SIGTERM and SIGINT are forwarded to both children and both are waited
//     for; a child still up after `killAfterMs` is killed.
import { spawn as nodeSpawn } from "node:child_process"
import { constants as osConstants } from "node:os"
import { pathToFileURL } from "node:url"

/** The decision's numbers. A test hands in small ones. */
export const TIMINGS = Object.freeze({
  backoffInitialMs: 5_000,
  backoffMaxMs: 300_000,
  healthyAfterMs: 600_000,
  killAfterMs: 20_000,
})

/**
 * @typedef {object} ChildSpec
 * @property {string} name
 * @property {string} command
 * @property {string[]} args
 * @property {string} [cwd]
 * @property {Record<string, string | undefined>} [env] merged over the supervisor's own environment
 */

/** Relays a child's stream line by line under `[name] `; a partial last line is flushed on end. */
function relay(stream, name, target) {
  let rest = ""
  stream.setEncoding("utf8")
  stream.on("data", (chunk) => {
    rest += chunk
    let at
    while ((at = rest.indexOf("\n")) !== -1) {
      target.write(`[${name}] ${rest.slice(0, at)}\n`)
      rest = rest.slice(at + 1)
    }
  })
  stream.on("end", () => {
    if (rest !== "") target.write(`[${name}] ${rest}\n`)
  })
}

const hasExited = (child) => child.exitCode !== null || child.signalCode !== null

/** A signalled process exits as the shell would report it: 128 + the signal's number. */
const exitCodeOf = ({ code, signal }) => code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : 1)

const waitExit = (child) =>
  hasExited(child)
    ? Promise.resolve({ code: child.exitCode, signal: child.signalCode })
    : new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })))

/**
 * Runs both children until the API exits or a signal arrives; resolves with
 * the code the container should exit with.
 *
 * @param {object} options
 * @param {ChildSpec} options.api
 * @param {ChildSpec} options.worker
 * @param {typeof nodeSpawn} [options.spawn]
 * @param {typeof TIMINGS} [options.timings]
 * @param {NodeJS.EventEmitter} [options.signals] where SIGTERM/SIGINT arrive; `process` by default
 * @param {{ write(s: string): unknown }} [options.out]
 * @param {{ write(s: string): unknown }} [options.err]
 * @param {() => number} [options.now]
 * @returns {Promise<number>}
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
}) {
  return new Promise((resolve) => {
    const log = (line) => out.write(`[pilot] ${line}\n`)
    let shuttingDown = false
    let apiChild
    let apiResult
    let workerChild
    let restartTimer
    let backoffMs = timings.backoffInitialMs

    const start = (spec) => {
      const child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        stdio: ["ignore", "pipe", "pipe"],
      })
      relay(child.stdout, spec.name, out)
      relay(child.stderr, spec.name, err)
      log(`${spec.name} started pid=${child.pid}`)
      return { child, startedAt: now() }
    }

    /** Sends `signal`, escalates to SIGKILL after `killAfterMs`, answers the exit. */
    const terminate = async (child, name, signal) => {
      if (child === undefined || hasExited(child)) return child === undefined ? undefined : waitExit(child)
      child.kill(signal)
      const timer = setTimeout(() => {
        if (!hasExited(child)) {
          log(`${name} did not exit within ${timings.killAfterMs} ms after ${signal}; killing it`)
          child.kill("SIGKILL")
        }
      }, timings.killAfterMs)
      const result = await waitExit(child)
      clearTimeout(timer)
      log(`${name} exited code=${result.code} signal=${result.signal}`)
      return result
    }

    const runWorker = () => {
      const { child, startedAt } = start(worker)
      workerChild = child
      child.once("exit", (code, signal) => {
        if (shuttingDown) return
        const upMs = now() - startedAt
        if (upMs >= timings.healthyAfterMs) backoffMs = timings.backoffInitialMs
        const delay = backoffMs
        backoffMs = Math.min(backoffMs * 2, timings.backoffMaxMs)
        log(`worker exited code=${code} signal=${signal} after ${(upMs / 1000).toFixed(1)} s; restarting in ${delay / 1000} s`)
        restartTimer = setTimeout(() => {
          if (!shuttingDown) runWorker()
        }, delay)
      })
    }

    const shutdown = async (reason, signal) => {
      if (shuttingDown) return
      shuttingDown = true
      clearTimeout(restartTimer)
      log(reason)
      const [apiExit, workerExit] = await Promise.all([terminate(apiChild, "api", signal), terminate(workerChild, "worker", signal)])
      void workerExit
      const code = exitCodeOf(apiResult ?? apiExit ?? { code: 0, signal: null })
      log(`exiting with ${code}`)
      resolve(code)
    }

    const apiStarted = start(api)
    apiChild = apiStarted.child
    apiChild.once("exit", (code, signal) => {
      apiResult = { code, signal }
      if (shuttingDown) return
      void shutdown(`api exited code=${code} signal=${signal}; stopping the worker and exiting with the api's code`, "SIGTERM")
    })
    runWorker()

    for (const signal of ["SIGTERM", "SIGINT"]) {
      signals.on(signal, () => void shutdown(`${signal} received; forwarding it to both children`, signal))
    }
  })
}

// Run directly (the image's CMD): the two children as their own images run
// them. PILOT_API_DIR and PILOT_WORKER_DIR default to the deploy directories
// the Dockerfile lays out; a workstation points them at apps/api and
// apps/worker with node_modules installed.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const apiDir = process.env.PILOT_API_DIR ?? "/app/apps/api"
  const workerDir = process.env.PILOT_WORKER_DIR ?? "/app/apps/worker"
  const code = await supervise({
    api: {
      name: "api",
      command: process.execPath,
      args: ["--import", "tsx", "src/server.ts"],
      cwd: apiDir,
      env: {
        HOST: process.env.HOST ?? "0.0.0.0",
        PORT: process.env.PORT ?? "3001",
        TSX_TSCONFIG_PATH: `${apiDir}/tsconfig.json`,
      },
    },
    worker: {
      name: "worker",
      command: process.execPath,
      args: ["--import", "tsx", "src/main.ts"],
      cwd: workerDir,
      env: {
        HOST: process.env.WORKER_HOST ?? "127.0.0.1",
        PORT: process.env.WORKER_PORT ?? "3002",
        TSX_TSCONFIG_PATH: `${workerDir}/tsconfig.json`,
      },
    },
  })
  process.exit(code)
}
