CREATE TABLE "wms"."ticket_sla" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text,
	"priority" text NOT NULL,
	"hours" integer NOT NULL,
	CONSTRAINT "ticket_sla_project_id_kind_priority_key" UNIQUE NULLS NOT DISTINCT("company_id","project_id","kind","priority"),
	CONSTRAINT "ticket_sla_kind_one_of" CHECK ("wms"."ticket_sla"."kind" in ('missed-collection', 'overflow', 'access-issue', 'container-request', 'container-defect', 'proof-follow-up', 'complaint', 'reported-problem', 'rejected-command', 'internal-task', 'other')),
	CONSTRAINT "ticket_sla_priority_one_of" CHECK ("wms"."ticket_sla"."priority" in ('critical', 'high', 'medium', 'low', 'none')),
	CONSTRAINT "ticket_sla_hours_range" CHECK ("wms"."ticket_sla"."hours" between 1 and 8760)
);
--> statement-breakpoint
ALTER TABLE "wms"."ticket_sla" ADD CONSTRAINT "ticket_sla_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket_sla" ADD CONSTRAINT "ticket_sla_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket_sla" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "ticket_sla_tenant_fence" ON "wms"."ticket_sla" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "ticket_sla_touch_updated_at" BEFORE UPDATE ON "wms"."ticket_sla" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER "ticket_sla_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."ticket_sla" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('project', 'project_id');
