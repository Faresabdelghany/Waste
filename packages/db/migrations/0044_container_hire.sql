CREATE TABLE "wms"."work_order_product" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"service" text NOT NULL,
	"product_id" uuid NOT NULL,
	CONSTRAINT "work_order_product_project_id_service_key" UNIQUE("company_id","project_id","service"),
	CONSTRAINT "work_order_product_service_one_of" CHECK ("wms"."work_order_product"."service" in ('deliver', 'remove', 'swap', 'repair', 'wash'))
);
--> statement-breakpoint
ALTER TABLE "wms"."product" DROP CONSTRAINT "product_unit_one_of";--> statement-breakpoint
ALTER TABLE "wms"."billable_event" DROP CONSTRAINT "billable_event_kind_one_of";--> statement-breakpoint
ALTER TABLE "wms"."billable_event" DROP CONSTRAINT "billable_event_kind_shape";--> statement-breakpoint
ALTER TABLE "wms"."billable_event" DROP CONSTRAINT "billable_event_origin_shape";--> statement-breakpoint
ALTER TABLE "wms"."billable_event" DROP CONSTRAINT "billable_event_charge_shape";--> statement-breakpoint
ALTER TABLE "wms"."product" ADD COLUMN "free_days" integer;--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD COLUMN "container_id" uuid;--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD COLUMN "placement_id" uuid;--> statement-breakpoint
ALTER TABLE "wms"."work_order_product" ADD CONSTRAINT "work_order_product_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."work_order_product" ADD CONSTRAINT "work_order_product_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."work_order_product" ADD CONSTRAINT "work_order_product_product_id_fk" FOREIGN KEY ("company_id","project_id","product_id") REFERENCES "wms"."product"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_order_product_product_id_idx" ON "wms"."work_order_product" USING btree ("company_id","product_id");--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD CONSTRAINT "billable_event_container_id_placement_id_fk" FOREIGN KEY ("company_id","project_id","container_id","placement_id") REFERENCES "wms"."container_service_placement"("company_id","project_id","container_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billable_event_hire_charge_idx" ON "wms"."billable_event" USING btree ("company_id","placement_id","charge_period_from") WHERE "wms"."billable_event"."kind" = 'hire';--> statement-breakpoint
CREATE INDEX "billable_event_placement_id_idx" ON "wms"."billable_event" USING btree ("company_id","placement_id");--> statement-breakpoint
ALTER TABLE "wms"."product" ADD CONSTRAINT "product_free_days_shape" CHECK ("wms"."product"."free_days" is null or ("wms"."product"."unit" = 'day' and "wms"."product"."free_days" between 0 and 366));--> statement-breakpoint
ALTER TABLE "wms"."product" ADD CONSTRAINT "product_unit_one_of" CHECK ("wms"."product"."unit" in ('pickup', 'month', 'job', 'day'));--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD CONSTRAINT "billable_event_kind_one_of" CHECK ("wms"."billable_event"."kind" in ('pickup', 'ticket', 'manual', 'reversal', 'subscription', 'job', 'hire'));--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD CONSTRAINT "billable_event_kind_shape" CHECK (case "wms"."billable_event"."kind" when 'pickup' then "wms"."billable_event"."pickup_id" is not null and "wms"."billable_event"."ticket_id" is null and "wms"."billable_event"."reverses_event_id" is null when 'ticket' then "wms"."billable_event"."ticket_id" is not null and "wms"."billable_event"."pickup_id" is null and "wms"."billable_event"."reverses_event_id" is null when 'manual' then "wms"."billable_event"."pickup_id" is null and "wms"."billable_event"."ticket_id" is null and "wms"."billable_event"."reverses_event_id" is null and "wms"."billable_event"."created_by" is not null when 'reversal' then "wms"."billable_event"."reverses_event_id" is not null and "wms"."billable_event"."pickup_id" is null and "wms"."billable_event"."ticket_id" is null and "wms"."billable_event"."net_minor" is not null and "wms"."billable_event"."net_minor" <= 0 when 'subscription' then "wms"."billable_event"."subscription_id" is not null and "wms"."billable_event"."pickup_id" is null and "wms"."billable_event"."ticket_id" is null and "wms"."billable_event"."reverses_event_id" is null when 'job' then "wms"."billable_event"."pickup_id" is not null and "wms"."billable_event"."ticket_id" is null and "wms"."billable_event"."reverses_event_id" is null when 'hire' then "wms"."billable_event"."subscription_id" is not null and "wms"."billable_event"."placement_id" is not null and "wms"."billable_event"."pickup_id" is null and "wms"."billable_event"."ticket_id" is null and "wms"."billable_event"."reverses_event_id" is null else false end);--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD CONSTRAINT "billable_event_origin_shape" CHECK (case when "wms"."billable_event"."kind" in ('subscription', 'hire') then "wms"."billable_event"."created_by" is null and "wms"."billable_event"."source_event_id" is null else ("wms"."billable_event"."created_by" is null) = ("wms"."billable_event"."source_event_id" is not null) end);--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD CONSTRAINT "billable_event_charge_shape" CHECK (("wms"."billable_event"."kind" in ('subscription', 'hire')) = ("wms"."billable_event"."charge_period_from" is not null) and ("wms"."billable_event"."kind" = 'hire') = ("wms"."billable_event"."placement_id" is not null) and ("wms"."billable_event"."placement_id" is null) = ("wms"."billable_event"."container_id" is null) and ("wms"."billable_event"."charge_period_from" is null) = ("wms"."billable_event"."charge_period_to" is null) and ("wms"."billable_event"."charge_period_from" is null) = ("wms"."billable_event"."charged_days" is null) and ("wms"."billable_event"."charge_period_from" is null) = ("wms"."billable_event"."period_days" is null) and ("wms"."billable_event"."charge_period_to" is null or "wms"."billable_event"."charge_period_to" > "wms"."billable_event"."charge_period_from") and ("wms"."billable_event"."charged_days" is null or ("wms"."billable_event"."charged_days" > 0 and "wms"."billable_event"."charged_days" <= "wms"."billable_event"."period_days")));--> statement-breakpoint
ALTER TABLE "wms"."work_order_product" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "work_order_product_tenant_fence" ON "wms"."work_order_product" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "work_order_product_touch_updated_at" BEFORE UPDATE ON "wms"."work_order_product" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER "work_order_product_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."work_order_product" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('project', 'project_id');
