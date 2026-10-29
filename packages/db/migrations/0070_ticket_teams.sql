-- Ticket teams (O30 of #290, row 7.20): the company's teams with their
-- members, the team a ticket waits with, and a project's default team per
-- ticket kind, which `openTicket` gives a ticket whose opener names none.
-- drizzle-kit's statements first; then the three tables' fences and
-- triggers, and their audit trails, since the office's edits are history.
-- `ticket.team_id` is null on every existing ticket: none waits with a team.
CREATE TABLE "wms"."team" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	CONSTRAINT "team_name_key" UNIQUE("company_id","name"),
	CONSTRAINT "team_tenant_key" UNIQUE("company_id","id"),
	CONSTRAINT "team_status_one_of" CHECK ("wms"."team"."status" in ('active', 'inactive'))
);
--> statement-breakpoint
CREATE TABLE "wms"."team_member" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"team_id" uuid NOT NULL,
	"user_account_id" uuid NOT NULL,
	CONSTRAINT "team_member_membership_key" UNIQUE("company_id","team_id","user_account_id")
);
--> statement-breakpoint
CREATE TABLE "wms"."ticket_team_default" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"team_id" uuid NOT NULL,
	CONSTRAINT "ticket_team_default_project_id_kind_key" UNIQUE("company_id","project_id","kind"),
	CONSTRAINT "ticket_team_default_kind_one_of" CHECK ("wms"."ticket_team_default"."kind" in ('missed-collection', 'overflow', 'access-issue', 'container-request', 'container-defect', 'proof-follow-up', 'complaint', 'reported-problem', 'rejected-command', 'internal-task', 'other'))
);
--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD COLUMN "team_id" uuid;--> statement-breakpoint
ALTER TABLE "wms"."team" ADD CONSTRAINT "team_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."team_member" ADD CONSTRAINT "team_member_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."team_member" ADD CONSTRAINT "team_member_team_id_fk" FOREIGN KEY ("company_id","team_id") REFERENCES "wms"."team"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."team_member" ADD CONSTRAINT "team_member_user_account_id_fk" FOREIGN KEY ("company_id","user_account_id") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket_team_default" ADD CONSTRAINT "ticket_team_default_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket_team_default" ADD CONSTRAINT "ticket_team_default_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket_team_default" ADD CONSTRAINT "ticket_team_default_team_id_fk" FOREIGN KEY ("company_id","team_id") REFERENCES "wms"."team"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_member_user_account_id_idx" ON "wms"."team_member" USING btree ("company_id","user_account_id");--> statement-breakpoint
CREATE INDEX "ticket_team_default_team_id_idx" ON "wms"."ticket_team_default" USING btree ("company_id","team_id");--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_team_id_fk" FOREIGN KEY ("company_id","team_id") REFERENCES "wms"."team"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ticket_team_id_status_idx" ON "wms"."ticket" USING btree ("company_id","team_id","status");--> statement-breakpoint
ALTER TABLE "wms"."team" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "team_tenant_fence" ON "wms"."team" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "team_touch_updated_at" BEFORE UPDATE ON "wms"."team" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."team_member" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "team_member_tenant_fence" ON "wms"."team_member" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "team_member_touch_updated_at" BEFORE UPDATE ON "wms"."team_member" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."ticket_team_default" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "ticket_team_default_tenant_fence" ON "wms"."ticket_team_default" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "ticket_team_default_touch_updated_at" BEFORE UPDATE ON "wms"."ticket_team_default" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER "team_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."team" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "team_member_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."team_member" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('team', 'team_id');
--> statement-breakpoint
CREATE TRIGGER "ticket_team_default_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."ticket_team_default" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('project', 'project_id');
