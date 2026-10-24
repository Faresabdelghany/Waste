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
// never a transaction already open. A nested call would be a savepoint, and a
// transaction-local setting made inside a savepoint outlives its release: the
// rest of the outer transaction would run as the inner company. The type does
// not tell the two apart (a transaction is structurally a database), so the
// refusal is at run time. Tests run as the owner and SET LOCAL ROLE to the API
// role inside `fn`; the API connects as that role to begin with.
import { is, sql } from "drizzle-orm"
import { PgTransaction } from "drizzle-orm/pg-core"

import type { Db, Tx } from "./client"

/** The setting the fence reads; `wms.current_company_id()` spells the same name in SQL. */
export const COMPANY_SETTING = "wms.company_id"

/** Who is writing, for the audit trail (#291): the principal's account. Set by the API's guard alone, through `actAs`, never from anything a client sends. */
export const ACTOR_SETTING = "wms.user_account_id"
/** Why, for the audit trail: the office's own word for a change, the bounded `Waste-Change-Reason` header. */
export const REASON_SETTING = "wms.change_reason"

/**
 * Names the writer of the transaction for the audit trail (sql/audit-trail.ts):
 * the account every row the transaction changes is recorded under, and the
 * reason, if any. Transaction-local, like the company: it ends with the
 * transaction. The worker and the seed call nothing, and their rows say no one.
 */
export async function actAs(tx: Tx, actor: { userAccountId: string; reason: string | null }): Promise<void> {
  if (!UUID.test(actor.userAccountId)) {
    throw new Error(`actAs: "${actor.userAccountId}" is not a UUID`)
  }
  await tx.execute(sql`select set_config(${ACTOR_SETTING}, ${actor.userAccountId}, true), set_config(${REASON_SETTING}, ${actor.reason ?? ""}, true)`)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Runs `fn` in a transaction that sees and writes this company's rows only. */
export async function withCompany<T>(db: Db, companyId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (is(db, PgTransaction)) {
    throw new Error("withCompany: given a transaction; it opens its own, since a company set inside a savepoint would outlive the savepoint")
  }
  if (!UUID.test(companyId)) {
    throw new Error(`withCompany: "${companyId}" is not a UUID`)
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config(${COMPANY_SETTING}, ${companyId}, true)`)
    return fn(tx)
  })
}
