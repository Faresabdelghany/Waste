// The ports the processes listen on, and the one a database URL may not name.

/** The API's port unless PORT says otherwise; the Pilot's container exposes it. */
export const API_PORT = 3001
/** The worker's probes' port unless PORT says otherwise, one above the API's; on the Pilot, loopback inside the container. */
export const WORKER_PORT = 3002

/** Supabase's transaction pooler: one backend per statement, no session state, so nothing that holds a lock or a `search_path` on its connection may run there. */
export const TRANSACTION_POOLER_PORT = "6543"
