// The database roles this package knows by name. Migrations run as the owner
// (whoever the admin URL logs in as: `postgres` on Supabase); the API connects
// as API_ROLE, which owns nothing and bypasses nothing, so every row-level
// policy applies to it; the sync service connects as SYNC_ROLE (Issue #104,
// ADR-0004), which reads the synced tables for every tenant by construction
// and so carries BYPASSRLS and REPLICATION and SELECT on exactly those tables
// (sql/publication.ts), and writes nothing; the worker's pg-boss connects as
// WORKER_ROLE (Issue #97 part B), which carries BYPASSRLS for the one kind of
// statement in the system that reads across tenants, a sweep for work to do,
// and SELECT on every wms table and no write right on any (sql/worker.ts) —
// every write the worker makes runs as API_ROLE under `withCompany`, fenced
// like a request's. Spelled once here, so a URL cannot retarget a statement
// meant for one role at some other role.
export const API_ROLE = "wms_api"
export const SYNC_ROLE = "wms_sync"
export const WORKER_ROLE = "wms_worker"
