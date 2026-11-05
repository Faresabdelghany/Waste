-- Ticket automation (#546 of #544): a Ticket Type's actions per trigger, in
-- order, each with the parameters its kind carries and no other. drizzle-kit's
-- statements first; then the table's fence, trigger and audit trail, a set of
-- its type.
CREATE TABLE "wms"."ticket_type_action" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ticket_type_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"team_id" uuid,
	"user_account_id" uuid,
	"priority" text,
	"command" text,
	"resolution" text,
	"message_template_name" text,
	"recipient" text,
	"follow_up_type_id" uuid,
	CONSTRAINT "ticket_type_action_ticket_type_id_trigger_position_key" UNIQUE("company_id","ticket_type_id","trigger","position"),
	CONSTRAINT "ticket_type_action_position_positive" CHECK ("wms"."ticket_type_action"."position" > 0),
	CONSTRAINT "ticket_type_action_trigger_one_of" CHECK ("wms"."ticket_type_action"."trigger" in ('opened', 'in-progress', 'pending', 'on-hold', 'completed', 'rejected')),
	CONSTRAINT "ticket_type_action_kind_one_of" CHECK ("wms"."ticket_type_action"."kind" in ('assign-team', 'assign-person', 'set-priority', 'set-status', 'send-message', 'open-follow-up')),
	CONSTRAINT "ticket_type_action_priority_one_of" CHECK ("wms"."ticket_type_action"."priority" in ('critical', 'high', 'medium', 'low', 'none')),
	CONSTRAINT "ticket_type_action_command_one_of" CHECK ("wms"."ticket_type_action"."command" in ('start', 'wait', 'hold', 'complete', 'reject')),
	CONSTRAINT "ticket_type_action_resolution_one_of" CHECK ("wms"."ticket_type_action"."resolution" in ('recollected', 'serviced', 'answered', 'no-action', 'duplicate')),
	CONSTRAINT "ticket_type_action_recipient_one_of" CHECK ("wms"."ticket_type_action"."recipient" in ('ticket-customer', 'owner', 'payer', 'tenant', 'administrator', 'service-contact')),
	CONSTRAINT "ticket_type_action_kind_shape" CHECK (case "wms"."ticket_type_action"."kind" when 'assign-team' then "wms"."ticket_type_action"."team_id" is not null and "wms"."ticket_type_action"."user_account_id" is null and "wms"."ticket_type_action"."priority" is null and "wms"."ticket_type_action"."command" is null and "wms"."ticket_type_action"."message_template_name" is null and "wms"."ticket_type_action"."recipient" is null and "wms"."ticket_type_action"."follow_up_type_id" is null and "wms"."ticket_type_action"."resolution" is null when 'assign-person' then "wms"."ticket_type_action"."team_id" is null and "wms"."ticket_type_action"."user_account_id" is not null and "wms"."ticket_type_action"."priority" is null and "wms"."ticket_type_action"."command" is null and "wms"."ticket_type_action"."message_template_name" is null and "wms"."ticket_type_action"."recipient" is null and "wms"."ticket_type_action"."follow_up_type_id" is null and "wms"."ticket_type_action"."resolution" is null when 'set-priority' then "wms"."ticket_type_action"."team_id" is null and "wms"."ticket_type_action"."user_account_id" is null and "wms"."ticket_type_action"."priority" is not null and "wms"."ticket_type_action"."command" is null and "wms"."ticket_type_action"."message_template_name" is null and "wms"."ticket_type_action"."recipient" is null and "wms"."ticket_type_action"."follow_up_type_id" is null and "wms"."ticket_type_action"."resolution" is null when 'set-status' then "wms"."ticket_type_action"."team_id" is null and "wms"."ticket_type_action"."user_account_id" is null and "wms"."ticket_type_action"."priority" is null and "wms"."ticket_type_action"."command" is not null and "wms"."ticket_type_action"."message_template_name" is null and "wms"."ticket_type_action"."recipient" is null and "wms"."ticket_type_action"."follow_up_type_id" is null and ("wms"."ticket_type_action"."command" = 'complete') = ("wms"."ticket_type_action"."resolution" is not null) when 'send-message' then "wms"."ticket_type_action"."team_id" is null and "wms"."ticket_type_action"."user_account_id" is null and "wms"."ticket_type_action"."priority" is null and "wms"."ticket_type_action"."command" is null and "wms"."ticket_type_action"."message_template_name" is not null and "wms"."ticket_type_action"."recipient" is not null and "wms"."ticket_type_action"."follow_up_type_id" is null and "wms"."ticket_type_action"."resolution" is null when 'open-follow-up' then "wms"."ticket_type_action"."team_id" is null and "wms"."ticket_type_action"."user_account_id" is null and "wms"."ticket_type_action"."priority" is null and "wms"."ticket_type_action"."command" is null and "wms"."ticket_type_action"."message_template_name" is null and "wms"."ticket_type_action"."recipient" is null and "wms"."ticket_type_action"."follow_up_type_id" is not null and "wms"."ticket_type_action"."resolution" is null else false end)
);
--> statement-breakpoint
ALTER TABLE "wms"."ticket_type_action" ADD CONSTRAINT "ticket_type_action_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket_type_action" ADD CONSTRAINT "ticket_type_action_ticket_type_id_fk" FOREIGN KEY ("company_id","ticket_type_id") REFERENCES "wms"."ticket_type"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket_type_action" ADD CONSTRAINT "ticket_type_action_team_id_fk" FOREIGN KEY ("company_id","team_id") REFERENCES "wms"."team"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket_type_action" ADD CONSTRAINT "ticket_type_action_user_account_id_fk" FOREIGN KEY ("company_id","user_account_id") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket_type_action" ADD CONSTRAINT "ticket_type_action_follow_up_type_id_fk" FOREIGN KEY ("company_id","follow_up_type_id") REFERENCES "wms"."ticket_type"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ticket_type_action_team_id_idx" ON "wms"."ticket_type_action" USING btree ("company_id","team_id");--> statement-breakpoint
CREATE INDEX "ticket_type_action_user_account_id_idx" ON "wms"."ticket_type_action" USING btree ("company_id","user_account_id");--> statement-breakpoint
CREATE INDEX "ticket_type_action_follow_up_type_id_idx" ON "wms"."ticket_type_action" USING btree ("company_id","follow_up_type_id");
--> statement-breakpoint
ALTER TABLE "wms"."ticket_type_action" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "ticket_type_action_tenant_fence" ON "wms"."ticket_type_action" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "ticket_type_action_touch_updated_at" BEFORE UPDATE ON "wms"."ticket_type_action" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER "ticket_type_action_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."ticket_type_action" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('ticket_type', 'ticket_type_id');