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
-- IF NOT EXISTS is a silent notice when the extension already lives in another
-- schema (a bare `create extension postgis` in a SQL editor lands in public,
-- and PostGIS cannot be relocated). The API role resolves the extensions
-- through a fixed search_path, so anywhere else is a failure, said out loud.
DO $$
DECLARE
  misplaced text;
BEGIN
  SELECT string_agg(extname || ' in ' || extnamespace::regnamespace::text, ', ')
    INTO misplaced
    FROM pg_extension
   WHERE extname IN ('postgis', 'btree_gist')
     AND extnamespace <> 'extensions'::regnamespace;
  IF misplaced IS NOT NULL THEN
    RAISE EXCEPTION 'extension % must be installed in the extensions schema; drop it and let this migration create it there', misplaced;
  END IF;
END
$$;
--> statement-breakpoint

-- Ids are UUID version 7 (ADR-0004): time-ordered, so inserts stay
-- append-friendly. Postgres 17 has no native generator; this is the pure-SQL
-- one (random UUID, the first 48 bits overlaid with Unix milliseconds, version
-- bits set to 0111). Postgres 18 ships uuidv7(); when Supabase moves, this body
-- becomes `select uuidv7()` and no table changes.
--
-- SQL-standard body (BEGIN ATOMIC): names bind at creation, so no SET
-- search_path is needed for hardening, and the planner can inline the function
-- into the calling statement; a SQL function with a SET clause never inlines,
-- and this one runs once per inserted row.
CREATE OR REPLACE FUNCTION wms.uuidv7() RETURNS uuid
LANGUAGE sql VOLATILE PARALLEL SAFE
BEGIN ATOMIC
  SELECT encode(
    set_bit(
      set_bit(
        overlay(uuid_send(gen_random_uuid()) placing
          substring(int8send((extract(epoch from clock_timestamp()) * 1000)::bigint) from 3)
          from 1 for 6),
        52, 1),
      53, 1),
    'hex')::uuid;
END;
--> statement-breakpoint

-- The tenant fence's input (ADR-0001). The API sets `wms.company_id` per
-- transaction (set_config(..., true)); unset or blank reads as null, and a null
-- matches no row, so a code path that forgets to set it sees nothing. Same
-- BEGIN ATOMIC reasoning: this is the predicate of every row-level policy.
CREATE OR REPLACE FUNCTION wms.current_company_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
BEGIN ATOMIC
  SELECT nullif(current_setting('wms.company_id', true), '')::uuid;
END;
--> statement-breakpoint

-- Keeps `updated_at` honest on every table that has one. plpgsql is never
-- inlined, so the SET clause costs nothing extra here.
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
--
-- Roles are cluster-wide while the migrator's lock and journal are per
-- database, so two databases of one cluster migrating at once (the test suite
-- does exactly that) can both reach this block; the loser of that race is
-- tolerated. The flip side: a database whose journal already lists this
-- migration cannot bring back a role someone dropped by hand; re-run its
-- foundation (drop schemas wms and drizzle, migrate again) to restore it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wms_api') THEN
    BEGIN
      CREATE ROLE wms_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    EXCEPTION
      WHEN duplicate_object OR unique_violation THEN
        NULL; -- created a moment ago by another database's migrator
    END;
  END IF;
END
$$;
--> statement-breakpoint
-- The owner may SET ROLE to it, so a test can create a specimen table and look
-- through the fence in the same transaction. Role settings apply at login, not
-- at SET ROLE, so such a test sets search_path = wms, extensions itself.
DO $$
BEGIN
  BEGIN
    EXECUTE format('GRANT wms_api TO %I', current_user);
  EXCEPTION
    WHEN unique_violation THEN
      NULL; -- granted a moment ago by another database's migrator
  END;
END
$$;
--> statement-breakpoint
REVOKE ALL ON SCHEMA wms FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA wms TO wms_api;
--> statement-breakpoint
GRANT USAGE ON SCHEMA extensions TO wms_api;
--> statement-breakpoint
-- Tables and sequences the OWNER creates in wms from now on are usable by the
-- API role without a grant per migration. Default privileges bind to the role
-- that runs this statement, which is why migrations always run as the owner;
-- a ledger revokes UPDATE and DELETE explicitly when it arrives.
ALTER DEFAULT PRIVILEGES IN SCHEMA wms GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wms_api;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA wms GRANT USAGE, SELECT ON SEQUENCES TO wms_api;
--> statement-breakpoint
-- PostGIS functions and operators resolve through the search path. Applies at
-- the API role's login; retried once if another database's migrator wrote the
-- same setting at the same moment.
DO $$
BEGIN
  BEGIN
    ALTER ROLE wms_api SET search_path = wms, extensions;
  EXCEPTION
    WHEN unique_violation THEN
      ALTER ROLE wms_api SET search_path = wms, extensions;
  END;
END
$$;
