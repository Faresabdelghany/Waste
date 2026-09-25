CREATE TABLE "wms"."alert" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"title" text NOT NULL,
	"details" text NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"route_id" uuid,
	"vehicle_id" uuid,
	"driver_id" uuid,
	"container_id" uuid,
	"ticket_id" uuid,
	"raised_by" uuid,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"resolution_note" text,
	CONSTRAINT "alert_kind_one_of" CHECK ("wms"."alert"."kind" in ('route-exception', 'resource', 'service-risk', 'asset', 'weight', 'other')),
	CONSTRAINT "alert_severity_one_of" CHECK ("wms"."alert"."severity" in ('critical', 'high', 'medium', 'low')),
	CONSTRAINT "alert_source_one_of" CHECK ("wms"."alert"."source" in ('manual', 'execution', 'telemetry', 'rule')),
	CONSTRAINT "alert_status_one_of" CHECK ("wms"."alert"."status" in ('new', 'acknowledged', 'resolved')),
	CONSTRAINT "alert_subject_shape" CHECK (("wms"."alert"."route_id" is not null)::int + ("wms"."alert"."vehicle_id" is not null)::int + ("wms"."alert"."driver_id" is not null)::int + ("wms"."alert"."container_id" is not null)::int >= 1),
	CONSTRAINT "alert_acknowledged_shape" CHECK (("wms"."alert"."acknowledged_at" is null) = ("wms"."alert"."acknowledged_by" is null)),
	CONSTRAINT "alert_resolved_shape" CHECK (("wms"."alert"."resolved_at" is null) = ("wms"."alert"."resolved_by" is null) and ("wms"."alert"."resolution_note" is null or "wms"."alert"."resolved_at" is not null)),
	CONSTRAINT "alert_stamps_shape" CHECK (case "wms"."alert"."status" when 'new' then "wms"."alert"."acknowledged_at" is null and "wms"."alert"."resolved_at" is null when 'acknowledged' then "wms"."alert"."acknowledged_at" is not null and "wms"."alert"."resolved_at" is null when 'resolved' then "wms"."alert"."resolved_at" is not null else false end)
);
--> statement-breakpoint
CREATE TABLE "wms"."ticket" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"number" integer NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"priority" text DEFAULT 'none' NOT NULL,
	"source" text NOT NULL,
	"subject" text NOT NULL,
	"description" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone,
	"assignee_user_account_id" uuid,
	"created_by" uuid,
	"source_event_id" uuid,
	"route_id" uuid,
	"pickup_id" uuid,
	"container_id" uuid,
	"property_id" uuid,
	"shared_collection_point_id" uuid,
	"agreement_id" uuid,
	"driver_id" uuid,
	"customer_id" uuid,
	"parent_ticket_id" uuid,
	"resolution" text,
	"recollection_route_id" uuid,
	"closed_at" timestamp with time zone,
	CONSTRAINT "ticket_number_key" UNIQUE("company_id","number"),
	CONSTRAINT "ticket_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "ticket_kind_one_of" CHECK ("wms"."ticket"."kind" in ('missed-collection', 'overflow', 'access-issue', 'container-request', 'container-defect', 'proof-follow-up', 'complaint', 'reported-problem', 'rejected-command', 'internal-task', 'other')),
	CONSTRAINT "ticket_status_one_of" CHECK ("wms"."ticket"."status" in ('open', 'in-progress', 'pending', 'on-hold', 'completed', 'rejected')),
	CONSTRAINT "ticket_priority_one_of" CHECK ("wms"."ticket"."priority" in ('critical', 'high', 'medium', 'low', 'none')),
	CONSTRAINT "ticket_source_one_of" CHECK ("wms"."ticket"."source" in ('office', 'phone', 'email', 'portal', 'driver-app', 'dispatch', 'import', 'integration')),
	CONSTRAINT "ticket_resolution_one_of" CHECK ("wms"."ticket"."resolution" in ('recollected', 'serviced', 'answered', 'no-action', 'duplicate')),
	CONSTRAINT "ticket_origin_shape" CHECK (("wms"."ticket"."created_by" is null) = ("wms"."ticket"."source_event_id" is not null)),
	CONSTRAINT "ticket_pickup_shape" CHECK ("wms"."ticket"."pickup_id" is null or "wms"."ticket"."route_id" is not null),
	CONSTRAINT "ticket_parent_shape" CHECK ("wms"."ticket"."parent_ticket_id" <> "wms"."ticket"."id"),
	CONSTRAINT "ticket_resolution_shape" CHECK (("wms"."ticket"."status" = 'completed') = ("wms"."ticket"."resolution" is not null)),
	CONSTRAINT "ticket_recollection_shape" CHECK ("wms"."ticket"."recollection_route_id" is null or "wms"."ticket"."resolution" is not distinct from 'recollected'),
	CONSTRAINT "ticket_closed_shape" CHECK (("wms"."ticket"."status" in ('completed', 'rejected')) = ("wms"."ticket"."closed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "wms"."ticket_event" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"assignee_user_account_id" uuid,
	"resolution" text,
	"body" text,
	"visibility" text DEFAULT 'internal' NOT NULL,
	"object_key" text,
	"source_event_id" uuid,
	"recorded_by" uuid,
	CONSTRAINT "ticket_event_kind_one_of" CHECK ("wms"."ticket_event"."kind" in ('created', 'assigned', 'status-changed', 'comment')),
	CONSTRAINT "ticket_event_status_one_of" CHECK ("wms"."ticket_event"."status" in ('open', 'in-progress', 'pending', 'on-hold', 'completed', 'rejected')),
	CONSTRAINT "ticket_event_resolution_one_of" CHECK ("wms"."ticket_event"."resolution" in ('recollected', 'serviced', 'answered', 'no-action', 'duplicate')),
	CONSTRAINT "ticket_event_visibility_one_of" CHECK ("wms"."ticket_event"."visibility" in ('internal', 'customer')),
	CONSTRAINT "ticket_event_kind_shape" CHECK (case "wms"."ticket_event"."kind" when 'created' then "wms"."ticket_event"."body" is null and "wms"."ticket_event"."object_key" is null and "wms"."ticket_event"."visibility" = 'internal' and "wms"."ticket_event"."resolution" is null when 'assigned' then "wms"."ticket_event"."object_key" is null and "wms"."ticket_event"."visibility" = 'internal' and "wms"."ticket_event"."resolution" is null when 'status-changed' then "wms"."ticket_event"."object_key" is null and "wms"."ticket_event"."visibility" = 'internal' and ("wms"."ticket_event"."status" = 'completed') = ("wms"."ticket_event"."resolution" is not null) when 'comment' then "wms"."ticket_event"."body" is not null and "wms"."ticket_event"."resolution" is null else false end)
);
--> statement-breakpoint
ALTER TABLE "wms"."outbox_event" DROP CONSTRAINT "outbox_event_kind_one_of";--> statement-breakpoint
ALTER TABLE "wms"."outbox_event" DROP CONSTRAINT "outbox_event_aggregate_kind_one_of";--> statement-breakpoint
ALTER TABLE "wms"."company" ADD COLUMN "next_ticket_number" integer DEFAULT 1000 NOT NULL;--> statement-breakpoint
ALTER TABLE "wms"."alert" ADD CONSTRAINT "alert_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."alert" ADD CONSTRAINT "alert_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."alert" ADD CONSTRAINT "alert_route_id_fk" FOREIGN KEY ("company_id","project_id","route_id") REFERENCES "wms"."route"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."alert" ADD CONSTRAINT "alert_vehicle_id_fk" FOREIGN KEY ("company_id","project_id","vehicle_id") REFERENCES "wms"."vehicle"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."alert" ADD CONSTRAINT "alert_driver_id_fk" FOREIGN KEY ("company_id","project_id","driver_id") REFERENCES "wms"."driver"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."alert" ADD CONSTRAINT "alert_container_id_fk" FOREIGN KEY ("company_id","project_id","container_id") REFERENCES "wms"."container"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."alert" ADD CONSTRAINT "alert_ticket_id_fk" FOREIGN KEY ("company_id","project_id","ticket_id") REFERENCES "wms"."ticket"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."alert" ADD CONSTRAINT "alert_raised_by_fk" FOREIGN KEY ("company_id","raised_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."alert" ADD CONSTRAINT "alert_acknowledged_by_fk" FOREIGN KEY ("company_id","acknowledged_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."alert" ADD CONSTRAINT "alert_resolved_by_fk" FOREIGN KEY ("company_id","resolved_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_assignee_user_account_id_fk" FOREIGN KEY ("company_id","assignee_user_account_id") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_created_by_fk" FOREIGN KEY ("company_id","created_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_route_id_fk" FOREIGN KEY ("company_id","project_id","route_id") REFERENCES "wms"."route"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_route_id_pickup_id_fk" FOREIGN KEY ("company_id","project_id","route_id","pickup_id") REFERENCES "wms"."pickup"("company_id","project_id","route_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_container_id_fk" FOREIGN KEY ("company_id","project_id","container_id") REFERENCES "wms"."container"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_property_id_fk" FOREIGN KEY ("company_id","project_id","property_id") REFERENCES "wms"."property"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_shared_collection_point_id_fk" FOREIGN KEY ("company_id","project_id","shared_collection_point_id") REFERENCES "wms"."shared_collection_point"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_agreement_id_fk" FOREIGN KEY ("company_id","project_id","agreement_id") REFERENCES "wms"."agreement"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_driver_id_fk" FOREIGN KEY ("company_id","project_id","driver_id") REFERENCES "wms"."driver"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_customer_id_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "wms"."customer"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_parent_ticket_id_fk" FOREIGN KEY ("company_id","project_id","parent_ticket_id") REFERENCES "wms"."ticket"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_recollection_route_id_fk" FOREIGN KEY ("company_id","project_id","recollection_route_id") REFERENCES "wms"."route"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket_event" ADD CONSTRAINT "ticket_event_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket_event" ADD CONSTRAINT "ticket_event_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket_event" ADD CONSTRAINT "ticket_event_ticket_id_fk" FOREIGN KEY ("company_id","project_id","ticket_id") REFERENCES "wms"."ticket"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket_event" ADD CONSTRAINT "ticket_event_assignee_user_account_id_fk" FOREIGN KEY ("company_id","assignee_user_account_id") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket_event" ADD CONSTRAINT "ticket_event_recorded_by_fk" FOREIGN KEY ("company_id","recorded_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_project_id_status_idx" ON "wms"."alert" USING btree ("company_id","project_id","status");--> statement-breakpoint
CREATE INDEX "alert_route_id_idx" ON "wms"."alert" USING btree ("company_id","route_id");--> statement-breakpoint
CREATE INDEX "alert_vehicle_id_idx" ON "wms"."alert" USING btree ("company_id","vehicle_id");--> statement-breakpoint
CREATE INDEX "alert_driver_id_idx" ON "wms"."alert" USING btree ("company_id","driver_id");--> statement-breakpoint
CREATE INDEX "alert_container_id_idx" ON "wms"."alert" USING btree ("company_id","container_id");--> statement-breakpoint
CREATE INDEX "alert_ticket_id_idx" ON "wms"."alert" USING btree ("company_id","ticket_id");--> statement-breakpoint
CREATE INDEX "alert_raised_by_idx" ON "wms"."alert" USING btree ("company_id","raised_by");--> statement-breakpoint
CREATE INDEX "alert_acknowledged_by_idx" ON "wms"."alert" USING btree ("company_id","acknowledged_by");--> statement-breakpoint
CREATE INDEX "alert_resolved_by_idx" ON "wms"."alert" USING btree ("company_id","resolved_by");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_source_event_id_idx" ON "wms"."ticket" USING btree ("company_id","source_event_id") WHERE "wms"."ticket"."source_event_id" is not null;--> statement-breakpoint
CREATE INDEX "ticket_project_id_status_idx" ON "wms"."ticket" USING btree ("company_id","project_id","status");--> statement-breakpoint
CREATE INDEX "ticket_assignee_user_account_id_status_idx" ON "wms"."ticket" USING btree ("company_id","assignee_user_account_id","status");--> statement-breakpoint
CREATE INDEX "ticket_created_by_idx" ON "wms"."ticket" USING btree ("company_id","created_by");--> statement-breakpoint
CREATE INDEX "ticket_route_id_idx" ON "wms"."ticket" USING btree ("company_id","route_id");--> statement-breakpoint
CREATE INDEX "ticket_pickup_id_idx" ON "wms"."ticket" USING btree ("company_id","pickup_id");--> statement-breakpoint
CREATE INDEX "ticket_container_id_idx" ON "wms"."ticket" USING btree ("company_id","container_id");--> statement-breakpoint
CREATE INDEX "ticket_property_id_idx" ON "wms"."ticket" USING btree ("company_id","property_id");--> statement-breakpoint
CREATE INDEX "ticket_shared_collection_point_id_idx" ON "wms"."ticket" USING btree ("company_id","shared_collection_point_id");--> statement-breakpoint
CREATE INDEX "ticket_agreement_id_idx" ON "wms"."ticket" USING btree ("company_id","agreement_id");--> statement-breakpoint
CREATE INDEX "ticket_driver_id_idx" ON "wms"."ticket" USING btree ("company_id","driver_id");--> statement-breakpoint
CREATE INDEX "ticket_customer_id_idx" ON "wms"."ticket" USING btree ("company_id","customer_id");--> statement-breakpoint
CREATE INDEX "ticket_parent_ticket_id_idx" ON "wms"."ticket" USING btree ("company_id","parent_ticket_id");--> statement-breakpoint
CREATE INDEX "ticket_recollection_route_id_idx" ON "wms"."ticket" USING btree ("company_id","recollection_route_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_event_source_event_id_idx" ON "wms"."ticket_event" USING btree ("company_id","source_event_id") WHERE "wms"."ticket_event"."source_event_id" is not null;--> statement-breakpoint
CREATE INDEX "ticket_event_ticket_id_idx" ON "wms"."ticket_event" USING btree ("company_id","ticket_id","id");--> statement-breakpoint
CREATE INDEX "ticket_event_project_id_idx" ON "wms"."ticket_event" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "ticket_event_assignee_user_account_id_idx" ON "wms"."ticket_event" USING btree ("company_id","assignee_user_account_id");--> statement-breakpoint
CREATE INDEX "ticket_event_recorded_by_idx" ON "wms"."ticket_event" USING btree ("company_id","recorded_by");--> statement-breakpoint
ALTER TABLE "wms"."outbox_event" ADD CONSTRAINT "outbox_event_kind_one_of" CHECK ("wms"."outbox_event"."kind" in ('route-dispatched', 'route-started', 'route-completed', 'route-cancelled', 'route-reassigned', 'pickup-completed', 'pickup-failed', 'pickup-skipped', 'pickup-problem-reported', 'pickup-corrected', 'unload-recorded', 'command-rejected', 'ticket-opened', 'ticket-completed', 'ticket-rejected'));--> statement-breakpoint
ALTER TABLE "wms"."outbox_event" ADD CONSTRAINT "outbox_event_aggregate_kind_one_of" CHECK ("wms"."outbox_event"."aggregate_kind" in ('route', 'pickup', 'unload', 'command', 'ticket'));
--> statement-breakpoint
-- Below drizzle-kit statements: the fence and trigger of ticket and alert,
-- and the fence and revoke of the ticket_event ledger, copied verbatim from
-- the helpers in src/sql/, which the gate in src/__tests__/hand-written.test.ts
-- holds the file to (Issue #109; migrations/README.md).
ALTER TABLE "wms"."ticket" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "ticket_tenant_fence" ON "wms"."ticket" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "ticket_touch_updated_at" BEFORE UPDATE ON "wms"."ticket" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."ticket_event" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "ticket_event_tenant_fence" ON "wms"."ticket_event" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "wms"."ticket_event" FROM wms_api;
--> statement-breakpoint
ALTER TABLE "wms"."alert" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "alert_tenant_fence" ON "wms"."alert" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "alert_touch_updated_at" BEFORE UPDATE ON "wms"."alert" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
