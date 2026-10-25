CREATE TABLE "wms"."accounting_account" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"number" text NOT NULL,
	"name" text NOT NULL,
	"standard_account" text,
	CONSTRAINT "accounting_account_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "accounting_account_project_id_number_key" UNIQUE("company_id","project_id","number"),
	CONSTRAINT "accounting_account_number_shape" CHECK ("wms"."accounting_account"."number" ~ '^[0-9A-Za-z][0-9A-Za-z.-]{0,19}$' and ("wms"."accounting_account"."standard_account" is null or "wms"."accounting_account"."standard_account" ~ '^[0-9A-Za-z][0-9A-Za-z.-]{0,19}$'))
);
--> statement-breakpoint
CREATE TABLE "wms"."accounting_export" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"voucher_from" integer NOT NULL,
	"voucher_to" integer NOT NULL,
	"line_count" integer NOT NULL,
	"created_by" uuid,
	"note" text,
	CONSTRAINT "accounting_export_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "accounting_export_shape" CHECK ("wms"."accounting_export"."period_to" >= "wms"."accounting_export"."period_from" and "wms"."accounting_export"."voucher_from" > 0 and "wms"."accounting_export"."voucher_to" >= "wms"."accounting_export"."voucher_from" and "wms"."accounting_export"."line_count" > 0)
);
--> statement-breakpoint
CREATE TABLE "wms"."accounting_export_line" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voucher_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"account_number" text NOT NULL,
	"account_name" text NOT NULL,
	"vat_code" text,
	"amount_minor" bigint NOT NULL,
	"text" text NOT NULL,
	CONSTRAINT "accounting_export_line_voucher_id_position_key" UNIQUE("company_id","voucher_id","position"),
	CONSTRAINT "accounting_export_line_position_positive" CHECK ("wms"."accounting_export_line"."position" > 0)
);
--> statement-breakpoint
CREATE TABLE "wms"."accounting_export_voucher" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"export_id" uuid NOT NULL,
	"voucher" integer NOT NULL,
	"booked_on" date NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" uuid NOT NULL,
	"document" text,
	"currency" text NOT NULL,
	"customer_name" text,
	"back_dated" boolean NOT NULL,
	CONSTRAINT "accounting_export_voucher_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "accounting_export_voucher_source_kind_source_id_key" UNIQUE("company_id","source_kind","source_id"),
	CONSTRAINT "accounting_export_voucher_project_id_voucher_key" UNIQUE("company_id","project_id","voucher"),
	CONSTRAINT "accounting_export_voucher_source_kind_one_of" CHECK ("wms"."accounting_export_voucher"."source_kind" in ('invoice', 'credit-note', 'payment', 'allocation')),
	CONSTRAINT "accounting_export_voucher_voucher_positive" CHECK ("wms"."accounting_export_voucher"."voucher" > 0)
);
--> statement-breakpoint
CREATE TABLE "wms"."accounting_product_account" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"product_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	CONSTRAINT "accounting_product_account_project_id_product_id_key" UNIQUE("company_id","project_id","product_id")
);
--> statement-breakpoint
CREATE TABLE "wms"."accounting_settings" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"receivable_account_id" uuid,
	"bank_account_id" uuid,
	"suspense_account_id" uuid,
	"revenue_account_id" uuid,
	"exports_from" date,
	CONSTRAINT "accounting_settings_project_id_key" UNIQUE("company_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "wms"."accounting_vat_code" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"vat_percent" integer NOT NULL,
	"code" text NOT NULL,
	"account_id" uuid NOT NULL,
	CONSTRAINT "accounting_vat_code_project_id_vat_percent_key" UNIQUE("company_id","project_id","vat_percent"),
	CONSTRAINT "accounting_vat_code_shape" CHECK ("wms"."accounting_vat_code"."vat_percent" >= 0 and "wms"."accounting_vat_code"."vat_percent" <= 100 and "wms"."accounting_vat_code"."code" ~ '^[0-9A-Za-z][0-9A-Za-z_-]{0,8}$')
);
--> statement-breakpoint
ALTER TABLE "wms"."accounting_account" ADD CONSTRAINT "accounting_account_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."accounting_account" ADD CONSTRAINT "accounting_account_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."accounting_export" ADD CONSTRAINT "accounting_export_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."accounting_export" ADD CONSTRAINT "accounting_export_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."accounting_export" ADD CONSTRAINT "accounting_export_created_by_fk" FOREIGN KEY ("company_id","created_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."accounting_export_line" ADD CONSTRAINT "accounting_export_line_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."accounting_export_line" ADD CONSTRAINT "accounting_export_line_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."accounting_export_line" ADD CONSTRAINT "accounting_export_line_voucher_id_fk" FOREIGN KEY ("company_id","project_id","voucher_id") REFERENCES "wms"."accounting_export_voucher"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."accounting_export_voucher" ADD CONSTRAINT "accounting_export_voucher_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."accounting_export_voucher" ADD CONSTRAINT "accounting_export_voucher_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."accounting_export_voucher" ADD CONSTRAINT "accounting_export_voucher_export_id_fk" FOREIGN KEY ("company_id","project_id","export_id") REFERENCES "wms"."accounting_export"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."accounting_product_account" ADD CONSTRAINT "accounting_product_account_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."accounting_product_account" ADD CONSTRAINT "accounting_product_account_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."accounting_product_account" ADD CONSTRAINT "accounting_product_account_product_id_fk" FOREIGN KEY ("company_id","project_id","product_id") REFERENCES "wms"."product"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."accounting_product_account" ADD CONSTRAINT "accounting_product_account_account_id_fk" FOREIGN KEY ("company_id","project_id","account_id") REFERENCES "wms"."accounting_account"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."accounting_settings" ADD CONSTRAINT "accounting_settings_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."accounting_settings" ADD CONSTRAINT "accounting_settings_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."accounting_settings" ADD CONSTRAINT "accounting_settings_receivable_account_id_fk" FOREIGN KEY ("company_id","project_id","receivable_account_id") REFERENCES "wms"."accounting_account"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."accounting_settings" ADD CONSTRAINT "accounting_settings_bank_account_id_fk" FOREIGN KEY ("company_id","project_id","bank_account_id") REFERENCES "wms"."accounting_account"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."accounting_settings" ADD CONSTRAINT "accounting_settings_suspense_account_id_fk" FOREIGN KEY ("company_id","project_id","suspense_account_id") REFERENCES "wms"."accounting_account"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."accounting_settings" ADD CONSTRAINT "accounting_settings_revenue_account_id_fk" FOREIGN KEY ("company_id","project_id","revenue_account_id") REFERENCES "wms"."accounting_account"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."accounting_vat_code" ADD CONSTRAINT "accounting_vat_code_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."accounting_vat_code" ADD CONSTRAINT "accounting_vat_code_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."accounting_vat_code" ADD CONSTRAINT "accounting_vat_code_account_id_fk" FOREIGN KEY ("company_id","project_id","account_id") REFERENCES "wms"."accounting_account"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounting_export_project_id_period_from_idx" ON "wms"."accounting_export" USING btree ("company_id","project_id","period_from");--> statement-breakpoint
CREATE INDEX "accounting_export_created_by_idx" ON "wms"."accounting_export" USING btree ("company_id","created_by");--> statement-breakpoint
CREATE INDEX "accounting_export_voucher_export_id_idx" ON "wms"."accounting_export_voucher" USING btree ("company_id","export_id");--> statement-breakpoint
CREATE INDEX "accounting_product_account_product_id_idx" ON "wms"."accounting_product_account" USING btree ("company_id","product_id");--> statement-breakpoint
CREATE INDEX "accounting_product_account_account_id_idx" ON "wms"."accounting_product_account" USING btree ("company_id","account_id");--> statement-breakpoint
CREATE INDEX "accounting_settings_receivable_account_id_idx" ON "wms"."accounting_settings" USING btree ("company_id","receivable_account_id");--> statement-breakpoint
CREATE INDEX "accounting_settings_bank_account_id_idx" ON "wms"."accounting_settings" USING btree ("company_id","bank_account_id");--> statement-breakpoint
CREATE INDEX "accounting_settings_suspense_account_id_idx" ON "wms"."accounting_settings" USING btree ("company_id","suspense_account_id");--> statement-breakpoint
CREATE INDEX "accounting_settings_revenue_account_id_idx" ON "wms"."accounting_settings" USING btree ("company_id","revenue_account_id");--> statement-breakpoint
CREATE INDEX "accounting_vat_code_account_id_idx" ON "wms"."accounting_vat_code" USING btree ("company_id","account_id");--> statement-breakpoint
ALTER TABLE "wms"."accounting_account" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "accounting_account_tenant_fence" ON "wms"."accounting_account" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));--> statement-breakpoint
CREATE TRIGGER "accounting_account_touch_updated_at" BEFORE UPDATE ON "wms"."accounting_account" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();--> statement-breakpoint
ALTER TABLE "wms"."accounting_settings" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "accounting_settings_tenant_fence" ON "wms"."accounting_settings" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));--> statement-breakpoint
CREATE TRIGGER "accounting_settings_touch_updated_at" BEFORE UPDATE ON "wms"."accounting_settings" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();--> statement-breakpoint
ALTER TABLE "wms"."accounting_vat_code" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "accounting_vat_code_tenant_fence" ON "wms"."accounting_vat_code" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));--> statement-breakpoint
CREATE TRIGGER "accounting_vat_code_touch_updated_at" BEFORE UPDATE ON "wms"."accounting_vat_code" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();--> statement-breakpoint
ALTER TABLE "wms"."accounting_product_account" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "accounting_product_account_tenant_fence" ON "wms"."accounting_product_account" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));--> statement-breakpoint
CREATE TRIGGER "accounting_product_account_touch_updated_at" BEFORE UPDATE ON "wms"."accounting_product_account" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();--> statement-breakpoint
ALTER TABLE "wms"."accounting_export" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "accounting_export_tenant_fence" ON "wms"."accounting_export" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));--> statement-breakpoint
REVOKE UPDATE, DELETE ON "wms"."accounting_export" FROM wms_api;--> statement-breakpoint
ALTER TABLE "wms"."accounting_export_voucher" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "accounting_export_voucher_tenant_fence" ON "wms"."accounting_export_voucher" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));--> statement-breakpoint
REVOKE UPDATE, DELETE ON "wms"."accounting_export_voucher" FROM wms_api;--> statement-breakpoint
ALTER TABLE "wms"."accounting_export_line" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "accounting_export_line_tenant_fence" ON "wms"."accounting_export_line" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));--> statement-breakpoint
REVOKE UPDATE, DELETE ON "wms"."accounting_export_line" FROM wms_api;--> statement-breakpoint
CREATE TRIGGER "accounting_account_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."accounting_account" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('project', 'project_id');--> statement-breakpoint
CREATE TRIGGER "accounting_settings_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."accounting_settings" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('project', 'project_id');--> statement-breakpoint
CREATE TRIGGER "accounting_vat_code_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."accounting_vat_code" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('project', 'project_id');--> statement-breakpoint
CREATE TRIGGER "accounting_product_account_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."accounting_product_account" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('project', 'project_id');
