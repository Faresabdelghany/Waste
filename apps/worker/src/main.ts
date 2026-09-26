// The process entry: read the environment, open the pools, start pg-boss with
// every job of the registry, bind the probes, stop on the signals a host
// sends. Everything with behaviour lives in the modules this file composes,
// and is tested there.
//
// Three pools. pg-boss's own, through `pg`, on the worker role's URL
// (boss.ts). Then two of `@waste/db`'s on the two roles: the API role's, on
// which every job writes under `withCompany`, and the worker role's, on which
// the sweeps read across tenants; both go into the context every handler
// receives. A fourth, the probe pool /readyz uses, is one connection on the
// API role's URL (readiness.ts says why a probe gets its own). Opening the
// three `@waste/db` pools connects to nothing — postgres.js dials on the first
// query — but `startBoss` does: pg-boss checks the installed schema version
// before anything else, so a worker on a database without migration 0011, or
// with a pg-boss whose schema moved, exits here with the reason, and never
// polls a schema it does not understand.
//
// The probes bind after pg-boss started, so `/readyz` never answers for a
// process that is about to exit, and `/healthz` answers only for one that
// took its queues. A host that probes `/healthz` before the bind sees a
// refused connection, which is the same answer as a process still loading
// its modules, and waits. A boot that fails — the schema missing, the role
// refused, the port taken — is printed and exits 1 in so many words, rather
// than left to Node's unhandled-rejection report of a top-level await, so a
// host's log names the reason and its restart policy sees a clean exit code.
// A signal during the boot is taken the same way as one after it: the
// handlers are registered before `boot()` runs, and a shutdown that arrives
// mid-`startBoss` waits for the boot to settle (pg-boss's own `stop` waits
// for a `start` in flight) and then closes what the boot made, so a host
// that redeploys while the worker is still dialling gets a clean exit and
// closed pools rather than Node's default 143 with the connections dropped.
import { createDb } from "@waste/db/client"

import { createApp } from "./app"
import { createBoss, startBoss, type Boss } from "./boss"
import { parseEnv } from "./env"
import { JOBS } from "./jobs"
import { staleOutboxCount } from "./jobs/relay-outbox"
import { listen, type Listening } from "./listen"
import { OUTBOX_DEAD_QUEUE } from "./outbox/subscribe"
import { CHECK_TIMEOUT_MS, probePoolOptions } from "./readiness"

const env = parseEnv(process.env)
const api = createDb(env.DATABASE_URL)
const worker = createDb(env.WORKER_DATABASE_URL)
const probe = createDb(env.DATABASE_URL, probePoolOptions(CHECK_TIMEOUT_MS))
const boss = createBoss({ url: env.WORKER_DATABASE_URL })
let started = false

/** What the boot has made so far: pg-boss running with its queues once `startBoss` answered, the listener once it bound. A shutdown closes what is there. */
const made: { running?: Boss; listening?: Listening } = {}

/** pg-boss started with every job, and the probes bound; a failure of either is the process's exit. */
async function boot() {
  const running = await startBoss(boss, JOBS, {
    api,
    worker,
    now: () => new Date(),
    log: (message) => console.log(message),
    send: (name, data, options) => boss.send(name, data, options),
  })
  made.running = running
  started = true
  const listening = await listen(
    createApp({
      probe,
      boss: { boss, queues: running.queues, isStarted: () => started, deadLetterQueue: OUTBOX_DEAD_QUEUE },
      checkTimeoutMs: CHECK_TIMEOUT_MS,
      staleOutbox: () => staleOutboxCount(worker, new Date()),
    }),
    {
      host: env.HOST,
      port: env.PORT,
    },
  )
  made.listening = listening
  return { running, listening }
}

// Shutdown: the workers stop taking jobs and a handler in flight gets
// STOP_TIMEOUT_MS to finish before pg-boss fails it and closes its pool;
// the listener drains alongside, since a probe mid-shutdown should read
// "stopped" and then nothing. The two application pools close after, so a
// handler that is finishing keeps the connection its transaction runs on.
// Every close is idempotent, so a signal delivered twice joins the one
// shutdown; hence `on`, not `once`, and one promise for both. Every failure
// is printed, and any failure exits 1. A signal before the boot has finished
// waits for it first — `booting` settles either way — and then stops
// whatever the boot made: pg-boss through `running.stop()` where `startBoss`
// answered, through the instance's own `stop` where it did not (pg-boss waits
// for its `start` in flight before stopping), the listener where it bound.
let shuttingDown: Promise<never> | undefined
const shutdown = (): Promise<never> =>
  (shuttingDown ??= (async () => {
    started = false
    await booting.catch(() => undefined)
    const outcomes = await Promise.allSettled([
      made.running === undefined ? boss.stop({ graceful: true, close: true, timeout: 1_000 }) : made.running.stop(),
      made.listening?.close(),
      probe.close(),
    ])
    outcomes.push(...(await Promise.allSettled([api.close(), worker.close()])))
    const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
    for (const { reason } of failures) console.error(reason)
    return process.exit(failures.length === 0 ? 0 : 1)
  })())
process.on("SIGINT", () => void shutdown())
process.on("SIGTERM", () => void shutdown())

const booting = boot()
const { running, listening } = await booting.catch(async (error: unknown) => {
  // A shutdown already under way owns the exit: the signal is what ended the boot, or arrived as it failed.
  if (shuttingDown !== undefined) return shuttingDown
  console.error(`@waste/worker failed to start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  await Promise.allSettled([boss.stop({ graceful: false, close: true, timeout: 1_000 }), made.listening?.close(), probe.close(), api.close(), worker.close()])
  return process.exit(1)
})
console.log(`@waste/worker running ${running.queues.length} ${running.queues.length === 1 ? "queue" : "queues"} (${running.queues.join(", ")}), probes on ${listening.url}`)
