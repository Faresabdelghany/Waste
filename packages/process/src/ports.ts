// The ports the processes listen on, and Supabase's pooler's: the one a
// database URL may not name, and the one a hosted URL does.

/** The API's port unless PORT says otherwise; the Pilot's container exposes it. */
export const API_PORT = 3001
/** The worker's probes' port unless PORT says otherwise, one above the API's; on the Pilot, loopback inside the container. */
export const WORKER_PORT = 3002

/** Supabase's transaction pooler: one backend per statement, no session state, so nothing that holds a lock or a `search_path` on its connection may run there. */
export const TRANSACTION_POOLER_PORT = "6543"
/** Supabase's session pooler: a backend per connection, as migrations, pg-boss and the API need; every Pilot URL names it. */
export const SESSION_POOLER_PORT = "5432"
