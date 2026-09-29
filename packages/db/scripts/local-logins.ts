// `pnpm --filter @waste/db logins` (and `pnpm db:logins` at the root): a
// confirmed Login on the LOCAL stack's Auth for every seeded User Account,
// the API e2e suite's tester and every address in LOCAL_EXTRA_LOGINS, with
// the password LOCAL_LOGIN_PASSWORD carries or the public local default
// (Issue #151; src/local-stack/logins.ts). The stack's API URL and secret
// key come from the environment (`API_URL`, `SECRET_KEY`, as `supabase
// status -o env` names them) or, when those are unset, from that command run
// here against the repository's own stack — so `pnpm stack:start` needs
// nothing set and CI spells no key in its workflow. A non-loopback URL is
// refused before any request is built: this is never a way of creating the
// Pilot's Logins.
import { execFileSync } from "node:child_process"
import { resolve } from "node:path"

import { ensureLogins, parseExtraLogins, parseStatusEnv, planLocalLogins } from "../src/local-stack/logins"
import { DEMO_ACCOUNT_EMAILS } from "../src/seed/demo"

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..")

/** Set-but-empty is how a shell, or a placeholder line in .env, says "not set". */
const withoutEmpty = (source: Readonly<Record<string, string | undefined>>) =>
  Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined && value !== ""))

/** The stack's variables: the environment's when it names the API, else the CLI's status, read on this machine. */
function stackEnv(): Record<string, string | undefined> {
  const env = withoutEmpty(process.env)
  if (env.API_URL && env.SECRET_KEY) return env
  const output = execFileSync("supabase", ["status", "-o", "env"], { cwd: REPOSITORY_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })
  return { ...parseStatusEnv(output), ...env }
}

const env = stackEnv()
const plan = planLocalLogins({
  apiUrl: env.API_URL,
  secretKey: env.SECRET_KEY,
  ...(env.LOCAL_LOGIN_PASSWORD === undefined ? {} : { password: env.LOCAL_LOGIN_PASSWORD }),
  seeded: DEMO_ACCOUNT_EMAILS,
  extra: parseExtraLogins(env.LOCAL_EXTRA_LOGINS),
})
const { created, existing } = await ensureLogins(plan)
const host = new URL(plan.apiUrl).host
const password = env.LOCAL_LOGIN_PASSWORD === undefined ? "the public local default password" : "LOCAL_LOGIN_PASSWORD"
console.log(
  `@waste/db: local Auth at ${host} holds a Login for ${plan.emails.length === 1 ? "1 address" : `${plan.emails.length} addresses`}` +
    (created.length === 0 ? "; none new" : `; created ${created.join(", ")} on ${password}`) +
    (existing.length === 0 ? "" : `; already there, each keeping its own password: ${existing.join(", ")}`),
)
