-- The disposal-site reconciliation (M17 of #293, row 28.4): the alert's rule
-- grows by four — an outbound load not received, a receipt beyond the
-- tolerance, a load over our vehicle's payload, and a completed route with no
-- unload — and an alert may be about an Outbound Load of its project, which
-- counts as its subject. drizzle-kit's statements alone; nothing is
-- hand-written, and no alert names a load yet.
ALTER TABLE "wms"."alert" DROP CONSTRAINT "alert_rule_one_of";--> statement-breakpoint
ALTER TABLE "wms"."alert" DROP CONSTRAINT "alert_subject_shape";--> statement-breakpoint
ALTER TABLE "wms"."alert" ADD COLUMN "outbound_load_id" uuid;--> statement-breakpoint
ALTER TABLE "wms"."alert" ADD CONSTRAINT "alert_outbound_load_id_fk" FOREIGN KEY ("company_id","project_id","outbound_load_id") REFERENCES "wms"."outbound_load"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_outbound_load_id_idx" ON "wms"."alert" USING btree ("company_id","outbound_load_id");--> statement-breakpoint
ALTER TABLE "wms"."alert" ADD CONSTRAINT "alert_rule_one_of" CHECK ("wms"."alert"."rule" in ('route-not-started', 'session-silent', 'licence-expiring', 'ticket-overdue', 'position-stale', 'fill-threshold', 'load-not-received', 'load-weight-mismatch', 'load-overweight', 'route-not-tipped'));--> statement-breakpoint
ALTER TABLE "wms"."alert" ADD CONSTRAINT "alert_subject_shape" CHECK (("wms"."alert"."route_id" is not null)::int + ("wms"."alert"."vehicle_id" is not null)::int + ("wms"."alert"."driver_id" is not null)::int + ("wms"."alert"."container_id" is not null)::int + ("wms"."alert"."ticket_id" is not null)::int + ("wms"."alert"."outbound_load_id" is not null)::int >= 1);