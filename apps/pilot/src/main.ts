// The image's process entry (its CMD, as the bundle main.mjs): the two
// children composed from the environment (config.ts), the memory line where
// asked for, and the supervisor's rules (supervise.ts) until the API exits or
// the host signals; the container then exits with the code the supervisor
// answers. Everything with behaviour lives in the two modules and is tested
// there; CI's pilot-image job runs this file whole against a database nobody
// answers on.
import { existsSync } from "node:fs"

import { childSpecs, memoryLogSeconds } from "./config"
import { memoryLine } from "./memory"
import { supervise, type ChildPids } from "./supervise"

const specs = childSpecs(process.env, { exists: existsSync, execPath: process.execPath })

// The memory line every PILOT_MEMORY_LOG_SECONDS, where the environment asks
// for it and there is a procfs to read, over the pids the supervisor last
// reported; `unref`, so it never keeps the process up after the supervisor
// has answered.
let children: ChildPids = {}
const period = memoryLogSeconds(process.env)
if (period !== undefined && existsSync("/proc/self/status")) {
  setInterval(() => {
    try {
      process.stdout.write(`[pilot] ${memoryLine({ children })}\n`)
    } catch (error) {
      process.stdout.write(`[pilot] memory line failed: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }, period * 1000).unref()
}

const code = await supervise({
  api: specs.api,
  worker: specs.worker,
  children: (pids) => {
    children = pids
  },
})
process.exit(code)
