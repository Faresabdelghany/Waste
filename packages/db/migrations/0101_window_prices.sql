-- The scale house's window prices (M16b of #293): the unit `m3` beside #513's
-- `tonne`; a price row's quantity tier, `from_quantity`, null on every row
-- present, so each resolves as it did; a window line's product and declared
-- volume; and a `scale-ticket` billable event per line of an account's
-- completed ticket, with the outbox's two kinds that bring it and the cancel
-- reason its void gives. drizzle-kit's statements first (the line's project
-- key moved ahead of the event's reference to it); then the price row's
-- exclusion constraint again, its key now the tier too, read as 0 for a row
-- with none, so the rows present keep exactly the key they had.
ALTER TABLE "wms"."product" DROP CONSTRAINT "product_unit_one_of";
--> statement-breakpoint
ALTER TABLE "wms"."outbox_event" DROP CONSTRAINT "outbox_event_kind_one_of";
--> statement-breakpoint
ALTER TABLE "wms"."outbox_event" DROP CONSTRAINT "outbox_event_aggregate_kind_one_of";
--> statement-breakpoint
ALTER TABLE "wms"."billable_event" DROP CONSTRAINT "billable_event_kind_one_of";
--> statement-breakpoint
ALTER TABLE "wms"."billable_event" DROP CONSTRAINT "billable_event_cancel_reason_one_of";
--> statement-breakpoint
ALTER TABLE "wms"."billable_event" DROP CONSTRAINT "billable_event_kind_shape";
--> statement-breakpoint
ALTER TABLE "wms"."billable_event" DROP CONSTRAINT "billable_event_weight_shape";
--> statement-breakpoint
DROP INDEX "wms"."billable_event_source_event_id_idx";
--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD COLUMN "scale_ticket_line_id" uuid;
--> statement-breakpoint
ALTER TABLE "wms"."price_list_row" ADD COLUMN "from_quantity" integer;
--> statement-breakpoint
ALTER TABLE "wms"."scale_ticket_line" ADD COLUMN "product_id" uuid;
--> statement-breakpoint
ALTER TABLE "wms"."scale_ticket_line" ADD COLUMN "volume_litres" integer;
--> statement-breakpoint
ALTER TABLE "wms"."scale_ticket_line" ADD CONSTRAINT "scale_ticket_line_project_key" UNIQUE("company_id","project_id","id");
--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD CONSTRAINT "billable_event_scale_ticket_line_id_fk" FOREIGN KEY ("company_id","project_id","scale_ticket_line_id") REFERENCES "wms"."scale_ticket_line"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "wms"."scale_ticket_line" ADD CONSTRAINT "scale_ticket_line_product_id_fk" FOREIGN KEY ("company_id","project_id","product_id") REFERENCES "wms"."product"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "billable_event_scale_ticket_charge_idx" ON "wms"."billable_event" USING btree ("company_id","scale_ticket_line_id") WHERE "wms"."billable_event"."kind" = 'scale-ticket';
--> statement-breakpoint
CREATE INDEX "scale_ticket_line_product_id_idx" ON "wms"."scale_ticket_line" USING btree ("company_id","product_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "billable_event_source_event_id_idx" ON "wms"."billable_event" USING btree ("company_id","source_event_id","kind") WHERE "wms"."billable_event"."source_event_id" is not null and "wms"."billable_event"."kind" not in ('reversal', 'weight', 'scale-ticket');
--> statement-breakpoint
ALTER TABLE "wms"."product" ADD CONSTRAINT "product_unit_one_of" CHECK ("wms"."product"."unit" in ('pickup', 'month', 'job', 'day', 'visit', 'item', 'tonne', 'm3'));
--> statement-breakpoint
ALTER TABLE "wms"."outbox_event" ADD CONSTRAINT "outbox_event_kind_one_of" CHECK ("wms"."outbox_event"."kind" in ('route-dispatched', 'route-started', 'route-completed', 'route-cancelled', 'route-reassigned', 'pickup-completed', 'pickup-failed', 'pickup-skipped', 'pickup-problem-reported', 'pickup-corrected', 'unload-recorded', 'command-rejected', 'ticket-opened', 'ticket-completed', 'ticket-rejected', 'invoice-issued', 'settlement-closed', 'application-decided', 'site-visit-recorded', 'site-visit-voided', 'alert-raised', 'ticket-assigned', 'weight-reviewed', 'scale-ticket-completed', 'scale-ticket-voided'));
--> statement-breakpoint
ALTER TABLE "wms"."outbox_event" ADD CONSTRAINT "outbox_event_aggregate_kind_one_of" CHECK ("wms"."outbox_event"."aggregate_kind" in ('route', 'pickup', 'unload', 'command', 'ticket', 'invoice', 'settlement', 'application', 'site-visit', 'alert', 'scale-ticket'));
--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD CONSTRAINT "billable_event_scale_ticket_shape" CHECK (("wms"."billable_event"."kind" = 'scale-ticket') = ("wms"."billable_event"."scale_ticket_line_id" is not null));
--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD CONSTRAINT "billable_event_kind_one_of" CHECK ("wms"."billable_event"."kind" in ('pickup', 'ticket', 'manual', 'reversal', 'subscription', 'job', 'hire', 'pickup-exception', 'visit', 'weight', 'scale-ticket'));
--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD CONSTRAINT "billable_event_cancel_reason_one_of" CHECK ("wms"."billable_event"."cancel_reason" in ('pickup-corrected', 'visit-voided', 'weight-revised', 'scale-ticket-voided', 'duplicate', 'not-delivered', 'other'));
--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD CONSTRAINT "billable_event_kind_shape" CHECK (case "wms"."billable_event"."kind" when 'pickup' then "wms"."billable_event"."pickup_id" is not null and "wms"."billable_event"."ticket_id" is null and "wms"."billable_event"."reverses_event_id" is null when 'ticket' then "wms"."billable_event"."ticket_id" is not null and "wms"."billable_event"."pickup_id" is null and "wms"."billable_event"."reverses_event_id" is null when 'manual' then "wms"."billable_event"."pickup_id" is null and "wms"."billable_event"."ticket_id" is null and "wms"."billable_event"."reverses_event_id" is null and "wms"."billable_event"."created_by" is not null when 'reversal' then "wms"."billable_event"."reverses_event_id" is not null and "wms"."billable_event"."pickup_id" is null and "wms"."billable_event"."ticket_id" is null and "wms"."billable_event"."net_minor" is not null and "wms"."billable_event"."net_minor" <= 0 when 'subscription' then "wms"."billable_event"."subscription_id" is not null and "wms"."billable_event"."pickup_id" is null and "wms"."billable_event"."ticket_id" is null and "wms"."billable_event"."reverses_event_id" is null when 'job' then "wms"."billable_event"."pickup_id" is not null and "wms"."billable_event"."ticket_id" is null and "wms"."billable_event"."reverses_event_id" is null when 'hire' then "wms"."billable_event"."subscription_id" is not null and "wms"."billable_event"."placement_id" is not null and "wms"."billable_event"."pickup_id" is null and "wms"."billable_event"."ticket_id" is null and "wms"."billable_event"."reverses_event_id" is null when 'pickup-exception' then "wms"."billable_event"."pickup_id" is not null and "wms"."billable_event"."ticket_id" is null and "wms"."billable_event"."reverses_event_id" is null when 'visit' then "wms"."billable_event"."visit_id" is not null and "wms"."billable_event"."pickup_id" is null and "wms"."billable_event"."ticket_id" is null and "wms"."billable_event"."reverses_event_id" is null when 'weight' then "wms"."billable_event"."unload_id" is not null and "wms"."billable_event"."pickup_id" is not null and "wms"."billable_event"."ticket_id" is null and "wms"."billable_event"."reverses_event_id" is null when 'scale-ticket' then "wms"."billable_event"."scale_ticket_line_id" is not null and "wms"."billable_event"."pickup_id" is null and "wms"."billable_event"."ticket_id" is null and "wms"."billable_event"."reverses_event_id" is null else false end);
--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD CONSTRAINT "billable_event_weight_shape" CHECK (("wms"."billable_event"."kind" = 'weight') = ("wms"."billable_event"."unload_id" is not null) and ("wms"."billable_event"."kind" in ('weight', 'scale-ticket')) = ("wms"."billable_event"."weight_kg" is not null));
--> statement-breakpoint
ALTER TABLE "wms"."price_list_row" ADD CONSTRAINT "price_list_row_from_quantity_positive" CHECK ("wms"."price_list_row"."from_quantity" > 0);
--> statement-breakpoint
ALTER TABLE "wms"."scale_ticket_line" ADD CONSTRAINT "scale_ticket_line_volume_litres_positive" CHECK ("wms"."scale_ticket_line"."volume_litres" > 0);
--> statement-breakpoint
ALTER TABLE "wms"."price_list_row" DROP CONSTRAINT "price_list_row_no_overlap";
--> statement-breakpoint
ALTER TABLE "wms"."price_list_row" ADD CONSTRAINT "price_list_row_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "price_list_id" WITH =, "product_id" WITH =, "condition_key" WITH =, (coalesce("from_quantity", 0)) WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);
