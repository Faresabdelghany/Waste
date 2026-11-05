-- Holiday Lists (Settings › Operations › Holiday lists, 2026-11-05): a
-- holiday list becomes the company's own row, for one country, with its days
-- and their names, and a Project's `holiday_list` becomes a key into it by
-- name, following a rename. drizzle-kit's two tables and their keys come
-- first; then, hand-written and run by the owner, every company is given one
-- list per country its projects' list names are of, every project is put on
-- its country's list, and each list is given the days its projects'
-- Collection Calendars held (src/sql/holiday-lists.ts), so the Project's key,
-- moved below them, holds on every row; then the tables' fences, triggers and
-- audit trail, and the public door's grants and policies on them. The
-- calendars' own holidays are left in place and read by nothing from here on.
CREATE TABLE "wms"."holiday_list" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"country" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "holiday_list_country_key" UNIQUE("company_id","country"),
	CONSTRAINT "holiday_list_name_key" UNIQUE("company_id","name"),
	CONSTRAINT "holiday_list_tenant_key" UNIQUE("company_id","id"),
	CONSTRAINT "holiday_list_country_shape" CHECK ("wms"."holiday_list"."country" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE TABLE "wms"."holiday_list_holiday" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"holiday_list_id" uuid NOT NULL,
	"day" date NOT NULL,
	"name" text,
	CONSTRAINT "holiday_list_holiday_holiday_list_id_day_key" UNIQUE("company_id","holiday_list_id","day")
);
--> statement-breakpoint
ALTER TABLE "wms"."holiday_list" ADD CONSTRAINT "holiday_list_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "wms"."holiday_list_holiday" ADD CONSTRAINT "holiday_list_holiday_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "wms"."holiday_list_holiday" ADD CONSTRAINT "holiday_list_holiday_holiday_list_id_fk" FOREIGN KEY ("company_id","holiday_list_id") REFERENCES "wms"."holiday_list"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "wms"."holiday_list" ("company_id", "country", "name") SELECT DISTINCT ON (named."company_id", named."country") named."company_id", named."country", named."holiday_list" FROM (SELECT p."company_id", p."id", p."holiday_list", CASE p."holiday_list" WHEN 'Danish public holidays' THEN 'DK' WHEN 'Egyptian public holidays' THEN 'EG' ELSE c."country" END AS "country" FROM "wms"."project" AS p JOIN "wms"."company" AS c ON c."id" = p."company_id" WHERE p."holiday_list" IS NOT NULL) AS named ORDER BY named."company_id", named."country", named."holiday_list";
--> statement-breakpoint
UPDATE "wms"."project" AS target SET "holiday_list" = l."name" FROM (SELECT p."company_id", p."id", p."holiday_list", CASE p."holiday_list" WHEN 'Danish public holidays' THEN 'DK' WHEN 'Egyptian public holidays' THEN 'EG' ELSE c."country" END AS "country" FROM "wms"."project" AS p JOIN "wms"."company" AS c ON c."id" = p."company_id" WHERE p."holiday_list" IS NOT NULL) AS named JOIN "wms"."holiday_list" AS l ON l."company_id" = named."company_id" AND l."country" = named."country" WHERE target."company_id" = named."company_id" AND target."id" = named."id" AND target."holiday_list" IS DISTINCT FROM l."name";
--> statement-breakpoint
INSERT INTO "wms"."holiday_list_holiday" ("company_id", "holiday_list_id", "day", "name") SELECT h."company_id", l."id", h."day", max(h."name") FROM "wms"."collection_calendar_holiday" AS h JOIN "wms"."project" AS p ON p."company_id" = h."company_id" AND p."id" = h."project_id" JOIN "wms"."holiday_list" AS l ON l."company_id" = p."company_id" AND l."name" = p."holiday_list" GROUP BY h."company_id", l."id", h."day";
--> statement-breakpoint
ALTER TABLE "wms"."project" ADD CONSTRAINT "project_holiday_list_fk" FOREIGN KEY ("company_id","holiday_list") REFERENCES "wms"."holiday_list"("company_id","name") ON DELETE no action ON UPDATE cascade;
--> statement-breakpoint
CREATE INDEX "project_holiday_list_idx" ON "wms"."project" USING btree ("company_id","holiday_list");
--> statement-breakpoint
ALTER TABLE "wms"."holiday_list" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "holiday_list_tenant_fence" ON "wms"."holiday_list" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "holiday_list_touch_updated_at" BEFORE UPDATE ON "wms"."holiday_list" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."holiday_list_holiday" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "holiday_list_holiday_tenant_fence" ON "wms"."holiday_list_holiday" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "holiday_list_holiday_touch_updated_at" BEFORE UPDATE ON "wms"."holiday_list_holiday" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER "holiday_list_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."holiday_list" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "holiday_list_holiday_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."holiday_list_holiday" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('holiday_list', 'holiday_list_id');
--> statement-breakpoint
GRANT SELECT ("id", "company_id", "country", "name") ON "wms"."holiday_list" TO wms_public;
--> statement-breakpoint
GRANT SELECT ("company_id", "holiday_list_id", "day", "name") ON "wms"."holiday_list_holiday" TO wms_public;
--> statement-breakpoint
CREATE POLICY "holiday_list_public_door" ON "wms"."holiday_list" AS PERMISSIVE FOR SELECT TO wms_public USING ("company_id" = (select wms.current_company_id()) and exists (select 1 from "wms"."project" "published" where "published"."company_id" = "holiday_list"."company_id" and "published"."holiday_list" = "holiday_list"."name" and "published"."public_slug" is not null));
--> statement-breakpoint
CREATE POLICY "holiday_list_holiday_public_door" ON "wms"."holiday_list_holiday" AS PERMISSIVE FOR SELECT TO wms_public USING ("company_id" = (select wms.current_company_id()) and exists (select 1 from "wms"."holiday_list" "list" where "list"."company_id" = "holiday_list_holiday"."company_id" and "list"."id" = "holiday_list_holiday"."holiday_list_id" and exists (select 1 from "wms"."project" "published" where "published"."company_id" = "list"."company_id" and "published"."holiday_list" = "list"."name" and "published"."public_slug" is not null)));
