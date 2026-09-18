// The foundation migration creates the API role `wms_api` NOLOGIN, because a
// password does not belong in a migration. Giving it LOGIN and a password is a
// per-environment step: this function does it for the local stack and CI
// (scripts/bootstrap-local.ts), and an operator runs the same statement once
// on a hosted project. The password travels as a query parameter into a
// transaction-local setting and is spliced into ALTER ROLE by format(%L)
// inside the database, so no client-side quoting is involved.
import { createDb } from "./client"

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
