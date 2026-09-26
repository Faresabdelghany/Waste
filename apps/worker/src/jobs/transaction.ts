// pg-boss's `{ db }` adapter over a Drizzle transaction (Issue #97 part B):
// what a handler passes in `send`'s options so the job it enqueues is written
// in its own transaction and commits or rolls back with its rows. The
// plan-ahead sweep inserts a `generation_run` and sends its job under one
// `withCompany`, so a run row without a job, or a job without its run, is not
// a state the database can be left in.
//
// pg-boss ships the adapter itself, `fromDrizzle(tx, sql)`: pg-boss's
// `IDatabase` is one method, `executeSql(text, values)`, whose text carries
// `pg`'s numbered placeholders, and the adapter binds each as a Drizzle
// parameter through the `sql` tag it is handed, so pg-boss needs no
// dependency on drizzle-orm and this process spells no placeholder parsing
// of its own. This module is the one place the two are put together, so a
// job that must enqueue in its transaction imports one name.
import type { Tx } from "@waste/db/client"
import { sql } from "drizzle-orm"
import { fromDrizzle, type Db } from "pg-boss"

/** pg-boss's database over the transaction: `send(name, data, { db: inTransaction(tx) })` enqueues inside it. */
export const inTransaction = (tx: Tx): Db => fromDrizzle(tx, sql)
