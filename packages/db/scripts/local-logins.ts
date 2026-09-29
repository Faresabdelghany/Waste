// `pnpm --filter @waste/db logins` (and `pnpm db:logins` at the root): a
// confirmed Login on the LOCAL stack's Auth for every seeded User Account
// and every address in LOCAL_EXTRA_LOGINS, with the password
// LOCAL_LOGIN_PASSWORD carries or the public local default (Issue #151;
// src/local-stack/logins.ts). The stack's API URL and secret key come from
// the environment (`API_URL`, `SECRET_KEY`, as `supabase status -o env`
// names them) or, when those are unset, from that command run here against
// the repository's own stack — so `pnpm stack:start` needs nothing set and
// CI spells no key in its workflow. A non-loopback URL is refused before any
// request is built: this is never a way of creating the Pilot's Logins.
import { execFileSync } from "node:child_process"
import { resolve } from "node:path"

import { ensureLogins, parseExtraLogins, parseStatusEnv, planLocalLogins } from "../src/local-stack/logins"
import { DEMO_ACCOUNT_EMAILS } from "../src/seed/demo"

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..")

/** The stack's variables: the environment's when it names the API, else the CLI's status, read on this machine. */
function stackEnv(): Record<string, string | undefined> {
  if (process.env.API_URL && process.env.SECRET_KEY) return process.env
  const output = execFileSync("supabase", ["status", "-o", "env"], { cwd: REPOSITORY_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })
  return { ...parseStatusEnv(output), ...process.env }
}

const env = stackEnv()
const plan = planLocalLogins({
  apiUrl: env.API_URL,
  secretKey: env.SECRET_KEY,
  ...(process.env.LOCAL_LOGIN_PASSWORD === undefined ? {} : { password: process.env.LOCAL_LOGIN_PASSWORD }),
  seeded: DEMO_ACCOUNT_EMAILS,
  extra: parseExtraLogins(process.env.LOCAL_EXTRA_LOGINS),
})
const { created, existing } = await ensureLogins(plan)
const host = new URL(plan.apiUrl).host
console.log(
  `@waste/db: local Auth at ${host} holds a Login for ${plan.emails.length === 1 ? "1 address" : `${plan.emails.length} addresses`}` +
    (created.length === 0 ? ", none new" : `; created ${created.join(", ")}`) +
    (existing.length === 0 ? "" : `; already there ${existing.join(", ")}`) +
    (process.env.LOCAL_LOGIN_PASSWORD === undefined ? " (the public local default password)" : " (LOCAL_LOGIN_PASSWORD)"),
)
