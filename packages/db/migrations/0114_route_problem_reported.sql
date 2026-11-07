-- A problem the driver reports on the route, naming no stop, is a kind of its
-- own (F2 of #574): `route-problem-reported`, about the route, where it was a
-- `pickup-problem-reported` about the route. drizzle-kit's statements first,
-- the outbox's kind check again with the new kind; then what the database
-- holds of the old pair moved to it, as `src/sql/route-problem-kind.ts`
-- spells it: the jobs of the old pair not done cancelled and their rows
-- unpublished, for the relay to send again to the new kind's queues; every
-- row of the old pair given the new kind; and a trigger writing the previous
-- API's insert of the old pair as the new kind until this release's is live.
ALTER TABLE "wms"."outbox_event" DROP CONSTRAINT "outbox_event_kind_one_of";--> statement-breakpoint
ALTER TABLE "wms"."outbox_event" ADD CONSTRAINT "outbox_event_kind_one_of" CHECK ("wms"."outbox_event"."kind" in ('route-dispatched', 'route-started', 'route-completed', 'route-cancelled', 'route-reassigned', 'route-problem-reported', 'pickup-completed', 'pickup-failed', 'pickup-skipped', 'pickup-problem-reported', 'pickup-corrected', 'unload-recorded', 'command-rejected', 'ticket-opened', 'ticket-completed', 'ticket-rejected', 'invoice-issued', 'settlement-closed', 'application-decided', 'site-visit-recorded', 'site-visit-voided', 'alert-raised', 'ticket-assigned', 'bulky-booking-booked', 'bulky-booking-cancelled', 'ticket-replied', 'weight-reviewed', 'scale-ticket-completed', 'scale-ticket-voided'));
--> statement-breakpoint
WITH "resent" AS (UPDATE "pgboss"."job" SET "completed_on" = "pgboss".job_now(), "state" = 'cancelled' WHERE "name" LIKE 'outbox.%' AND "state" < 'completed' AND "data"->>'kind' = 'pickup-problem-reported' AND "data"->>'aggregateKind' = 'route' RETURNING ("data"->>'id')::uuid AS "id") UPDATE "wms"."outbox_event" SET "published_at" = NULL WHERE "id" IN (SELECT "id" FROM "resent");
--> statement-breakpoint
UPDATE "wms"."outbox_event" SET "kind" = 'route-problem-reported' WHERE "kind" = 'pickup-problem-reported' AND "aggregate_kind" = 'route';
--> statement-breakpoint
CREATE FUNCTION wms.outbox_event_route_problem() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$ begin if new.kind = 'pickup-problem-reported' and new.aggregate_kind = 'route' then new.kind := 'route-problem-reported'; end if; return new; end $$;
--> statement-breakpoint
CREATE TRIGGER "outbox_event_route_problem" BEFORE INSERT ON "wms"."outbox_event" FOR EACH ROW EXECUTE FUNCTION wms.outbox_event_route_problem();
