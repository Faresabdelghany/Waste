CREATE TABLE "wms"."generation_match" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"collection_group_id" uuid NOT NULL,
	"generation_run_id" uuid NOT NULL,
	"rule_signature" text NOT NULL,
	"container_ids" uuid[] NOT NULL,
	CONSTRAINT "generation_match_collection_group_id_generation_run_id_key" UNIQUE("company_id","collection_group_id","generation_run_id")
);
--> statement-breakpoint
CREATE TABLE "wms"."generation_run" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"route_scheme_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"window_from" date NOT NULL,
	"window_to" date NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"job_id" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"routes_created" integer DEFAULT 0 NOT NULL,
	"routes_refreshed" integer DEFAULT 0 NOT NULL,
	"routes_cancelled" integer DEFAULT 0 NOT NULL,
	"pickups_written" integer DEFAULT 0 NOT NULL,
	"holidays_skipped" integer DEFAULT 0 NOT NULL,
	"unlocated" integer DEFAULT 0 NOT NULL,
	"warnings" text[] DEFAULT '{}'::text[] NOT NULL,
	"error" text,
	CONSTRAINT "generation_run_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "generation_run_trigger_one_of" CHECK ("wms"."generation_run"."trigger" in ('on-demand', 'cron')),
	CONSTRAINT "generation_run_status_one_of" CHECK ("wms"."generation_run"."status" in ('queued', 'running', 'succeeded', 'failed')),
	CONSTRAINT "generation_run_window_ordered" CHECK ("wms"."generation_run"."window_to" >= "wms"."generation_run"."window_from")
);
--> statement-breakpoint
ALTER TABLE "wms"."route" ADD COLUMN "generation_run_id" uuid;--> statement-breakpoint
ALTER TABLE "wms"."generation_match" ADD CONSTRAINT "generation_match_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."generation_match" ADD CONSTRAINT "generation_match_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."generation_match" ADD CONSTRAINT "generation_match_collection_group_id_fk" FOREIGN KEY ("company_id","project_id","collection_group_id") REFERENCES "wms"."collection_group"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."generation_match" ADD CONSTRAINT "generation_match_generation_run_id_fk" FOREIGN KEY ("company_id","project_id","generation_run_id") REFERENCES "wms"."generation_run"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."generation_run" ADD CONSTRAINT "generation_run_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."generation_run" ADD CONSTRAINT "generation_run_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."generation_run" ADD CONSTRAINT "generation_run_route_scheme_id_fk" FOREIGN KEY ("company_id","project_id","route_scheme_id") REFERENCES "wms"."route_scheme"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "generation_match_project_id_idx" ON "wms"."generation_match" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "generation_match_generation_run_id_idx" ON "wms"."generation_match" USING btree ("company_id","generation_run_id");--> statement-breakpoint
CREATE INDEX "generation_run_route_scheme_id_idx" ON "wms"."generation_run" USING btree ("company_id","route_scheme_id");--> statement-breakpoint
ALTER TABLE "wms"."route" ADD CONSTRAINT "route_generation_run_id_fk" FOREIGN KEY ("company_id","project_id","generation_run_id") REFERENCES "wms"."generation_run"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "route_generation_run_id_idx" ON "wms"."route" USING btree ("company_id","generation_run_id");
--> statement-breakpoint
-- Below drizzle-kit's statements: the fence and trigger of generation_run and
-- generation_match, copied verbatim from the helpers in src/sql/, which the
-- gate in src/__tests__/hand-written.test.ts holds the file to (Issue #97
-- part B; migrations/README.md). Neither table is effective-dated, so there
-- is no exclusion constraint; the route's new column, its key and its index
-- are drizzle-kit's above.
ALTER TABLE "wms"."generation_run" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "generation_run_tenant_fence" ON "wms"."generation_run" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "generation_run_touch_updated_at" BEFORE UPDATE ON "wms"."generation_run" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."generation_match" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "generation_match_tenant_fence" ON "wms"."generation_match" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "generation_match_touch_updated_at" BEFORE UPDATE ON "wms"."generation_match" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
