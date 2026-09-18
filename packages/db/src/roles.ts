// The database roles this package knows by name. Migrations run as the owner
// (whoever the admin URL logs in as: `postgres` on Supabase); the API connects
// as API_ROLE, which owns nothing and bypasses nothing, so every row-level
// policy applies to it. Spelled once here, so a URL cannot retarget a
// statement meant for the API role at some other role.
export const API_ROLE = "wms_api"
