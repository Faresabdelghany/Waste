-- The foundation: what every domain table is built on. Hand-written (drizzle-kit
-- generate --custom); drizzle-kit has no builder for extensions, functions,
-- roles or privileges. One statement per breakpoint, as drizzle-kit writes
-- them, so the migrator runs each on its own.

-- Extensions live in Supabase's `extensions` schema. A Supabase database has it
-- already; a database created fresh on the same server may not.
CREATE SCHEMA IF NOT EXISTS extensions;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA extensions;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;
--> statement-breakpoint

-- Ids are UUID version 7 (ADR-0004): time-ordered, so inserts stay
-- append-friendly. Postgres 17 has no native generator; this is the pure-SQL
-- one (random UUID, the first 48 bits overlaid with Unix milliseconds, version
-- bits set to 0111). Postgres 18 ships uuidv7(); when Supabase moves, this body
-- becomes `select uuidv7()` and no table changes.
CREATE OR REPLACE FUNCTION wms.uuidv7() RETURNS uuid
LANGUAGE sql VOLATILE PARALLEL SAFE
SET search_path = ''
AS $$
  select encode(
    set_bit(
      set_bit(
        overlay(uuid_send(gen_random_uuid()) placing
          substring(int8send((extract(epoch from clock_timestamp()) * 1000)::bigint) from 3)
          from 1 for 6),
        52, 1),
      53, 1),
    'hex')::uuid
$$;
--> statement-breakpoint

-- The tenant fence's input (ADR-0001). The API sets `wms.company_id` per
-- transaction (set_config(..., true)); unset or blank reads as null, and a null
-- matches no row, so a code path that forgets to set it sees nothing.
CREATE OR REPLACE FUNCTION wms.current_company_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
SET search_path = ''
AS $$
  select nullif(current_setting('wms.company_id', true), '')::uuid
$$;
--> statement-breakpoint

-- Keeps `updated_at` honest on every table that has one.
CREATE OR REPLACE FUNCTION wms.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
begin
  new.updated_at := now();
  return new;
end
$$;
--> statement-breakpoint

-- The API's role. It owns nothing and bypasses nothing, so every row-level
-- policy applies to it. NOLOGIN here: LOGIN and a password are given per
-- environment (packages/db/scripts/bootstrap-local.ts locally and in CI; by
-- hand on a hosted project), never by a migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wms_api') THEN
    CREATE ROLE wms_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
-- The owner may SET ROLE to it: tests look through the fence that way.
DO $$
BEGIN
  EXECUTE format('GRANT wms_api TO %I', current_user);
END
$$;
--> statement-breakpoint
REVOKE ALL ON SCHEMA wms FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA wms TO wms_api;
--> statement-breakpoint
GRANT USAGE ON SCHEMA extensions TO wms_api;
--> statement-breakpoint
-- Tables the owner creates in wms from now on are readable and writable by the
-- API role without a grant per migration; a ledger revokes UPDATE and DELETE
-- explicitly when it arrives.
ALTER DEFAULT PRIVILEGES IN SCHEMA wms GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wms_api;
--> statement-breakpoint
-- PostGIS functions and operators resolve through the search path.
ALTER ROLE wms_api SET search_path = wms, extensions;
