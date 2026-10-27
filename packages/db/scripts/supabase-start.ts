// `pnpm --filter @waste/db supabase-start <start arguments>`: the start the
// root `db:start` and `stack:start` run, after `db:signing-key` (Issue #437).
// It runs the Supabase CLI from the repository root with the arguments given
// (`db start`, or `start -x …`) and, when that fails, stops the stack and
// starts it once more (src/local-stack/start.ts). The CLI is the root's
// devDependency, on the PATH pnpm gives a workspace script. A start killed
// by a signal is not retried: the script exits as the signal would. The
// root command reports any failure as pnpm's exit code 1.
import { spawnSync } from "node:child_process"
import { constants } from "node:os"
import { resolve } from "node:path"

import { startWithOneRetry, type SupabaseRunner } from "../src/local-stack/start"

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..")
// The CLI names it after `project_id` in supabase/config.toml.
const DATABASE_VOLUME = "supabase_db_waste"

const run: SupabaseRunner = (args) => {
  const result = spawnSync("supabase", args, { cwd: REPOSITORY_ROOT, stdio: "inherit" })
  if (result.error !== undefined) throw result.error
  if (result.signal !== null) process.exit(128 + constants.signals[result.signal])
  return result.status ?? 1
}

/** Whether the volume is there; an unanswered question counts as yes, so the data is kept. */
function volumeExists(): boolean {
  const result = spawnSync("docker", ["volume", "ls", "--quiet", "--filter", `name=^${DATABASE_VOLUME}$`], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })
  return result.status !== 0 || result.stdout.trim() !== ""
}

const startArguments = process.argv.slice(2)
if (startArguments.length === 0) {
  console.error("@waste/db: supabase-start needs the start arguments, e.g. `db start`")
  process.exit(2)
}

process.exit(startWithOneRetry(run, startArguments, { volumeExisted: volumeExists() }))
