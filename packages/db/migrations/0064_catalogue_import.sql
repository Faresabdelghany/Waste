-- The catalogue's CSV import (O30 of #290, row 1.18): a file of waste
-- fractions, container types or vehicle types, the company's and no
-- project's. drizzle-kit's statements alone: the kind's list grows by the
-- three, and a run of any of the company's kinds names no project, as a
-- Customers run never did. No run present is of a new kind, so nothing is
-- guarded and nothing is hand-written.
ALTER TABLE "wms"."import_run" DROP CONSTRAINT "import_run_kind_one_of";--> statement-breakpoint
ALTER TABLE "wms"."import_run" DROP CONSTRAINT "import_run_project_shape";--> statement-breakpoint
ALTER TABLE "wms"."import_run" ADD CONSTRAINT "import_run_kind_one_of" CHECK ("wms"."import_run"."kind" in ('customers', 'properties', 'containers', 'agreements', 'waste-fractions', 'container-types', 'vehicle-types'));--> statement-breakpoint
ALTER TABLE "wms"."import_run" ADD CONSTRAINT "import_run_project_shape" CHECK (("wms"."import_run"."kind" in ('customers', 'waste-fractions', 'container-types', 'vehicle-types')) = ("wms"."import_run"."project_id" is null));