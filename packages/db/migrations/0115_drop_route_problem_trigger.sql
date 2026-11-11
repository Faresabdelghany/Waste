-- 0114's trigger goes: it wrote the previous API's insert of a
-- `pickup-problem-reported` about a route as a `route-problem-reported`, for
-- the minutes between that migration and its own release's image going live.
-- That image writes the new kind itself and no older one runs any more, so
-- the trigger rewrites nothing; it and its function are dropped, and the
-- outbox keeps the one trigger every table with `updated_at` has.
-- Hand-written whole.
DROP TRIGGER "outbox_event_route_problem" ON "wms"."outbox_event";
--> statement-breakpoint
DROP FUNCTION wms.outbox_event_route_problem();
