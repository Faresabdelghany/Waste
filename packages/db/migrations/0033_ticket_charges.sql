CREATE TABLE "wms"."ticket_kind_product" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ticket_kind" text NOT NULL,
	"product_id" uuid NOT NULL,
	CONSTRAINT "ticket_kind_product_project_id_ticket_kind_key" UNIQUE("company_id","project_id","ticket_kind"),
	CONSTRAINT "ticket_kind_product_ticket_kind_one_of" CHECK ("wms"."ticket_kind_product"."ticket_kind" in ('missed-collection', 'overflow', 'access-issue', 'container-request', 'container-defect', 'proof-follow-up', 'complaint', 'reported-problem', 'rejected-command', 'internal-task', 'other'))
);
--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD COLUMN "charge_product_id" uuid;--> statement-breakpoint
ALTER TABLE "wms"."ticket_kind_product" ADD CONSTRAINT "ticket_kind_product_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket_kind_product" ADD CONSTRAINT "ticket_kind_product_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket_kind_product" ADD CONSTRAINT "ticket_kind_product_product_id_fk" FOREIGN KEY ("company_id","project_id","product_id") REFERENCES "wms"."product"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ticket_kind_product_product_id_idx" ON "wms"."ticket_kind_product" USING btree ("company_id","product_id");--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_charge_product_id_fk" FOREIGN KEY ("company_id","project_id","charge_product_id") REFERENCES "wms"."product"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ticket_charge_product_id_idx" ON "wms"."ticket" USING btree ("company_id","charge_product_id");--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_charge_shape" CHECK ("wms"."ticket"."charge_product_id" is null or ("wms"."ticket"."resolution" is not null and "wms"."ticket"."resolution" in ('recollected', 'serviced')));--> statement-breakpoint
ALTER TABLE "wms"."ticket_kind_product" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "ticket_kind_product_tenant_fence" ON "wms"."ticket_kind_product" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));--> statement-breakpoint
CREATE TRIGGER "ticket_kind_product_touch_updated_at" BEFORE UPDATE ON "wms"."ticket_kind_product" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();--> statement-breakpoint
CREATE TRIGGER "ticket_kind_product_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."ticket_kind_product" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('project', 'project_id');
