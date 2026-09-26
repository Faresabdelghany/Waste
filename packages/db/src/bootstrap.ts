// The migrations create the three service roles NOLOGIN — the API role in the
// foundation, the sync role in 0008 (Issue #104), the worker role in 0011
// (Issue #97 part B) — because a password does not belong in a migration.
// Giving a role LOGIN and a password is a per-environment step:
// `planLocalBootstrap`, `planSyncBootstrap` and `planWorkerBootstrap` decide
// it from the URLs and `grantLogin` does it, for the local stack and CI
// (scripts/bootstrap-local.ts), and an operator runs the same ALTER ROLE once
// on a hosted project. The password travels as a query parameter into a
// transaction-local setting and is spliced into ALTER ROLE by format(%L)
// inside the database, so no client-side quoting is involved.
import { createDb } from "./client"
import { isLocalHost } from "./local-host"
import { API_ROLE, SYNC_ROLE, WORKER_ROLE } from "./roles"

export type GrantLoginOptions = {
  /** A plain identifier: lowercase letters, digits and underscores. */
  role: string
  password: string
}

export async function grantLogin(adminUrl: string, { role, password }: GrantLoginOptions): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) {
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

export type LocalBootstrapPlan<Role extends string = string> = {
  adminUrl: string
  role: Role
  password: string
}

/**
 * What a local bootstrap of one role will do, decided from the two URLs and
 * nothing else: the admin URL must be the local stack, and the role's URL
 * must log in as that role, whose password it carries. Pure, so the refusals
 * are unit-tested. `variable` names the URL in the refusals, since the person
 * fixes an environment variable and not an argument.
 */
export function planLocalLogin<Role extends string>({ adminUrl, url, role, variable }: { adminUrl: string; url: string; role: Role; variable: string }): LocalBootstrapPlan<Role> {
  if (!isLocalHost(adminUrl)) {
    throw new Error(
      `bootstrap is for the local stack; DATABASE_ADMIN_URL points at ${new URL(adminUrl).hostname}. On a hosted project run ALTER ROLE ${role} WITH LOGIN PASSWORD ... by hand.`,
    )
  }
  const parsed = new URL(url)
  const user = decodeURIComponent(parsed.username)
  if (user !== role) {
    throw new Error(`${variable} logs in as "${user}", not "${role}": bootstrap sets the ${role} role's password and nothing else`)
  }
  const password = decodeURIComponent(parsed.password)
  if (password.length === 0) {
    throw new Error(`${variable} carries no password for the ${role} role`)
  }
  return { adminUrl, role, password }
}

/** The API role's login from `DATABASE_URL`: the plan every environment runs. */
export const planLocalBootstrap = ({ adminUrl, appUrl }: { adminUrl: string; appUrl: string }): LocalBootstrapPlan<typeof API_ROLE> =>
  planLocalLogin({ adminUrl, url: appUrl, role: API_ROLE, variable: "DATABASE_URL" })

/** The sync role's login from `SYNC_DATABASE_URL` (Issue #104): the plan an environment with a PowerSync instance runs beside the API's. */
export const planSyncBootstrap = ({ adminUrl, syncUrl }: { adminUrl: string; syncUrl: string }): LocalBootstrapPlan<typeof SYNC_ROLE> =>
  planLocalLogin({ adminUrl, url: syncUrl, role: SYNC_ROLE, variable: "SYNC_DATABASE_URL" })

/** The worker role's login from `WORKER_DATABASE_URL` (Issue #97 part B): the plan an environment that runs `apps/worker` runs beside the API's. */
export const planWorkerBootstrap = ({ adminUrl, workerUrl }: { adminUrl: string; workerUrl: string }): LocalBootstrapPlan<typeof WORKER_ROLE> =>
  planLocalLogin({ adminUrl, url: workerUrl, role: WORKER_ROLE, variable: "WORKER_DATABASE_URL" })
