-- #293 M5b: a Pickup Exception's charge. billable_event takes the
-- `pickup-exception` kind and its evidence, the proof that recorded the
-- exception. A tagged collection's two charges are two rows of one outbox
-- event, so the consumer's key becomes the event and the kind, reversals
-- aside, and a reversal is keyed by the event it undoes.
--
-- The unique reversal index cannot fail on a database this runs on. The one
-- writer of a reversal is the Finance consumer, on a `pickup-corrected` of a
-- stop whose live event is invoiced — its `pickup` charge, a work order's
-- `job` (M14), or its Pickup Exception's charge (finance/from-event.ts,
-- `reversalOf`): it reads each live event under the pickup's row lock, and an
-- event already reversed is no longer live (the reversing LATERAL of
-- `eventsFrom`), so a later correction finds nothing to reverse; a
-- redelivered correction met the source-event index, one row per event,
-- before this. The office creates `manual` events alone.
ALTER TABLE "wms"."billable_event" DROP CONSTRAINT "billable_event_kind_one_of";--> statement-breakpoint
ALTER TABLE "wms"."billable_event" DROP CONSTRAINT "billable_event_kind_shape";--> statement-breakpoint
DROP INDEX "wms"."billable_event_source_event_id_idx";--> statement-breakpoint
DROP INDEX "wms"."billable_event_reverses_event_id_idx";--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD COLUMN "evidence_proof_id" uuid;--> statement-breakpoint
CREATE INDEX "billable_event_evidence_proof_id_idx" ON "wms"."billable_event" USING btree ("company_id","evidence_proof_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billable_event_source_event_id_idx" ON "wms"."billable_event" USING btree ("company_id","source_event_id","kind") WHERE "wms"."billable_event"."source_event_id" is not null and "wms"."billable_event"."kind" <> 'reversal';--> statement-breakpoint
CREATE UNIQUE INDEX "billable_event_reverses_event_id_idx" ON "wms"."billable_event" USING btree ("company_id","reverses_event_id") WHERE "wms"."billable_event"."reverses_event_id" is not null;--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD CONSTRAINT "billable_event_evidence_shape" CHECK ("wms"."billable_event"."evidence_proof_id" is null or "wms"."billable_event"."kind" = 'pickup-exception');--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD CONSTRAINT "billable_event_kind_one_of" CHECK ("wms"."billable_event"."kind" in ('pickup', 'ticket', 'manual', 'reversal', 'subscription', 'job', 'hire', 'pickup-exception'));--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD CONSTRAINT "billable_event_kind_shape" CHECK (case "wms"."billable_event"."kind" when 'pickup' then "wms"."billable_event"."pickup_id" is not null and "wms"."billable_event"."ticket_id" is null and "wms"."billable_event"."reverses_event_id" is null when 'ticket' then "wms"."billable_event"."ticket_id" is not null and "wms"."billable_event"."pickup_id" is null and "wms"."billable_event"."reverses_event_id" is null when 'manual' then "wms"."billable_event"."pickup_id" is null and "wms"."billable_event"."ticket_id" is null and "wms"."billable_event"."reverses_event_id" is null and "wms"."billable_event"."created_by" is not null when 'reversal' then "wms"."billable_event"."reverses_event_id" is not null and "wms"."billable_event"."pickup_id" is null and "wms"."billable_event"."ticket_id" is null and "wms"."billable_event"."net_minor" is not null and "wms"."billable_event"."net_minor" <= 0 when 'subscription' then "wms"."billable_event"."subscription_id" is not null and "wms"."billable_event"."pickup_id" is null and "wms"."billable_event"."ticket_id" is null and "wms"."billable_event"."reverses_event_id" is null when 'job' then "wms"."billable_event"."pickup_id" is not null and "wms"."billable_event"."ticket_id" is null and "wms"."billable_event"."reverses_event_id" is null when 'hire' then "wms"."billable_event"."subscription_id" is not null and "wms"."billable_event"."placement_id" is not null and "wms"."billable_event"."pickup_id" is null and "wms"."billable_event"."ticket_id" is null and "wms"."billable_event"."reverses_event_id" is null when 'pickup-exception' then "wms"."billable_event"."pickup_id" is not null and "wms"."billable_event"."ticket_id" is null and "wms"."billable_event"."reverses_event_id" is null else false end);