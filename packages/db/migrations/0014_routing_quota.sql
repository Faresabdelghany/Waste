CREATE TABLE "wms"."routing_quota" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider" text NOT NULL,
	"family" text NOT NULL,
	"remaining" integer,
	"limit" integer,
	"reset_at" timestamp with time zone,
	"exhausted_at" timestamp with time zone,
	"key_refused_at" timestamp with time zone,
	CONSTRAINT "routing_quota_provider_family_key" UNIQUE("company_id","provider","family"),
	CONSTRAINT "routing_quota_family_one_of" CHECK ("wms"."routing_quota"."family" in ('directions', 'optimisation')),
	CONSTRAINT "routing_quota_counts_shape" CHECK (("wms"."routing_quota"."remaining" is null or "wms"."routing_quota"."remaining" >= 0) and ("wms"."routing_quota"."limit" is null or "wms"."routing_quota"."limit" >= 0))
);
--> statement-breakpoint
ALTER TABLE "wms"."routing_quota" ADD CONSTRAINT "routing_quota_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "wms"."routing_quota" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "routing_quota_tenant_fence" ON "wms"."routing_quota" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "routing_quota_touch_updated_at" BEFORE UPDATE ON "wms"."routing_quota" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();