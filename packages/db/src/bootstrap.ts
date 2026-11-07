// The migrations create the service roles NOLOGIN, because a password does
// not belong in a migration. Giving a role LOGIN and a password is a
// per-environment step, for every role the table (roles.ts) gives a URL of
// its own: `planLocalBootstrap` decides it from the environment's URLs and
// `grantLogin` does it, for the local stack and CI
// (scripts/bootstrap-local.ts), and grant-logins runs the same statement on
// the Pilot (pilot/grant-logins.ts). The password travels as a query
// parameter into a transaction-local setting and is spliced into ALTER ROLE
// by format(%L) inside the database, so no client-side quoting is involved.
import { createDb } from "./client"
import { isLocalHost } from "./local-host"
import { GRANTED_ROLES, OWNER, passwordOf, PLAIN_ROLE } from "./roles"

export type GrantLoginOptions = {
  /** A plain identifier: lowercase letters, digits and underscores. */
  role: string
  password: string
}

export async function grantLogin(adminUrl: string, { role, password }: GrantLoginOptions): Promise<void> {
  if (!PLAIN_ROLE.test(role)) {
    throw new Error(`grantLogin: "${role}" is not a plain role name`)
  }
  if (password.length === 0) {
    throw new Error("grantLogin: the password is empty")
  }
  const { sql, close } = createDb(adminUrl, { max: 1 })
  try {
    await sql.begin(async (tx) => {
      await tx`select set_config('bootstrap.password', ${password}, true)`
      await tx.unsafe(
        `do $$ begin execute format('alter role ${role} with login password %L', current_setting('bootstrap.password')); end $$`,
      )
    })
  } finally {
    await close()
  }
}

export type LocalBootstrapPlan = {
  adminUrl: string
  /** The roles to give LOGIN, each with the password its URL carries. */
  logins: GrantLoginOptions[]
  /** The roles that log in only where their URL is set, whose URL is not: they keep no login here. */
  unset: { role: string; variable: string }[]
}

/**
 * What a local bootstrap will do, decided from the environment and nothing
 * else: the admin URL must be the local stack, a role that always logs in
 * must have its URL, one that logs in where its URL is set is left without a
 * login where it is not, and every URL must log in as its role with a
 * password. Pure, so the refusals are unit-tested.
 */
export function planLocalBootstrap(env: Readonly<Record<string, string | undefined>>): LocalBootstrapPlan {
  const missing = [OWNER, ...GRANTED_ROLES.filter((role) => role.login === "always")].map((role) => role.urls.local).filter((variable) => !env[variable])
  const adminUrl = env[OWNER.urls.local]
  if (missing.length > 0 || adminUrl === undefined) throw new Error(`${missing.join(" and ")} must be set (see .env.example at the repository root)`)
  if (!isLocalHost(adminUrl)) {
    throw new Error(
      `bootstrap is for the local stack; ${OWNER.urls.local} points at ${new URL(adminUrl).hostname}. On a hosted project run ALTER ROLE ... WITH LOGIN PASSWORD ... by hand for ${GRANTED_ROLES.map((role) => role.name).join(" and ")}.`,
    )
  }
  const plan: LocalBootstrapPlan = { adminUrl, logins: [], unset: [] }
  for (const role of GRANTED_ROLES) {
    const url = env[role.urls.local]
    if (role.login === "where-set" && !url) plan.unset.push({ role: role.name, variable: role.urls.local })
    else plan.logins.push({ role: role.name, password: passwordOf(role, url) })
  }
  return plan
}
