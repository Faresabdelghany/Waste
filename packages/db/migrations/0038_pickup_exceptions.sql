CREATE TABLE "wms"."contaminant_code" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	CONSTRAINT "contaminant_code_code_key" UNIQUE("company_id","code"),
	CONSTRAINT "contaminant_code_name_key" UNIQUE("company_id","name"),
	CONSTRAINT "contaminant_code_tenant_key" UNIQUE("company_id","id"),
	CONSTRAINT "contaminant_code_code_lowercase" CHECK ("wms"."contaminant_code"."code" = lower("wms"."contaminant_code"."code")),
	CONSTRAINT "contaminant_code_status_one_of" CHECK ("wms"."contaminant_code"."status" in ('active', 'inactive'))
);
--> statement-breakpoint
CREATE TABLE "wms"."contaminant_code_fraction" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"contaminant_code_id" uuid NOT NULL,
	"waste_fraction_id" uuid NOT NULL,
	CONSTRAINT "contaminant_code_fraction_membership_key" UNIQUE("company_id","contaminant_code_id","waste_fraction_id")
);
--> statement-breakpoint
CREATE TABLE "wms"."pickup_exception_rule" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"outcome" text NOT NULL,
	"reason" text,
	"contaminant_code_id" uuid,
	"free_count" integer NOT NULL,
	"window_days" integer NOT NULL,
	"match_key" text GENERATED ALWAYS AS ("outcome" || '/' || coalesce("reason", '*') || '/' || coalesce("contaminant_code_id"::text, '*')) STORED NOT NULL,
	CONSTRAINT "pickup_exception_rule_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "pickup_exception_rule_validity" CHECK ("wms"."pickup_exception_rule"."valid_to" is null or "wms"."pickup_exception_rule"."valid_to" > "wms"."pickup_exception_rule"."valid_from"),
	CONSTRAINT "pickup_exception_rule_outcome_one_of" CHECK ("wms"."pickup_exception_rule"."outcome" in ('completed', 'skipped', 'failed')),
	CONSTRAINT "pickup_exception_rule_reason_one_of" CHECK ("wms"."pickup_exception_rule"."reason" in ('contamination', 'not-presented', 'inaccessible', 'other')),
	CONSTRAINT "pickup_exception_rule_reason_shape" CHECK ("wms"."pickup_exception_rule"."outcome" <> 'completed' or "wms"."pickup_exception_rule"."reason" is null),
	CONSTRAINT "pickup_exception_rule_code_shape" CHECK ("wms"."pickup_exception_rule"."contaminant_code_id" is null or "wms"."pickup_exception_rule"."reason" is null or "wms"."pickup_exception_rule"."reason" = 'contamination'),
	CONSTRAINT "pickup_exception_rule_free_count_not_negative" CHECK ("wms"."pickup_exception_rule"."free_count" >= 0),
	CONSTRAINT "pickup_exception_rule_window_days_range" CHECK ("wms"."pickup_exception_rule"."window_days" between 1 and 3660)
);
--> statement-breakpoint
CREATE TABLE "wms"."pickup_exception_rule_step" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rule_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"product_id" uuid NOT NULL,
	CONSTRAINT "pickup_exception_rule_step_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "pickup_exception_rule_step_rule_position_key" UNIQUE("company_id","rule_id","position"),
	CONSTRAINT "pickup_exception_rule_step_position_positive" CHECK ("wms"."pickup_exception_rule_step"."position" > 0)
);
--> statement-breakpoint
ALTER TABLE "wms"."pickup" ADD COLUMN "contaminant_code_id" uuid;--> statement-breakpoint
ALTER TABLE "wms"."proof_of_service" ADD COLUMN "contaminant_code_id" uuid;--> statement-breakpoint
ALTER TABLE "wms"."contaminant_code" ADD CONSTRAINT "contaminant_code_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."contaminant_code_fraction" ADD CONSTRAINT "contaminant_code_fraction_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."contaminant_code_fraction" ADD CONSTRAINT "contaminant_code_fraction_contaminant_code_id_fk" FOREIGN KEY ("company_id","contaminant_code_id") REFERENCES "wms"."contaminant_code"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."contaminant_code_fraction" ADD CONSTRAINT "contaminant_code_fraction_waste_fraction_id_fk" FOREIGN KEY ("company_id","waste_fraction_id") REFERENCES "wms"."waste_fraction"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."pickup_exception_rule" ADD CONSTRAINT "pickup_exception_rule_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."pickup_exception_rule" ADD CONSTRAINT "pickup_exception_rule_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."pickup_exception_rule" ADD CONSTRAINT "pickup_exception_rule_contaminant_code_id_fk" FOREIGN KEY ("company_id","contaminant_code_id") REFERENCES "wms"."contaminant_code"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."pickup_exception_rule_step" ADD CONSTRAINT "pickup_exception_rule_step_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."pickup_exception_rule_step" ADD CONSTRAINT "pickup_exception_rule_step_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."pickup_exception_rule_step" ADD CONSTRAINT "pickup_exception_rule_step_rule_id_fk" FOREIGN KEY ("company_id","project_id","rule_id") REFERENCES "wms"."pickup_exception_rule"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."pickup_exception_rule_step" ADD CONSTRAINT "pickup_exception_rule_step_product_id_fk" FOREIGN KEY ("company_id","project_id","product_id") REFERENCES "wms"."product"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contaminant_code_fraction_waste_fraction_id_idx" ON "wms"."contaminant_code_fraction" USING btree ("company_id","waste_fraction_id");--> statement-breakpoint
CREATE INDEX "pickup_exception_rule_project_id_idx" ON "wms"."pickup_exception_rule" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "pickup_exception_rule_contaminant_code_id_idx" ON "wms"."pickup_exception_rule" USING btree ("company_id","contaminant_code_id");--> statement-breakpoint
CREATE INDEX "pickup_exception_rule_step_product_id_idx" ON "wms"."pickup_exception_rule_step" USING btree ("company_id","product_id");--> statement-breakpoint
ALTER TABLE "wms"."pickup" ADD CONSTRAINT "pickup_contaminant_code_id_fk" FOREIGN KEY ("company_id","contaminant_code_id") REFERENCES "wms"."contaminant_code"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."proof_of_service" ADD CONSTRAINT "proof_of_service_contaminant_code_id_fk" FOREIGN KEY ("company_id","contaminant_code_id") REFERENCES "wms"."contaminant_code"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pickup_contaminant_code_id_idx" ON "wms"."pickup" USING btree ("company_id","contaminant_code_id");--> statement-breakpoint
CREATE INDEX "proof_of_service_contaminant_code_id_idx" ON "wms"."proof_of_service" USING btree ("company_id","contaminant_code_id");--> statement-breakpoint
ALTER TABLE "wms"."pickup" ADD CONSTRAINT "pickup_contaminant_code_shape" CHECK ("wms"."pickup"."contaminant_code_id" is null or "wms"."pickup"."reason" = 'contamination' or "wms"."pickup"."status" = 'completed');--> statement-breakpoint
ALTER TABLE "wms"."proof_of_service" ADD CONSTRAINT "proof_of_service_contaminant_code_shape" CHECK ("wms"."proof_of_service"."contaminant_code_id" is null or "wms"."proof_of_service"."kind" in ('completion', 'skip', 'failure', 'correction'));--> statement-breakpoint
ALTER TABLE "wms"."contaminant_code" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "contaminant_code_tenant_fence" ON "wms"."contaminant_code" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "contaminant_code_touch_updated_at" BEFORE UPDATE ON "wms"."contaminant_code" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."contaminant_code_fraction" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "contaminant_code_fraction_tenant_fence" ON "wms"."contaminant_code_fraction" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "contaminant_code_fraction_touch_updated_at" BEFORE UPDATE ON "wms"."contaminant_code_fraction" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."pickup_exception_rule" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "pickup_exception_rule_tenant_fence" ON "wms"."pickup_exception_rule" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "pickup_exception_rule_touch_updated_at" BEFORE UPDATE ON "wms"."pickup_exception_rule" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."pickup_exception_rule_step" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "pickup_exception_rule_step_tenant_fence" ON "wms"."pickup_exception_rule_step" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "pickup_exception_rule_step_touch_updated_at" BEFORE UPDATE ON "wms"."pickup_exception_rule_step" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."pickup_exception_rule" ADD CONSTRAINT "pickup_exception_rule_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "project_id" WITH =, "match_key" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);
--> statement-breakpoint
CREATE TRIGGER "contaminant_code_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."contaminant_code" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "contaminant_code_fraction_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."contaminant_code_fraction" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('contaminant_code', 'contaminant_code_id');
--> statement-breakpoint
CREATE TRIGGER "pickup_exception_rule_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."pickup_exception_rule" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "pickup_exception_rule_step_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."pickup_exception_rule_step" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('pickup_exception_rule', 'rule_id');
