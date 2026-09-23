// The API's side of the tenant fence (ADR-0001): every request's database work
// runs inside `withCompany`, which opens the transaction and tells it whose
// rows it may see before anything else runs. The fence's policies read that
// setting through `wms.current_company_id()` (the foundation migration), so a
// transaction opened any other way sees no rows and writes none: the fence
// fails closed, and a code path that forgot this wrapper fails loudly instead
// of leaking.
//
// The setting is transaction-local (`set_config(..., true)`): it ends with the
// transaction, commit or rollback, so a pooled connection carries nothing over
// to its next transaction. Which company a request may name is decided by
// whoever calls this with an id from the request's claims (Issue 3); this
// module only refuses a value that is not a UUID at all, which the setting
// would take but the policy's cast would then reject mid-statement.
//
// A transaction, not a savepoint: the argument is the pool's Drizzle instance,
// never a transaction already open, because a nested call would be a
// savepoint, and a transaction-local setting made inside a savepoint outlives
// its release. Tests run as the owner and SET LOCAL ROLE to the API role
// inside `fn`; the API connects as that role to begin with.
import { sql } from "drizzle-orm"

import type { Db, Tx } from "./client"

/** The setting the fence reads; `wms.current_company_id()` spells the same name in SQL. */
export const COMPANY_SETTING = "wms.company_id"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Runs `fn` in a transaction that sees and writes this company's rows only. */
export async function withCompany<T>(db: Db, companyId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID.test(companyId)) {
    throw new Error(`withCompany: "${companyId}" is not a UUID`)
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config(${COMPANY_SETTING}, ${companyId}, true)`)
    return fn(tx)
  })
}
