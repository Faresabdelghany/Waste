-- Ticket Types (#545 of #544): the company's own types of case, each inside
-- one kind, with their custom fields and the roles that may give each status
-- command; a ticket's type, held to its kind by a key over both, and its
-- fields' values. drizzle-kit's statements first, but for the ticket's type,
-- which it writes as one NOT NULL ADD COLUMN that a database holding tickets
-- refuses: here it is added nullable, then, hand-written and run by the
-- owner, every company is given one default type per kind and every ticket
-- already opened its kind's default (src/sql/ticket-types.ts), and the column
-- is made NOT NULL; then the three tables' fences, triggers and audit trails.
CREATE TABLE "wms"."ticket_type" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	CONSTRAINT "ticket_type_name_key" UNIQUE("company_id","name"),
	CONSTRAINT "ticket_type_tenant_key" UNIQUE("company_id","id"),
	CONSTRAINT "ticket_type_kind_key" UNIQUE("company_id","id","kind"),
	CONSTRAINT "ticket_type_kind_one_of" CHECK ("wms"."ticket_type"."kind" in ('missed-collection', 'overflow', 'access-issue', 'container-request', 'container-defect', 'proof-follow-up', 'complaint', 'reported-problem', 'rejected-command', 'internal-task', 'vehicle-defect', 'other')),
	CONSTRAINT "ticket_type_status_one_of" CHECK ("wms"."ticket_type"."status" in ('active', 'inactive')),
	CONSTRAINT "ticket_type_default_shape" CHECK (not "wms"."ticket_type"."is_default" or "wms"."ticket_type"."status" = 'active')
);
--> statement-breakpoint
CREATE TABLE "wms"."ticket_type_field" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ticket_type_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"help_text" text,
	"input" text NOT NULL,
	"choices" text[] DEFAULT '{}'::text[] NOT NULL,
	"requirement" text DEFAULT 'optional' NOT NULL,
	CONSTRAINT "ticket_type_field_ticket_type_id_key_key" UNIQUE("company_id","ticket_type_id","key"),
	CONSTRAINT "ticket_type_field_ticket_type_id_position_key" UNIQUE("company_id","ticket_type_id","position"),
	CONSTRAINT "ticket_type_field_position_positive" CHECK ("wms"."ticket_type_field"."position" > 0),
	CONSTRAINT "ticket_type_field_key_lowercase" CHECK ("wms"."ticket_type_field"."key" = lower("wms"."ticket_type_field"."key")),
	CONSTRAINT "ticket_type_field_input_one_of" CHECK ("wms"."ticket_type_field"."input" in ('text', 'paragraph', 'number', 'date', 'yes-no', 'choice')),
	CONSTRAINT "ticket_type_field_requirement_one_of" CHECK ("wms"."ticket_type_field"."requirement" in ('optional', 'to-open', 'to-complete')),
	CONSTRAINT "ticket_type_field_choices_shape" CHECK (("wms"."ticket_type_field"."input" = 'choice') = (cardinality("wms"."ticket_type_field"."choices") > 0))
);
--> statement-breakpoint
CREATE TABLE "wms"."ticket_type_permission" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ticket_type_id" uuid NOT NULL,
	"command" text NOT NULL,
	"role_id" uuid NOT NULL,
	CONSTRAINT "ticket_type_permission_grant_key" UNIQUE("company_id","ticket_type_id","command","role_id"),
	CONSTRAINT "ticket_type_permission_command_one_of" CHECK ("wms"."ticket_type_permission"."command" in ('start', 'wait', 'hold', 'complete', 'reject', 'reopen'))
);
--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD COLUMN "ticket_type_id" uuid;--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD COLUMN "field_values" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "wms"."ticket_type" ADD CONSTRAINT "ticket_type_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket_type_field" ADD CONSTRAINT "ticket_type_field_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket_type_field" ADD CONSTRAINT "ticket_type_field_ticket_type_id_fk" FOREIGN KEY ("company_id","ticket_type_id") REFERENCES "wms"."ticket_type"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket_type_permission" ADD CONSTRAINT "ticket_type_permission_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket_type_permission" ADD CONSTRAINT "ticket_type_permission_ticket_type_id_fk" FOREIGN KEY ("company_id","ticket_type_id") REFERENCES "wms"."ticket_type"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket_type_permission" ADD CONSTRAINT "ticket_type_permission_role_id_fk" FOREIGN KEY ("company_id","role_id") REFERENCES "wms"."role"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_type_default_kind_key" ON "wms"."ticket_type" USING btree ("company_id","kind") WHERE "wms"."ticket_type"."is_default";--> statement-breakpoint
CREATE INDEX "ticket_type_permission_role_id_idx" ON "wms"."ticket_type_permission" USING btree ("company_id","role_id");--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_ticket_type_id_kind_fk" FOREIGN KEY ("company_id","ticket_type_id","kind") REFERENCES "wms"."ticket_type"("company_id","id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ticket_ticket_type_id_kind_idx" ON "wms"."ticket" USING btree ("company_id","ticket_type_id","kind");--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_field_values_shape" CHECK (jsonb_typeof("wms"."ticket"."field_values") = 'object');
--> statement-breakpoint
INSERT INTO "wms"."ticket_type" ("company_id", "kind", "name", "is_default") SELECT c."id", v."kind", v."name", true FROM "wms"."company" AS c CROSS JOIN (VALUES ('missed-collection', 'Missed collection'), ('overflow', 'Overflow'), ('access-issue', 'Access issue'), ('container-request', 'Container request'), ('container-defect', 'Container defect'), ('proof-follow-up', 'Proof follow-up'), ('complaint', 'Complaint'), ('reported-problem', 'Reported problem'), ('rejected-command', 'Rejected command'), ('internal-task', 'Internal task'), ('vehicle-defect', 'Vehicle defect'), ('other', 'Other')) AS v ("kind", "name") ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "wms"."ticket" AS t SET "ticket_type_id" = y."id" FROM "wms"."ticket_type" AS y WHERE y."company_id" = t."company_id" AND y."kind" = t."kind" AND y."is_default" AND t."ticket_type_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "wms"."ticket" ALTER COLUMN "ticket_type_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "wms"."ticket_type" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "ticket_type_tenant_fence" ON "wms"."ticket_type" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "ticket_type_touch_updated_at" BEFORE UPDATE ON "wms"."ticket_type" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."ticket_type_field" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "ticket_type_field_tenant_fence" ON "wms"."ticket_type_field" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "ticket_type_field_touch_updated_at" BEFORE UPDATE ON "wms"."ticket_type_field" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."ticket_type_permission" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "ticket_type_permission_tenant_fence" ON "wms"."ticket_type_permission" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "ticket_type_permission_touch_updated_at" BEFORE UPDATE ON "wms"."ticket_type_permission" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER "ticket_type_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."ticket_type" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "ticket_type_field_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."ticket_type_field" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('ticket_type', 'ticket_type_id');
--> statement-breakpoint
CREATE TRIGGER "ticket_type_permission_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."ticket_type_permission" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('ticket_type', 'ticket_type_id');