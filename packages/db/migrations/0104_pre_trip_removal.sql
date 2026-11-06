-- Pre-trip inspection removed (O13 of #290 undone, by the owner's decision of
-- 2026-11-05): Settings › Pre-trip checklists, the Driver App's check and the
-- office's vehicle defects go, and with them the three tables 0075 created —
-- `pre_trip_checklist_item`, `pre_trip_check` (a ledger) and `vehicle_defect`
-- — whose fences, policies, triggers and grants go with each table. The two
-- kinds 0075 added go from their lists: `pre-trip-check` from the driver
-- command's kind, and `vehicle-defect` from a ticket's, which a ticket's, an
-- SLA's, a team default's, a ticket type's and a ticket charge's checks read.
-- drizzle-kit's statements are the drops, the six checks dropped and the six
-- added again; between the drops and the adds stand the hand-written
-- statements that leave no row holding a removed kind, run as the owner,
-- since the receipt is a ledger the API role may not delete from:
--   the receipts of `pre-trip-check` (`driver_command`) are deleted;
--   every `vehicle-defect` ticket is kept and re-labelled `other`, the
--   catch-all kind, with its company's default `other` type (made first where
--   a company holding such a ticket has none), since a ticket is the office's
--   and may have been made by hand: its history, bookings, alerts, children,
--   billable events and fields' values stand as they were;
--   the `vehicle-defect` ticket types — every company's default and any the
--   office made — are deleted with their actions, fields and permissions, a
--   type being configuration of a kind no ticket holds any more, and so is an
--   action of another type that opens a follow-up of one (`open-follow-up`
--   names its type, which the ticket automation's table keys);
--   and an SLA target, a team default and a ticket charge of the kind are
--   deleted, configuration as well.
ALTER TABLE "wms"."pre_trip_check" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wms"."pre_trip_checklist_item" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_defect" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "wms"."pre_trip_check" CASCADE;--> statement-breakpoint
DROP TABLE "wms"."pre_trip_checklist_item" CASCADE;--> statement-breakpoint
DROP TABLE "wms"."vehicle_defect" CASCADE;--> statement-breakpoint
ALTER TABLE "wms"."driver_command" DROP CONSTRAINT "driver_command_kind_one_of";--> statement-breakpoint
ALTER TABLE "wms"."ticket" DROP CONSTRAINT "ticket_kind_one_of";--> statement-breakpoint
ALTER TABLE "wms"."ticket_sla" DROP CONSTRAINT "ticket_sla_kind_one_of";--> statement-breakpoint
ALTER TABLE "wms"."ticket_team_default" DROP CONSTRAINT "ticket_team_default_kind_one_of";--> statement-breakpoint
ALTER TABLE "wms"."ticket_type" DROP CONSTRAINT "ticket_type_kind_one_of";--> statement-breakpoint
ALTER TABLE "wms"."ticket_kind_product" DROP CONSTRAINT "ticket_kind_product_ticket_kind_one_of";--> statement-breakpoint
DELETE FROM "wms"."driver_command" WHERE "kind" = 'pre-trip-check';
--> statement-breakpoint
INSERT INTO "wms"."ticket_type" ("company_id", "kind", "name", "is_default") SELECT DISTINCT t."company_id", 'other', 'Other', true FROM "wms"."ticket" AS t WHERE t."kind" = 'vehicle-defect' ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "wms"."ticket" AS t SET "kind" = 'other', "ticket_type_id" = y."id" FROM "wms"."ticket_type" AS y WHERE y."company_id" = t."company_id" AND y."kind" = 'other' AND y."is_default" AND t."kind" = 'vehicle-defect';
--> statement-breakpoint
DELETE FROM "wms"."ticket_type_action" WHERE "ticket_type_id" IN (SELECT "id" FROM "wms"."ticket_type" WHERE "kind" = 'vehicle-defect') OR "follow_up_type_id" IN (SELECT "id" FROM "wms"."ticket_type" WHERE "kind" = 'vehicle-defect');
--> statement-breakpoint
DELETE FROM "wms"."ticket_type_field" WHERE "ticket_type_id" IN (SELECT "id" FROM "wms"."ticket_type" WHERE "kind" = 'vehicle-defect');
--> statement-breakpoint
DELETE FROM "wms"."ticket_type_permission" WHERE "ticket_type_id" IN (SELECT "id" FROM "wms"."ticket_type" WHERE "kind" = 'vehicle-defect');
--> statement-breakpoint
DELETE FROM "wms"."ticket_type" WHERE "kind" = 'vehicle-defect';
--> statement-breakpoint
DELETE FROM "wms"."ticket_sla" WHERE "kind" = 'vehicle-defect';
--> statement-breakpoint
DELETE FROM "wms"."ticket_team_default" WHERE "kind" = 'vehicle-defect';
--> statement-breakpoint
DELETE FROM "wms"."ticket_kind_product" WHERE "ticket_kind" = 'vehicle-defect';
--> statement-breakpoint
ALTER TABLE "wms"."driver_command" ADD CONSTRAINT "driver_command_kind_one_of" CHECK ("wms"."driver_command"."kind" in ('start-route', 'arrive', 'complete-pickup', 'skip-pickup', 'fail-pickup', 'report-problem', 'add-photo', 'add-weight', 'add-signature', 'add-note', 'record-unload', 'pause', 'resume', 'end-route', 'record-positions', 'record-fill', 'record-volume'));--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_kind_one_of" CHECK ("wms"."ticket"."kind" in ('missed-collection', 'overflow', 'access-issue', 'container-request', 'container-defect', 'proof-follow-up', 'complaint', 'reported-problem', 'rejected-command', 'internal-task', 'other'));--> statement-breakpoint
ALTER TABLE "wms"."ticket_sla" ADD CONSTRAINT "ticket_sla_kind_one_of" CHECK ("wms"."ticket_sla"."kind" in ('missed-collection', 'overflow', 'access-issue', 'container-request', 'container-defect', 'proof-follow-up', 'complaint', 'reported-problem', 'rejected-command', 'internal-task', 'other'));--> statement-breakpoint
ALTER TABLE "wms"."ticket_team_default" ADD CONSTRAINT "ticket_team_default_kind_one_of" CHECK ("wms"."ticket_team_default"."kind" in ('missed-collection', 'overflow', 'access-issue', 'container-request', 'container-defect', 'proof-follow-up', 'complaint', 'reported-problem', 'rejected-command', 'internal-task', 'other'));--> statement-breakpoint
ALTER TABLE "wms"."ticket_type" ADD CONSTRAINT "ticket_type_kind_one_of" CHECK ("wms"."ticket_type"."kind" in ('missed-collection', 'overflow', 'access-issue', 'container-request', 'container-defect', 'proof-follow-up', 'complaint', 'reported-problem', 'rejected-command', 'internal-task', 'other'));--> statement-breakpoint
ALTER TABLE "wms"."ticket_kind_product" ADD CONSTRAINT "ticket_kind_product_ticket_kind_one_of" CHECK ("wms"."ticket_kind_product"."ticket_kind" in ('missed-collection', 'overflow', 'access-issue', 'container-request', 'container-defect', 'proof-follow-up', 'complaint', 'reported-problem', 'rejected-command', 'internal-task', 'other'));