CREATE TABLE "wms"."import_run" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid,
	"kind" text NOT NULL,
	"file_name" text NOT NULL,
	"row_count" integer NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"unchanged_count" integer DEFAULT 0 NOT NULL,
	"refused_count" integer DEFAULT 0 NOT NULL,
	"requested_by" uuid NOT NULL,
	CONSTRAINT "import_run_tenant_key" UNIQUE("company_id","id"),
	CONSTRAINT "import_run_kind_one_of" CHECK ("wms"."import_run"."kind" in ('customers', 'properties', 'containers', 'agreements')),
	CONSTRAINT "import_run_row_count_positive" CHECK ("wms"."import_run"."row_count" > 0),
	CONSTRAINT "import_run_project_shape" CHECK (("wms"."import_run"."kind" = 'customers') = ("wms"."import_run"."project_id" is null)),
	CONSTRAINT "import_run_counts_shape" CHECK ("wms"."import_run"."created_count" >= 0 and "wms"."import_run"."updated_count" >= 0 and "wms"."import_run"."unchanged_count" >= 0 and "wms"."import_run"."refused_count" >= 0 and "wms"."import_run"."created_count" + "wms"."import_run"."updated_count" + "wms"."import_run"."unchanged_count" + "wms"."import_run"."refused_count" <= "wms"."import_run"."row_count")
);
--> statement-breakpoint
CREATE TABLE "wms"."import_run_row" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"import_run_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"outcome" text NOT NULL,
	"key" text,
	"resource_id" uuid,
	"detail" text,
	CONSTRAINT "import_run_row_import_run_id_row_number_key" UNIQUE("company_id","import_run_id","row_number"),
	CONSTRAINT "import_run_row_outcome_one_of" CHECK ("wms"."import_run_row"."outcome" in ('created', 'updated', 'unchanged', 'refused')),
	CONSTRAINT "import_run_row_row_number_shape" CHECK ("wms"."import_run_row"."row_number" >= 2),
	CONSTRAINT "import_run_row_outcome_shape" CHECK (("wms"."import_run_row"."outcome" = 'refused') = ("wms"."import_run_row"."detail" is not null) and ("wms"."import_run_row"."outcome" = 'refused') = ("wms"."import_run_row"."resource_id" is null))
);
--> statement-breakpoint
ALTER TABLE "wms"."import_run" ADD CONSTRAINT "import_run_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."import_run" ADD CONSTRAINT "import_run_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."import_run" ADD CONSTRAINT "import_run_requested_by_fk" FOREIGN KEY ("company_id","requested_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."import_run_row" ADD CONSTRAINT "import_run_row_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."import_run_row" ADD CONSTRAINT "import_run_row_import_run_id_fk" FOREIGN KEY ("company_id","import_run_id") REFERENCES "wms"."import_run"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_run_project_id_idx" ON "wms"."import_run" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "import_run_requested_by_idx" ON "wms"."import_run" USING btree ("company_id","requested_by");
--> statement-breakpoint
ALTER TABLE "wms"."import_run" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "import_run_tenant_fence" ON "wms"."import_run" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "import_run_touch_updated_at" BEFORE UPDATE ON "wms"."import_run" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."import_run_row" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "import_run_row_tenant_fence" ON "wms"."import_run_row" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "wms"."import_run_row" FROM wms_api;
