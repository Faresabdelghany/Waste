GRANT SELECT ("weekend", "holiday_list") ON "wms"."project" TO wms_public;
--> statement-breakpoint
GRANT SELECT ("id", "company_id", "project_id", "address") ON "wms"."property" TO wms_public;
--> statement-breakpoint
GRANT SELECT ("id", "company_id", "project_id", "property_id", "valid_from", "valid_to") ON "wms"."subscription" TO wms_public;
--> statement-breakpoint
GRANT SELECT ("company_id", "project_id", "container_id", "subscription_id", "waste_fraction_id", "valid_from", "valid_to") ON "wms"."container_service_placement" TO wms_public;
--> statement-breakpoint
GRANT SELECT ("id", "company_id", "project_id", "route_scheme_id", "position", "days", "stop_source") ON "wms"."collection_group" TO wms_public;
--> statement-breakpoint
GRANT SELECT ("company_id", "project_id", "collection_group_id", "container_id") ON "wms"."collection_group_container" TO wms_public;
--> statement-breakpoint
GRANT SELECT ("id", "company_id", "project_id", "collection_group_id", "container_ids") ON "wms"."generation_match" TO wms_public;
--> statement-breakpoint
GRANT SELECT ("id", "company_id", "project_id", "frequency", "service_days", "week_rotation", "valid_from", "valid_to", "holiday_policy", "status") ON "wms"."route_scheme" TO wms_public;
--> statement-breakpoint
GRANT SELECT ("id", "company_id", "project_id", "collection_group_id", "service_date", "operating_date", "status", "cancelled_by_generation", "held_at") ON "wms"."route" TO wms_public;
--> statement-breakpoint
GRANT SELECT ("company_id", "project_id", "day", "name") ON "wms"."collection_calendar_holiday" TO wms_public;
--> statement-breakpoint
CREATE POLICY "property_public_door" ON "wms"."property" AS PERMISSIVE FOR SELECT TO wms_public USING ("company_id" = (select wms.current_company_id()) and exists (select 1 from "wms"."project" "published" where "published"."company_id" = "property"."company_id" and "published"."id" = "property"."project_id" and "published"."public_slug" is not null));
--> statement-breakpoint
CREATE POLICY "subscription_public_door" ON "wms"."subscription" AS PERMISSIVE FOR SELECT TO wms_public USING ("company_id" = (select wms.current_company_id()) and exists (select 1 from "wms"."project" "published" where "published"."company_id" = "subscription"."company_id" and "published"."id" = "subscription"."project_id" and "published"."public_slug" is not null));
--> statement-breakpoint
CREATE POLICY "container_service_placement_public_door" ON "wms"."container_service_placement" AS PERMISSIVE FOR SELECT TO wms_public USING ("company_id" = (select wms.current_company_id()) and exists (select 1 from "wms"."project" "published" where "published"."company_id" = "container_service_placement"."company_id" and "published"."id" = "container_service_placement"."project_id" and "published"."public_slug" is not null));
--> statement-breakpoint
CREATE POLICY "collection_group_public_door" ON "wms"."collection_group" AS PERMISSIVE FOR SELECT TO wms_public USING ("company_id" = (select wms.current_company_id()) and exists (select 1 from "wms"."project" "published" where "published"."company_id" = "collection_group"."company_id" and "published"."id" = "collection_group"."project_id" and "published"."public_slug" is not null));
--> statement-breakpoint
CREATE POLICY "collection_group_container_public_door" ON "wms"."collection_group_container" AS PERMISSIVE FOR SELECT TO wms_public USING ("company_id" = (select wms.current_company_id()) and exists (select 1 from "wms"."project" "published" where "published"."company_id" = "collection_group_container"."company_id" and "published"."id" = "collection_group_container"."project_id" and "published"."public_slug" is not null));
--> statement-breakpoint
CREATE POLICY "generation_match_public_door" ON "wms"."generation_match" AS PERMISSIVE FOR SELECT TO wms_public USING ("company_id" = (select wms.current_company_id()) and exists (select 1 from "wms"."project" "published" where "published"."company_id" = "generation_match"."company_id" and "published"."id" = "generation_match"."project_id" and "published"."public_slug" is not null));
--> statement-breakpoint
CREATE POLICY "route_scheme_public_door" ON "wms"."route_scheme" AS PERMISSIVE FOR SELECT TO wms_public USING ("company_id" = (select wms.current_company_id()) and exists (select 1 from "wms"."project" "published" where "published"."company_id" = "route_scheme"."company_id" and "published"."id" = "route_scheme"."project_id" and "published"."public_slug" is not null));
--> statement-breakpoint
CREATE POLICY "route_public_door" ON "wms"."route" AS PERMISSIVE FOR SELECT TO wms_public USING ("company_id" = (select wms.current_company_id()) and exists (select 1 from "wms"."project" "published" where "published"."company_id" = "route"."company_id" and "published"."id" = "route"."project_id" and "published"."public_slug" is not null));
--> statement-breakpoint
CREATE POLICY "collection_calendar_holiday_public_door" ON "wms"."collection_calendar_holiday" AS PERMISSIVE FOR SELECT TO wms_public USING ("company_id" = (select wms.current_company_id()) and exists (select 1 from "wms"."project" "published" where "published"."company_id" = "collection_calendar_holiday"."company_id" and "published"."id" = "collection_calendar_holiday"."project_id" and "published"."public_slug" is not null));
