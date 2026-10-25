-- The weighbridge in the office (O9 of #290): a project's tolerance between a load weighed on board and its weighbridge net, and a load the station refused, with its reason and its words.
-- No table is new, so nothing is hand-written; every project takes the default tolerance, and no unload present is refused, so nothing is guarded.
ALTER TABLE "wms"."project" ADD COLUMN "weight_tolerance_percent" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "wms"."unload" ADD COLUMN "refusal_reason" text;--> statement-breakpoint
ALTER TABLE "wms"."unload" ADD COLUMN "refusal_note" text;--> statement-breakpoint
ALTER TABLE "wms"."project" ADD CONSTRAINT "project_weight_tolerance_percent_range" CHECK ("wms"."project"."weight_tolerance_percent" between 1 and 100);--> statement-breakpoint
ALTER TABLE "wms"."unload" ADD CONSTRAINT "unload_refusal_reason_one_of" CHECK ("wms"."unload"."refusal_reason" in ('contamination', 'fraction-not-accepted', 'hazardous', 'overweight', 'other'));--> statement-breakpoint
ALTER TABLE "wms"."unload" ADD CONSTRAINT "unload_refusal_shape" CHECK (("wms"."unload"."refusal_note" is null or "wms"."unload"."refusal_reason" is not null) and ("wms"."unload"."refusal_reason" is distinct from 'other' or "wms"."unload"."refusal_note" is not null));