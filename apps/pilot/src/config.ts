// What the supervisor composes from its environment: the two children as
// their own images run them, and the memory line's period. It reads its own
// variables (SUPERVISOR_VARIABLES) and nothing else; the image sets none of
// the Pilot's values here — the API's and the worker's own variables
// (DATABASE_URL, WORKER_DATABASE_URL, SUPABASE_URL, the knobs) pass through
// untouched, since a child's environment is the supervisor's with these few
// values over it.
//
// Each child runs the bundle the image built where there is one (plain node,
// src/server.mjs and src/main.mjs beside the source, so the API's
// ../build.json still resolves), else the TypeScript source through tsx with
// the app's own tsconfig — a workstation without Docker.
import { withoutEmpty, type Environment } from "@waste/process/environment"
import { API_PORT, WORKER_PORT } from "@waste/process/ports"

import type { ChildSpec } from "./supervise"

/** The variables the supervisor reads itself; every other one passes through to the children, which declare their own. */
export const SUPERVISOR_VARIABLES = [
  // The host's port and address, given to the API: 3001 and 0.0.0.0 unless set.
  "PORT",
  "HOST",
  // The worker's probe address, loopback 3002 unless set: internal to the container.
  "WORKER_HOST",
  "WORKER_PORT",
  // Each app's directory, the image's deploy directories unless set; a workstation points them at apps/api and apps/worker.
  "PILOT_API_DIR",
  "PILOT_WORKER_DIR",
  // The memory line's period; off unless set.
  "PILOT_MEMORY_LOG_SECONDS",
] as const

/** The supervisor's own variables out of the environment, set-but-empty as unset: reading any other is a type error. */
const own = (source: Environment): Partial<Record<(typeof SUPERVISOR_VARIABLES)[number], string>> => withoutEmpty(source)

export type Host = {
  exists: (path: string) => boolean
  /** The node to run the children with: process.execPath. */
  execPath: string
}

function spec(name: string, dir: string, entry: string, address: { HOST: string; PORT: string }, host: Host): ChildSpec {
  const bundle = `${dir}/src/${entry}.mjs`
  if (host.exists(bundle)) {
    return { name, command: host.execPath, args: [`src/${entry}.mjs`], cwd: dir, env: address }
  }
  return { name, command: host.execPath, args: ["--import", "tsx", `src/${entry}.ts`], cwd: dir, env: { ...address, TSX_TSCONFIG_PATH: `${dir}/tsconfig.json` } }
}

export function childSpecs(source: Environment, host: Host): { api: ChildSpec; worker: ChildSpec } {
  const env = own(source)
  const apiDir = env.PILOT_API_DIR ?? "/app/apps/api"
  const workerDir = env.PILOT_WORKER_DIR ?? "/app/apps/worker"
  return {
    api: spec("api", apiDir, "server", { HOST: env.HOST ?? "0.0.0.0", PORT: env.PORT ?? String(API_PORT) }, host),
    worker: spec("worker", workerDir, "main", { HOST: env.WORKER_HOST ?? "127.0.0.1", PORT: env.WORKER_PORT ?? String(WORKER_PORT) }, host),
  }
}

/** The longest delay Node's timers take, in seconds (2^31 − 1 ms); a longer one would overflow to firing every millisecond. */
export const MAX_TIMER_SECONDS = Math.floor(2_147_483_647 / 1000)

/** The memory line's period in seconds, or undefined — off — unless PILOT_MEMORY_LOG_SECONDS is a positive number Node's timers can take. */
export function memoryLogSeconds(source: Environment): number | undefined {
  const value = Number(own(source).PILOT_MEMORY_LOG_SECONDS)
  return Number.isFinite(value) && value > 0 && value <= MAX_TIMER_SECONDS ? value : undefined
}
