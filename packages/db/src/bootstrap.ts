// The foundation migration creates the API role NOLOGIN, because a password
// does not belong in a migration. Giving it LOGIN and a password is a
// per-environment step: `planLocalBootstrap` + `grantLogin` do it for the
// local stack and CI (scripts/bootstrap-local.ts), and an operator runs the
// same ALTER ROLE once on a hosted project. The password travels as a query
// parameter into a transaction-local setting and is spliced into ALTER ROLE by
// format(%L) inside the database, so no client-side quoting is involved.
import { createDb } from "./client"
import { isLocalHost } from "./local-host"
import { API_ROLE } from "./roles"

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

export type LocalBootstrapPlan = {
  adminUrl: string
  role: typeof API_ROLE
  password: string
}

/**
 * What the local bootstrap will do, decided from the two URLs and nothing
 * else: the admin URL must be the local stack, and DATABASE_URL must log in as
 * the API role, whose password it carries. Pure, so the refusals are unit-tested.
 */
export function planLocalBootstrap({ adminUrl, appUrl }: { adminUrl: string; appUrl: string }): LocalBootstrapPlan {
  if (!isLocalHost(adminUrl)) {
    throw new Error(
      `bootstrap is for the local stack; DATABASE_ADMIN_URL points at ${new URL(adminUrl).hostname}. On a hosted project run ALTER ROLE ${API_ROLE} WITH LOGIN PASSWORD ... by hand.`,
    )
  }
  const app = new URL(appUrl)
  const user = decodeURIComponent(app.username)
  if (user !== API_ROLE) {
    throw new Error(`DATABASE_URL logs in as "${user}", not "${API_ROLE}": bootstrap sets the API role's password and nothing else`)
  }
  const password = decodeURIComponent(app.password)
  if (password.length === 0) {
    throw new Error("DATABASE_URL carries no password for the API role")
  }
  return { adminUrl, role: API_ROLE, password }
}
