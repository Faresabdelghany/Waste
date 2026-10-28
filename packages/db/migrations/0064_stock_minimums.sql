-- A warehouse's Stock Minimums (O30 of #290, row 9.8): one new table, the
-- fewest containers of a type the office wants a warehouse to hold, a set
-- under its warehouse. Below drizzle-kit's statements, what the table owes
-- the file: its fence and trigger, and its audit trail as its warehouse's set.
CREATE TABLE "wms"."stock_minimum" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"container_type_id" uuid NOT NULL,
	"minimum" integer NOT NULL,
	CONSTRAINT "stock_minimum_warehouse_id_container_type_id_key" UNIQUE("company_id","warehouse_id","container_type_id"),
	CONSTRAINT "stock_minimum_minimum_positive" CHECK ("wms"."stock_minimum"."minimum" > 0)
);
--> statement-breakpoint
ALTER TABLE "wms"."stock_minimum" ADD CONSTRAINT "stock_minimum_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."stock_minimum" ADD CONSTRAINT "stock_minimum_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."stock_minimum" ADD CONSTRAINT "stock_minimum_warehouse_id_fk" FOREIGN KEY ("company_id","project_id","warehouse_id") REFERENCES "wms"."warehouse"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."stock_minimum" ADD CONSTRAINT "stock_minimum_container_type_id_fk" FOREIGN KEY ("company_id","container_type_id") REFERENCES "wms"."container_type"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_minimum_project_id_idx" ON "wms"."stock_minimum" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "stock_minimum_container_type_id_idx" ON "wms"."stock_minimum" USING btree ("company_id","container_type_id");--> statement-breakpoint
ALTER TABLE "wms"."stock_minimum" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "stock_minimum_tenant_fence" ON "wms"."stock_minimum" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "stock_minimum_touch_updated_at" BEFORE UPDATE ON "wms"."stock_minimum" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER "stock_minimum_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."stock_minimum" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('warehouse', 'warehouse_id');
