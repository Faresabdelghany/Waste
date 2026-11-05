-- The calendars' holidays dropped (2026-11-05): since the Holiday Lists'
-- migration (0100) a project's holidays are the days of the company's Holiday
-- List it names, and nothing reads `collection_calendar_holiday` any more, so
-- the table goes, its fence, triggers, audit trail and public-door grant and
-- policy with it.
-- Hand-written guard first (migrations/README.md, "A column dropped from a
-- table already applied"; src/sql/holiday-lists.ts): 0100 carried every day
-- across, so nothing is backfilled, and the migration fails while any
-- calendar holiday's day is not on the list its project names — a project
-- naming no list included. A database that holds one refuses to lose it: put
-- the day on the project's list, or delete the calendar's row, first. Then
-- drizzle-kit's drop.
DO $$
DECLARE
  stranded int;
  first record;
BEGIN
  SELECT count(*) INTO stranded FROM (SELECT h."company_id", h."collection_calendar_id", h."day" FROM "wms"."collection_calendar_holiday" AS h JOIN "wms"."project" AS p ON p."company_id" = h."company_id" AND p."id" = h."project_id" WHERE NOT EXISTS (SELECT 1 FROM "wms"."holiday_list" AS l JOIN "wms"."holiday_list_holiday" AS d ON d."company_id" = l."company_id" AND d."holiday_list_id" = l."id" WHERE l."company_id" = p."company_id" AND l."name" = p."holiday_list" AND d."day" = h."day")) AS off;
  IF stranded > 0 THEN
    SELECT * INTO first FROM (SELECT h."company_id", h."collection_calendar_id", h."day" FROM "wms"."collection_calendar_holiday" AS h JOIN "wms"."project" AS p ON p."company_id" = h."company_id" AND p."id" = h."project_id" WHERE NOT EXISTS (SELECT 1 FROM "wms"."holiday_list" AS l JOIN "wms"."holiday_list_holiday" AS d ON d."company_id" = l."company_id" AND d."holiday_list_id" = l."id" WHERE l."company_id" = p."company_id" AND l."name" = p."holiday_list" AND d."day" = h."day")) AS off ORDER BY off."company_id", off."collection_calendar_id", off."day" LIMIT 1;
    RAISE EXCEPTION 'collection_calendar_holiday still holds % day(s) that are not on the holiday list their project names (the first: company %, calendar %, %); put each on the list, or delete the calendar''s row, before dropping the table', stranded, first.company_id, first.collection_calendar_id, first.day;
  END IF;
END
$$;--> statement-breakpoint
DROP TABLE "wms"."collection_calendar_holiday" CASCADE;