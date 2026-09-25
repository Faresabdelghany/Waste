// The database roles this package knows by name. Migrations run as the owner
// (whoever the admin URL logs in as: `postgres` on Supabase); the API connects
// as API_ROLE, which owns nothing and bypasses nothing, so every row-level
// policy applies to it; the sync service connects as SYNC_ROLE (Issue #104,
// ADR-0004), which reads the synced tables for every tenant by construction
// and so carries BYPASSRLS and REPLICATION and SELECT on exactly those tables
// (sql/publication.ts), and writes nothing. Spelled once here, so a URL
// cannot retarget a statement meant for one role at some other role.
export const API_ROLE = "wms_api"
export const SYNC_ROLE = "wms_sync"
