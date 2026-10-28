-- A planning area per collection group (O30 of #290, row 2.17): a rule
-- group may match within a planning area of its project instead of the
-- scheme's, its own key into the area, an index for the key, and the shape
-- that keeps it to a rule group, as the rule's vehicle type is. The column is
-- new and null on every row present, which is the scheme's area, so nothing
-- is guarded and nothing is hand-written.
ALTER TABLE "wms"."collection_group" ADD COLUMN "rule_planning_area_id" uuid;--> statement-breakpoint
ALTER TABLE "wms"."collection_group" ADD CONSTRAINT "collection_group_rule_planning_area_id_fk" FOREIGN KEY ("company_id","project_id","rule_planning_area_id") REFERENCES "wms"."planning_area"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collection_group_rule_planning_area_id_idx" ON "wms"."collection_group" USING btree ("company_id","rule_planning_area_id");--> statement-breakpoint
ALTER TABLE "wms"."collection_group" ADD CONSTRAINT "collection_group_rule_area_shape" CHECK ("wms"."collection_group"."stop_source" = 'rule' or "wms"."collection_group"."rule_planning_area_id" is null);