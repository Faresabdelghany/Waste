// What the supervisor composes from its environment: the two children as
// their own images run them, and the memory line's period. The image sets
// none of the Pilot's values here — the API's and the worker's own variables
// (DATABASE_URL, WORKER_DATABASE_URL, SUPABASE_URL, the knobs) pass through
// untouched, since a child's environment is the supervisor's with these few
// values over it.
//
//   PORT, HOST              the host's port and address, given to the API
//                           (0.0.0.0 and 3001 unless set)
//   WORKER_HOST, WORKER_PORT the worker's probe address, loopback 3002
//                           unless set: internal to the container
//   PILOT_API_DIR, PILOT_WORKER_DIR
//                           each app's directory, the image's deploy
//                           directories unless set; a workstation points them
//                           at apps/api and apps/worker
//   PILOT_MEMORY_LOG_SECONDS the memory line's period; off unless set
//
// Each child runs the bundle the image built where there is one (plain node,
// src/server.mjs and src/main.mjs beside the source, so the API's
// ../build.json still resolves), else the TypeScript source through tsx with
// the app's own tsconfig — a workstation without Docker.
import type { ChildSpec } from "./supervise"

export type Environment = Readonly<Record<string, string | undefined>>

export type Host = {
  /** Whether a bundle exists at the path. */
  exists: (path: string) => boolean
  /** The node to run the children with: process.execPath. */
  execPath: string
}

const setOr = (value: string | undefined, fallback: string) => (value === undefined || value === "" ? fallback : value)

function spec(name: string, dir: string, entry: string, address: { HOST: string; PORT: string }, host: Host): ChildSpec {
  const bundle = `${dir}/src/${entry}.mjs`
  if (host.exists(bundle)) {
    return { name, command: host.execPath, args: [`src/${entry}.mjs`], cwd: dir, env: address }
  }
  return { name, command: host.execPath, args: ["--import", "tsx", `src/${entry}.ts`], cwd: dir, env: { ...address, TSX_TSCONFIG_PATH: `${dir}/tsconfig.json` } }
}

export function childSpecs(env: Environment, host: Host): { api: ChildSpec; worker: ChildSpec } {
  const apiDir = setOr(env.PILOT_API_DIR, "/app/apps/api")
  const workerDir = setOr(env.PILOT_WORKER_DIR, "/app/apps/worker")
  return {
    api: spec("api", apiDir, "server", { HOST: setOr(env.HOST, "0.0.0.0"), PORT: setOr(env.PORT, "3001") }, host),
    worker: spec("worker", workerDir, "main", { HOST: setOr(env.WORKER_HOST, "127.0.0.1"), PORT: setOr(env.WORKER_PORT, "3002") }, host),
  }
}

/** The longest delay Node's timers take, in seconds (2^31 − 1 ms); a longer one would overflow to firing every millisecond. */
export const MAX_TIMER_SECONDS = Math.floor(2_147_483_647 / 1000)

/** The memory line's period in seconds, or undefined — off — unless PILOT_MEMORY_LOG_SECONDS is a positive number Node's timers can take. */
export function memoryLogSeconds(env: Environment): number | undefined {
  const value = Number(env.PILOT_MEMORY_LOG_SECONDS)
  return Number.isFinite(value) && value > 0 && value <= MAX_TIMER_SECONDS ? value : undefined
}
