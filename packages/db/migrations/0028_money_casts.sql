-- The money checks recast (#314). `billable_event_vat_shape` and
-- `invoice_line_vat_shape` read `round(net_minor * vat_percent / 100.0)`, and
-- `net_minor * vat_percent` is an integer product, computed before anything
-- is cast, which overflows past about 85.9 million minor units at 25 %: a net
-- that fits its column failed the check with 22003. The two `_amounts_shape`
-- checks multiply the unit price by the quantity, and `invoice_line`'s takes
-- `abs` of the net, which overflow the same way at the columns' bounds. Each
-- is dropped and added back with the product cast first: the amounts to
-- bigint, the VAT's net to numeric. Over every row that passed before each
-- pair of expressions is equal, so the re-added checks pass them all and
-- nothing is backfilled. A plain ADD CONSTRAINT validates every row under the
-- tables' lock, which at the Pilot's size is a moment.
ALTER TABLE "wms"."billable_event" DROP CONSTRAINT "billable_event_amounts_shape";--> statement-breakpoint
ALTER TABLE "wms"."billable_event" DROP CONSTRAINT "billable_event_vat_shape";--> statement-breakpoint
ALTER TABLE "wms"."invoice_line" DROP CONSTRAINT "invoice_line_amounts_shape";--> statement-breakpoint
ALTER TABLE "wms"."invoice_line" DROP CONSTRAINT "invoice_line_vat_shape";--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD CONSTRAINT "billable_event_amounts_shape" CHECK ("wms"."billable_event"."net_minor" is null or "wms"."billable_event"."net_minor" = (case "wms"."billable_event"."kind" when 'reversal' then -1 else 1 end) * "wms"."billable_event"."unit_price_minor"::bigint * "wms"."billable_event"."quantity");--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD CONSTRAINT "billable_event_vat_shape" CHECK ("wms"."billable_event"."vat_minor" is null or "wms"."billable_event"."vat_minor" = round("wms"."billable_event"."net_minor"::numeric * "wms"."billable_event"."vat_percent" / 100.0));--> statement-breakpoint
ALTER TABLE "wms"."invoice_line" ADD CONSTRAINT "invoice_line_amounts_shape" CHECK (abs("wms"."invoice_line"."net_minor"::bigint) = "wms"."invoice_line"."unit_price_minor"::bigint * "wms"."invoice_line"."quantity" and ("wms"."invoice_line"."credits_line_id" is null or "wms"."invoice_line"."net_minor" <= 0));--> statement-breakpoint
ALTER TABLE "wms"."invoice_line" ADD CONSTRAINT "invoice_line_vat_shape" CHECK ("wms"."invoice_line"."vat_minor" = round("wms"."invoice_line"."net_minor"::numeric * "wms"."invoice_line"."vat_percent" / 100.0));