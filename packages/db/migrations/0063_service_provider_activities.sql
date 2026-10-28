CREATE TABLE "wms"."service_provider_activity" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"number" integer NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"service_provider_id" uuid NOT NULL,
	"service_area_id" uuid,
	"subject" text NOT NULL,
	"body" text,
	"due_on" date,
	"route_scheme_id" uuid,
	"collection_group_id" uuid,
	"service_days" text[],
	"effective_from" date,
	"successor_scheme_id" uuid,
	"opened_by" uuid NOT NULL,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	CONSTRAINT "service_provider_activity_number_key" UNIQUE("company_id","number"),
	CONSTRAINT "service_provider_activity_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "service_provider_activity_kind_one_of" CHECK ("wms"."service_provider_activity"."kind" in ('route-day-change', 'compliance-follow-up', 'coordination-note')),
	CONSTRAINT "service_provider_activity_status_one_of" CHECK ("wms"."service_provider_activity"."status" in ('pending-approval', 'approved', 'rejected', 'withdrawn', 'open', 'completed', 'cancelled')),
	CONSTRAINT "service_provider_activity_service_days_subset_of" CHECK ("wms"."service_provider_activity"."service_days" <@ ARRAY['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']::text[]),
	CONSTRAINT "service_provider_activity_subject_given" CHECK (length(btrim("wms"."service_provider_activity"."subject")) > 0),
	CONSTRAINT "service_provider_activity_kind_shape" CHECK (case "wms"."service_provider_activity"."kind" when 'route-day-change' then "wms"."service_provider_activity"."route_scheme_id" is not null and "wms"."service_provider_activity"."collection_group_id" is not null and cardinality("wms"."service_provider_activity"."service_days") > 0 and "wms"."service_provider_activity"."effective_from" is not null and "wms"."service_provider_activity"."due_on" is null when 'compliance-follow-up' then "wms"."service_provider_activity"."due_on" is not null and "wms"."service_provider_activity"."route_scheme_id" is null and "wms"."service_provider_activity"."collection_group_id" is null and "wms"."service_provider_activity"."service_days" is null and "wms"."service_provider_activity"."effective_from" is null else "wms"."service_provider_activity"."due_on" is null and "wms"."service_provider_activity"."route_scheme_id" is null and "wms"."service_provider_activity"."collection_group_id" is null and "wms"."service_provider_activity"."service_days" is null and "wms"."service_provider_activity"."effective_from" is null end),
	CONSTRAINT "service_provider_activity_status_shape" CHECK (case when "wms"."service_provider_activity"."kind" in ('route-day-change') then "wms"."service_provider_activity"."status" in ('pending-approval', 'approved', 'rejected', 'withdrawn') else "wms"."service_provider_activity"."status" in ('open', 'completed', 'cancelled') end),
	CONSTRAINT "service_provider_activity_closed_shape" CHECK (("wms"."service_provider_activity"."status" in ('pending-approval', 'open')) = ("wms"."service_provider_activity"."closed_by" is null and "wms"."service_provider_activity"."closed_at" is null) and ("wms"."service_provider_activity"."status" <> 'rejected' or "wms"."service_provider_activity"."close_reason" is not null) and ("wms"."service_provider_activity"."status" = 'approved') = ("wms"."service_provider_activity"."successor_scheme_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "wms"."service_provider_activity" ADD CONSTRAINT "service_provider_activity_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."service_provider_activity" ADD CONSTRAINT "service_provider_activity_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."service_provider_activity" ADD CONSTRAINT "service_provider_activity_service_provider_id_fk" FOREIGN KEY ("company_id","service_provider_id") REFERENCES "wms"."service_provider"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."service_provider_activity" ADD CONSTRAINT "service_provider_activity_service_area_id_fk" FOREIGN KEY ("company_id","project_id","service_area_id") REFERENCES "wms"."service_area"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."service_provider_activity" ADD CONSTRAINT "service_provider_activity_route_scheme_id_fk" FOREIGN KEY ("company_id","project_id","route_scheme_id") REFERENCES "wms"."route_scheme"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."service_provider_activity" ADD CONSTRAINT "service_provider_activity_collection_group_id_fk" FOREIGN KEY ("company_id","project_id","collection_group_id") REFERENCES "wms"."collection_group"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."service_provider_activity" ADD CONSTRAINT "service_provider_activity_successor_scheme_id_fk" FOREIGN KEY ("company_id","project_id","successor_scheme_id") REFERENCES "wms"."route_scheme"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."service_provider_activity" ADD CONSTRAINT "service_provider_activity_opened_by_fk" FOREIGN KEY ("company_id","opened_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."service_provider_activity" ADD CONSTRAINT "service_provider_activity_closed_by_fk" FOREIGN KEY ("company_id","closed_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_provider_activity_project_id_idx" ON "wms"."service_provider_activity" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "service_provider_activity_service_provider_id_idx" ON "wms"."service_provider_activity" USING btree ("company_id","service_provider_id");--> statement-breakpoint
CREATE INDEX "service_provider_activity_service_area_id_idx" ON "wms"."service_provider_activity" USING btree ("company_id","service_area_id");--> statement-breakpoint
CREATE INDEX "service_provider_activity_route_scheme_id_idx" ON "wms"."service_provider_activity" USING btree ("company_id","route_scheme_id");--> statement-breakpoint
CREATE INDEX "service_provider_activity_collection_group_id_idx" ON "wms"."service_provider_activity" USING btree ("company_id","collection_group_id");--> statement-breakpoint
CREATE INDEX "service_provider_activity_successor_scheme_id_idx" ON "wms"."service_provider_activity" USING btree ("company_id","successor_scheme_id");--> statement-breakpoint
CREATE INDEX "service_provider_activity_opened_by_idx" ON "wms"."service_provider_activity" USING btree ("company_id","opened_by");--> statement-breakpoint
CREATE INDEX "service_provider_activity_closed_by_idx" ON "wms"."service_provider_activity" USING btree ("company_id","closed_by");--> statement-breakpoint
ALTER TABLE "wms"."service_provider_activity" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "service_provider_activity_tenant_fence" ON "wms"."service_provider_activity" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "service_provider_activity_touch_updated_at" BEFORE UPDATE ON "wms"."service_provider_activity" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER "service_provider_activity_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."service_provider_activity" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
