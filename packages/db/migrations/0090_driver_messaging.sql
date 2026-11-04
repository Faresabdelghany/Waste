-- Driver messaging (O24 of #290): one new table, the Route Messages the
-- office and the route's driver write to each other about one route. A
-- ledger: written once, never edited or taken back. Below drizzle-kit's
-- statements, what the new table owes the file: its fence and, a ledger, the
-- revoke of its update and delete. It is the thread of the route, read in the
-- route's details and on the driver's screen, so it takes no audit trigger:
-- a ledger is its own history.
CREATE TABLE "wms"."route_message" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"route_id" uuid NOT NULL,
	"author" text NOT NULL,
	"sent_by" uuid NOT NULL,
	"driver_id" uuid,
	"body" text NOT NULL,
	CONSTRAINT "route_message_author_one_of" CHECK ("wms"."route_message"."author" in ('office', 'driver')),
	CONSTRAINT "route_message_author_shape" CHECK (("wms"."route_message"."author" = 'driver') = ("wms"."route_message"."driver_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "wms"."route_message" ADD CONSTRAINT "route_message_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."route_message" ADD CONSTRAINT "route_message_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."route_message" ADD CONSTRAINT "route_message_route_id_fk" FOREIGN KEY ("company_id","project_id","route_id") REFERENCES "wms"."route"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."route_message" ADD CONSTRAINT "route_message_driver_id_fk" FOREIGN KEY ("company_id","project_id","driver_id") REFERENCES "wms"."driver"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."route_message" ADD CONSTRAINT "route_message_sent_by_fk" FOREIGN KEY ("company_id","sent_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "route_message_route_id_idx" ON "wms"."route_message" USING btree ("company_id","route_id","id");--> statement-breakpoint
CREATE INDEX "route_message_project_id_idx" ON "wms"."route_message" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "route_message_driver_id_idx" ON "wms"."route_message" USING btree ("company_id","driver_id");--> statement-breakpoint
CREATE INDEX "route_message_sent_by_idx" ON "wms"."route_message" USING btree ("company_id","sent_by");--> statement-breakpoint
ALTER TABLE "wms"."route_message" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "route_message_tenant_fence" ON "wms"."route_message" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "wms"."route_message" FROM wms_api;
