CREATE TABLE "wms"."sorting_guide_item" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"synonyms" text[] DEFAULT '{}'::text[] NOT NULL,
	"waste_fraction_id" uuid,
	"instructions" text,
	"status" text NOT NULL,
	CONSTRAINT "sorting_guide_item_project_id_name_key" UNIQUE("company_id","project_id","name"),
	CONSTRAINT "sorting_guide_item_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "sorting_guide_item_status_one_of" CHECK ("wms"."sorting_guide_item"."status" in ('draft', 'published', 'withdrawn'))
);
--> statement-breakpoint
ALTER TABLE "wms"."project" ADD COLUMN "public_slug" text;--> statement-breakpoint
ALTER TABLE "wms"."sorting_guide_item" ADD CONSTRAINT "sorting_guide_item_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."sorting_guide_item" ADD CONSTRAINT "sorting_guide_item_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."sorting_guide_item" ADD CONSTRAINT "sorting_guide_item_waste_fraction_id_fk" FOREIGN KEY ("company_id","waste_fraction_id") REFERENCES "wms"."waste_fraction"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sorting_guide_item_waste_fraction_id_idx" ON "wms"."sorting_guide_item" USING btree ("company_id","waste_fraction_id");--> statement-breakpoint
ALTER TABLE "wms"."project" ADD CONSTRAINT "project_public_slug_key" UNIQUE("public_slug");--> statement-breakpoint
ALTER TABLE "wms"."project" ADD CONSTRAINT "project_public_slug_shape" CHECK ("wms"."project"."public_slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length("wms"."project"."public_slug") between 3 and 63);--> statement-breakpoint
ALTER TABLE "wms"."sorting_guide_item" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "sorting_guide_item_tenant_fence" ON "wms"."sorting_guide_item" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "sorting_guide_item_touch_updated_at" BEFORE UPDATE ON "wms"."sorting_guide_item" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wms_public') THEN
    BEGIN
      CREATE ROLE wms_public NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
    EXCEPTION
      WHEN duplicate_object OR unique_violation THEN
        NULL;
    END;
  END IF;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  BEGIN
    EXECUTE format('GRANT wms_public TO %I', current_user);
  EXCEPTION
    WHEN unique_violation THEN
      NULL;
  END;
END
$$;
--> statement-breakpoint
GRANT wms_public TO wms_api WITH INHERIT FALSE, SET TRUE;
--> statement-breakpoint
GRANT USAGE ON SCHEMA wms TO wms_public;
--> statement-breakpoint
GRANT SELECT ("id", "company_id", "name", "language", "timezone", "public_slug") ON "wms"."project" TO wms_public;
--> statement-breakpoint
GRANT SELECT ("id", "company_id", "key", "name") ON "wms"."waste_fraction" TO wms_public;
--> statement-breakpoint
GRANT SELECT ("id", "company_id", "project_id", "name", "synonyms", "waste_fraction_id", "instructions", "status") ON "wms"."sorting_guide_item" TO wms_public;
--> statement-breakpoint
CREATE POLICY "project_public_door" ON "wms"."project" AS PERMISSIVE FOR SELECT TO wms_public USING ("public_slug" is not null);
--> statement-breakpoint
CREATE POLICY "waste_fraction_public_door" ON "wms"."waste_fraction" AS PERMISSIVE FOR SELECT TO wms_public USING ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE POLICY "sorting_guide_item_public_door" ON "wms"."sorting_guide_item" AS PERMISSIVE FOR SELECT TO wms_public USING ("company_id" = (select wms.current_company_id()) and "status" = 'published' and exists (select 1 from "wms"."project" "published" where "published"."company_id" = "sorting_guide_item"."company_id" and "published"."id" = "sorting_guide_item"."project_id" and "published"."public_slug" is not null));
