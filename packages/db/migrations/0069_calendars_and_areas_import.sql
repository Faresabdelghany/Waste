-- The CSV import of a project's collection calendars and its planning areas
-- (O30 of #290, row 1.18), the areas read from a GeoJSON file. drizzle-kit's
-- statements alone: the kind's list grows by the two, both a project's, so
-- the project's check stands as it is. No run present is of a new kind.
ALTER TABLE "wms"."import_run" DROP CONSTRAINT "import_run_kind_one_of";--> statement-breakpoint
ALTER TABLE "wms"."import_run" ADD CONSTRAINT "import_run_kind_one_of" CHECK ("wms"."import_run"."kind" in ('customers', 'properties', 'containers', 'agreements', 'waste-fractions', 'container-types', 'vehicle-types', 'vehicles', 'drivers', 'collection-calendars', 'planning-areas'));