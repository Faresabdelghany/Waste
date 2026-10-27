// `pnpm --filter @waste/db supabase-start <start arguments>`: the start the
// root `db:start` and `stack:start` run, after `db:signing-key` (Issue #437).
// It runs the Supabase CLI from the repository root with the arguments given
// (`db start`, or `start -x …`) and, when that fails, stops the stack and
// starts it once more (src/local-stack/start.ts). The CLI is the root's
// devDependency, on the PATH pnpm gives a workspace script.
import { spawn } from "node:child_process"
import { resolve } from "node:path"

import { startWithOneRetry, type SupabaseRunner } from "../src/local-stack/start"

const ROOT = resolve(import.meta.dirname, "../../..")

const run: SupabaseRunner = (args) =>
  new Promise((done, fail) => {
    const child = spawn("supabase", args, { cwd: ROOT, stdio: "inherit" })
    child.on("error", fail)
    child.on("exit", (code, signal) => done(code ?? (signal === null ? 1 : 128)))
  })

const startArguments = process.argv.slice(2)
if (startArguments.length === 0) {
  console.error("@waste/db: supabase-start needs the start arguments, e.g. `db start`")
  process.exit(2)
}

const { code } = await startWithOneRetry(run, startArguments, { ci: process.env.CI === "true" })
process.exit(code)
