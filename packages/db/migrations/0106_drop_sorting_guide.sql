-- The Sorting Guide removed (#293 M1, withdrawn 2026-11-05): the owner took
-- Settings › Sorting guide out of the product, and its public page with it.
-- drizzle-kit's statement drops the items' table, and with it everything
-- that was the table's alone: its tenant fence, its touch and audit-trail
-- triggers, the public door's column grant and policy on it (0017), and its
-- keys into the project and the fraction. A project's public slug stays: the
-- collection days and the drop-off points are published under it.
--
-- Hand-written below: the grants of the module key `configure.sorting-guide`,
-- which no surface names any longer, deleted from every role, the system
-- roles' and a company's own; the role grants' audit trail records each.
-- The audit log's rows of the dropped table are kept, as history.
DROP TABLE "wms"."sorting_guide_item" CASCADE;
--> statement-breakpoint
DELETE FROM "wms"."role_grant" WHERE "module_key" = 'configure.sorting-guide';
