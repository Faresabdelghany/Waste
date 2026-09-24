CREATE TABLE "wms"."company" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"legal_name" text NOT NULL,
	"registration_number" text NOT NULL,
	"country" text NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "company_country_registration_number_key" UNIQUE("country","registration_number"),
	CONSTRAINT "company_self" CHECK ("wms"."company"."company_id" = "wms"."company"."id"),
	CONSTRAINT "company_status_one_of" CHECK ("wms"."company"."status" in ('active', 'onboarding'))
);
--> statement-breakpoint
CREATE TABLE "wms"."project" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"language" text NOT NULL,
	"currency" text NOT NULL,
	"timezone" text NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "project_name_key" UNIQUE("company_id","name"),
	CONSTRAINT "project_tenant_key" UNIQUE("company_id","id"),
	CONSTRAINT "project_status_one_of" CHECK ("wms"."project"."status" in ('active', 'onboarding'))
);
--> statement-breakpoint
CREATE TABLE "wms"."service_provider" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"legal_name" text NOT NULL,
	"registration_number" text NOT NULL,
	"country" text NOT NULL,
	"contact_name" text NOT NULL,
	"contact_email" text NOT NULL,
	CONSTRAINT "service_provider_country_registration_number_key" UNIQUE("company_id","country","registration_number"),
	CONSTRAINT "service_provider_tenant_key" UNIQUE("company_id","id")
);
--> statement-breakpoint
CREATE TABLE "wms"."project_access" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	CONSTRAINT "project_access_user_account_id_project_id_key" UNIQUE("company_id","user_account_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "wms"."role" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"key" text,
	"name" text NOT NULL,
	"scope" text NOT NULL,
	"description" text NOT NULL,
	"system" boolean NOT NULL,
	CONSTRAINT "role_key_key" UNIQUE("company_id","key"),
	CONSTRAINT "role_name_key" UNIQUE("company_id","name"),
	CONSTRAINT "role_tenant_key" UNIQUE("company_id","id")
);
--> statement-breakpoint
CREATE TABLE "wms"."role_grant" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"role_id" uuid NOT NULL,
	"module_key" text NOT NULL,
	"action" text NOT NULL,
	CONSTRAINT "role_grant_role_id_module_key_action_key" UNIQUE("company_id","role_id","module_key","action")
);
--> statement-breakpoint
CREATE TABLE "wms"."service_provider_access" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_account_id" uuid NOT NULL,
	"service_provider_id" uuid NOT NULL,
	CONSTRAINT "service_provider_access_user_account_id_service_provider_id_key" UNIQUE("company_id","user_account_id","service_provider_id")
);
--> statement-breakpoint
CREATE TABLE "wms"."user_account" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"auth_user_id" uuid,
	"email" text NOT NULL,
	"full_name" text NOT NULL,
	"role_id" uuid NOT NULL,
	"all_projects" boolean DEFAULT false NOT NULL,
	"service_provider_id" uuid,
	"primary_administrator" boolean DEFAULT false NOT NULL,
	"deactivated_at" timestamp with time zone,
	CONSTRAINT "user_account_auth_user_id_key" UNIQUE("auth_user_id"),
	CONSTRAINT "user_account_email_key" UNIQUE("company_id","email"),
	CONSTRAINT "user_account_tenant_key" UNIQUE("company_id","id"),
	CONSTRAINT "user_account_id_service_provider_id_key" UNIQUE("company_id","id","service_provider_id"),
	CONSTRAINT "user_account_email_lowercase" CHECK ("wms"."user_account"."email" = lower("wms"."user_account"."email"))
);
--> statement-breakpoint
ALTER TABLE "wms"."project" ADD CONSTRAINT "project_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."service_provider" ADD CONSTRAINT "service_provider_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."project_access" ADD CONSTRAINT "project_access_user_account_id_fk" FOREIGN KEY ("company_id","user_account_id") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."project_access" ADD CONSTRAINT "project_access_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."role" ADD CONSTRAINT "role_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."role_grant" ADD CONSTRAINT "role_grant_role_id_fk" FOREIGN KEY ("company_id","role_id") REFERENCES "wms"."role"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."service_provider_access" ADD CONSTRAINT "service_provider_access_user_account_id_service_provider_id_fk" FOREIGN KEY ("company_id","user_account_id","service_provider_id") REFERENCES "wms"."user_account"("company_id","id","service_provider_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."user_account" ADD CONSTRAINT "user_account_role_id_fk" FOREIGN KEY ("company_id","role_id") REFERENCES "wms"."role"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."user_account" ADD CONSTRAINT "user_account_service_provider_id_fk" FOREIGN KEY ("company_id","service_provider_id") REFERENCES "wms"."service_provider"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_access_project_id_idx" ON "wms"."project_access" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_account_primary_administrator_idx" ON "wms"."user_account" USING btree ("company_id") WHERE "wms"."user_account"."primary_administrator";--> statement-breakpoint
CREATE INDEX "user_account_role_id_idx" ON "wms"."user_account" USING btree ("company_id","role_id");--> statement-breakpoint
CREATE INDEX "user_account_service_provider_id_idx" ON "wms"."user_account" USING btree ("company_id","service_provider_id");
--> statement-breakpoint
-- Hand-written from here on (migrations/README.md): what drizzle-kit has no
-- builder for, one statement per breakpoint. First, for each of the eight
-- tables in the order above, the tenant fence and the updated_at trigger, as
-- src/sql/tenant-fence.ts and src/sql/touch-updated-at.ts spell them; the gate
-- in src/__tests__/hand-written.test.ts holds this file to them. Then the
-- access token hook and its grants.
ALTER TABLE "wms"."company" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "company_tenant_fence" ON "wms"."company" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "company_touch_updated_at" BEFORE UPDATE ON "wms"."company" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."project" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "project_tenant_fence" ON "wms"."project" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "project_touch_updated_at" BEFORE UPDATE ON "wms"."project" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."service_provider" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "service_provider_tenant_fence" ON "wms"."service_provider" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "service_provider_touch_updated_at" BEFORE UPDATE ON "wms"."service_provider" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."project_access" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "project_access_tenant_fence" ON "wms"."project_access" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "project_access_touch_updated_at" BEFORE UPDATE ON "wms"."project_access" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."role" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "role_tenant_fence" ON "wms"."role" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "role_touch_updated_at" BEFORE UPDATE ON "wms"."role" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."role_grant" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "role_grant_tenant_fence" ON "wms"."role_grant" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "role_grant_touch_updated_at" BEFORE UPDATE ON "wms"."role_grant" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."service_provider_access" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "service_provider_access_tenant_fence" ON "wms"."service_provider_access" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "service_provider_access_touch_updated_at" BEFORE UPDATE ON "wms"."service_provider_access" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."user_account" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "user_account_tenant_fence" ON "wms"."user_account" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "user_account_touch_updated_at" BEFORE UPDATE ON "wms"."user_account" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
-- The access token hook (Issue #70). Supabase Auth calls it as
-- supabase_auth_admin on every token it issues, refresh included, with the
-- user's id, the claims about to be signed and how the user authenticated, and
-- signs what comes back. It projects the one custom claim the API reads,
-- app_metadata.company_id: the account bound to this login or, on first
-- sign-in, the invited account whose e-mail address this is, bound here in one
-- UPDATE. Binding by e-mail is safe only because sign-up is invitation-only in
-- the Supabase project's Auth settings: the address in the claim is one the
-- company invited and the user confirmed.
--
-- Three outcomes. No account: the event unchanged, so the token carries no
-- claim and the API answers 403. A deactivated account: the error object Auth
-- turns into a refused token, so a deactivation takes effect within one token
-- lifetime (the API's per-request lookup makes it immediate anyway). Otherwise
-- the claim, set into the existing app_metadata (created when absent) with
-- every other claim left as it was.
--
-- SECURITY DEFINER with an empty search_path, every name qualified: the owner
-- is the migration's role, postgres, which carries BYPASSRLS locally and on
-- Supabase, so the function reads wms.user_account through the fence with no
-- policy of its own, and the caller's own privileges (supabase_auth_admin has
-- none on wms) do not enter into it. Auth allows a hook two seconds; the
-- lookup by login is one row through the unique auth_user_id index.
CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  login uuid := (event->>'user_id')::uuid;
  account record;
begin
  if login is null then
    return event;
  end if;
  select company_id, deactivated_at
    into account
    from wms.user_account
   where auth_user_id = login;
  if not found then
    -- First sign-in: the invited account whose address this is, if it is still open.
    update wms.user_account
       set auth_user_id = login
     where email = lower(event->'claims'->>'email')
       and auth_user_id is null
       and deactivated_at is null
    returning company_id, deactivated_at into account;
  end if;
  if not found then
    return event;
  end if;
  if account.deactivated_at is not null then
    return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'This account is deactivated'));
  end if;
  return jsonb_set(
    event,
    '{claims,app_metadata}',
    jsonb_set(coalesce(event->'claims'->'app_metadata', '{}'::jsonb), '{company_id}', to_jsonb(account.company_id))
  );
end
$$;
--> statement-breakpoint
-- Auth's role may call it and nobody reaching the database through the Data
-- API may: the owner's default privileges in public grant EXECUTE to anon and
-- authenticated, and PUBLIC would otherwise have it by Postgres's default.
GRANT EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) TO supabase_auth_admin;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) FROM PUBLIC, anon, authenticated;
