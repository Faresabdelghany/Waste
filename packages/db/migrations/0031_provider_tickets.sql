-- A Service Provider's tickets (#291 slice 23b), as drizzle-kit wrote it:
-- `ticket_source_one_of` replaced in its grown spelling, with
-- `service-provider`, the source the API writes for a ticket a provider's
-- account raises on a route it runs; and `ticket_event_visibility_one_of`
-- likewise, with `service-provider`, the thread the office and that
-- provider read, which is what a provider's comments are. Every row present
-- holds a source and a visibility still in the lists, so the new checks pass
-- by construction and nothing is guarded (migrations/README.md).
ALTER TABLE "wms"."ticket" DROP CONSTRAINT "ticket_source_one_of";--> statement-breakpoint
ALTER TABLE "wms"."ticket_event" DROP CONSTRAINT "ticket_event_visibility_one_of";--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_source_one_of" CHECK ("wms"."ticket"."source" in ('office', 'phone', 'email', 'portal', 'driver-app', 'dispatch', 'import', 'integration', 'service-provider'));--> statement-breakpoint
ALTER TABLE "wms"."ticket_event" ADD CONSTRAINT "ticket_event_visibility_one_of" CHECK ("wms"."ticket_event"."visibility" in ('internal', 'customer', 'service-provider'));