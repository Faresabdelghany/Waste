-- Why a route was cancelled (O5 of #290): a closed code beside the free note,
-- which stays the route's `note`. The column is nullable and nothing is
-- backfilled: a route cancelled before this file carries no code, which says
-- only that it was cancelled before the codes. `route_cancel_reason_shape`
-- holds a code to a cancelled route and `regeneration` to a run's cancel, so
-- every row already present passes it by construction (the column is new and
-- null throughout). The office writes one of its eight codes through
-- `POST /routes/:id/cancel`; generation writes `regeneration` when it cancels
-- a route its scheme no longer plans, and clears the code when it brings one
-- back.
ALTER TABLE "wms"."route" ADD COLUMN "cancel_reason_code" text;--> statement-breakpoint
ALTER TABLE "wms"."route" ADD CONSTRAINT "route_cancel_reason_code_one_of" CHECK ("wms"."route"."cancel_reason_code" in ('vehicle-breakdown', 'crew-unavailable', 'weather', 'road-closure', 'holiday', 'duplicate', 'merged', 'other', 'regeneration'));--> statement-breakpoint
ALTER TABLE "wms"."route" ADD CONSTRAINT "route_cancel_reason_shape" CHECK ("wms"."route"."cancel_reason_code" is null or ("wms"."route"."status" = 'cancelled' and ("wms"."route"."cancel_reason_code" = 'regeneration') = "wms"."route"."cancelled_by_generation"));