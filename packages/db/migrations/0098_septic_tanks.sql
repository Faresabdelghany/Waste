-- Septic-tank emptying (M11 of #293): the register of a Property's tank
-- installations (`tank_installation`, current state, each the Container that
-- stands for it in the plan, one tank at a time) and the office's inspections
-- of them (`tank_inspection`, a ledger); the litres a tank was emptied of as a
-- proof of its own (`volume`, carried in `proof_of_service.volume_litres`),
-- and the driver command that records it (`record-volume`). Below
-- drizzle-kit's statements: each table's fence, the register's exclusion
-- constraint, the ledger's revoke from the API role, the register's trigger
-- and its audit trail. No row present changes meaning: no proof or receipt
-- holds a new kind yet, and every proof's volume is null.
CREATE TABLE "wms"."tank_inspection" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tank_installation_id" uuid NOT NULL,
	"inspected_on" date NOT NULL,
	"outcome" text NOT NULL,
	"findings" text,
	"next_inspection_on" date,
	"recorded_by" uuid NOT NULL,
	CONSTRAINT "tank_inspection_outcome_one_of" CHECK ("wms"."tank_inspection"."outcome" in ('approved', 'remarks', 'defects', 'failed')),
	CONSTRAINT "tank_inspection_next_inspection_after" CHECK ("wms"."tank_inspection"."next_inspection_on" is null or "wms"."tank_inspection"."next_inspection_on" > "wms"."tank_inspection"."inspected_on")
);
--> statement-breakpoint
CREATE TABLE "wms"."tank_installation" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"property_id" uuid NOT NULL,
	"container_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"volume_litres" integer NOT NULL,
	"outlet" text NOT NULL,
	"emptying_interval_months" integer NOT NULL,
	"last_emptied_on" date,
	"notes" text,
	CONSTRAINT "tank_installation_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "tank_installation_kind_one_of" CHECK ("wms"."tank_installation"."kind" in ('septic-tank', 'holding-tank', 'small-treatment-plant', 'grease-separator')),
	CONSTRAINT "tank_installation_outlet_one_of" CHECK ("wms"."tank_installation"."outlet" in ('soakaway', 'sand-filter', 'watercourse', 'sewer', 'none')),
	CONSTRAINT "tank_installation_volume_litres_positive" CHECK ("wms"."tank_installation"."volume_litres" > 0),
	CONSTRAINT "tank_installation_emptying_interval_months_range" CHECK ("wms"."tank_installation"."emptying_interval_months" between 1 and 120),
	CONSTRAINT "tank_installation_validity" CHECK ("wms"."tank_installation"."valid_to" is null or "wms"."tank_installation"."valid_to" > "wms"."tank_installation"."valid_from")
);
--> statement-breakpoint
ALTER TABLE "wms"."driver_command" DROP CONSTRAINT "driver_command_kind_one_of";--> statement-breakpoint
ALTER TABLE "wms"."proof_of_service" DROP CONSTRAINT "proof_of_service_kind_one_of";--> statement-breakpoint
ALTER TABLE "wms"."proof_of_service" DROP CONSTRAINT "proof_of_service_pickup_shape";--> statement-breakpoint
ALTER TABLE "wms"."proof_of_service" DROP CONSTRAINT "proof_of_service_kind_shape";--> statement-breakpoint
ALTER TABLE "wms"."proof_of_service" ADD COLUMN "volume_litres" integer;--> statement-breakpoint
ALTER TABLE "wms"."tank_inspection" ADD CONSTRAINT "tank_inspection_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."tank_inspection" ADD CONSTRAINT "tank_inspection_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."tank_inspection" ADD CONSTRAINT "tank_inspection_tank_installation_id_fk" FOREIGN KEY ("company_id","project_id","tank_installation_id") REFERENCES "wms"."tank_installation"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."tank_inspection" ADD CONSTRAINT "tank_inspection_recorded_by_fk" FOREIGN KEY ("company_id","recorded_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."tank_installation" ADD CONSTRAINT "tank_installation_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."tank_installation" ADD CONSTRAINT "tank_installation_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."tank_installation" ADD CONSTRAINT "tank_installation_property_id_fk" FOREIGN KEY ("company_id","project_id","property_id") REFERENCES "wms"."property"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."tank_installation" ADD CONSTRAINT "tank_installation_container_id_fk" FOREIGN KEY ("company_id","project_id","container_id") REFERENCES "wms"."container"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tank_inspection_tank_installation_id_idx" ON "wms"."tank_inspection" USING btree ("company_id","tank_installation_id","inspected_on");--> statement-breakpoint
CREATE INDEX "tank_inspection_project_id_idx" ON "wms"."tank_inspection" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "tank_inspection_recorded_by_idx" ON "wms"."tank_inspection" USING btree ("company_id","recorded_by");--> statement-breakpoint
CREATE INDEX "tank_installation_property_id_idx" ON "wms"."tank_installation" USING btree ("company_id","property_id");--> statement-breakpoint
CREATE INDEX "tank_installation_container_id_idx" ON "wms"."tank_installation" USING btree ("company_id","container_id");--> statement-breakpoint
CREATE INDEX "tank_installation_project_id_idx" ON "wms"."tank_installation" USING btree ("company_id","project_id");--> statement-breakpoint
ALTER TABLE "wms"."driver_command" ADD CONSTRAINT "driver_command_kind_one_of" CHECK ("wms"."driver_command"."kind" in ('start-route', 'arrive', 'complete-pickup', 'skip-pickup', 'fail-pickup', 'report-problem', 'add-photo', 'add-weight', 'add-signature', 'add-note', 'record-unload', 'pause', 'resume', 'end-route', 'record-positions', 'pre-trip-check', 'record-volume'));--> statement-breakpoint
ALTER TABLE "wms"."proof_of_service" ADD CONSTRAINT "proof_of_service_volume_litres_positive" CHECK ("wms"."proof_of_service"."volume_litres" > 0);--> statement-breakpoint
ALTER TABLE "wms"."proof_of_service" ADD CONSTRAINT "proof_of_service_kind_one_of" CHECK ("wms"."proof_of_service"."kind" in ('arrival', 'completion', 'skip', 'failure', 'problem', 'route-started', 'route-ended', 'photo', 'weight', 'volume', 'signature', 'note', 'correction'));--> statement-breakpoint
ALTER TABLE "wms"."proof_of_service" ADD CONSTRAINT "proof_of_service_pickup_shape" CHECK (("wms"."proof_of_service"."kind" in ('arrival', 'completion', 'skip', 'failure', 'weight', 'volume', 'signature', 'correction') and "wms"."proof_of_service"."pickup_id" is not null) or ("wms"."proof_of_service"."kind" in ('route-started', 'route-ended') and "wms"."proof_of_service"."pickup_id" is null) or "wms"."proof_of_service"."kind" in ('problem', 'photo', 'note'));--> statement-breakpoint
ALTER TABLE "wms"."proof_of_service" ADD CONSTRAINT "proof_of_service_kind_shape" CHECK (case "wms"."proof_of_service"."kind" when 'arrival' then "wms"."proof_of_service"."reason" is null and "wms"."proof_of_service"."object_key" is null and "wms"."proof_of_service"."weight_kg" is null and "wms"."proof_of_service"."volume_litres" is null and "wms"."proof_of_service"."outcome" is null when 'completion' then "wms"."proof_of_service"."reason" is null and "wms"."proof_of_service"."object_key" is null and "wms"."proof_of_service"."weight_kg" is null and "wms"."proof_of_service"."volume_litres" is null and "wms"."proof_of_service"."outcome" is null when 'skip' then "wms"."proof_of_service"."reason" is not null and "wms"."proof_of_service"."object_key" is null and "wms"."proof_of_service"."weight_kg" is null and "wms"."proof_of_service"."volume_litres" is null and "wms"."proof_of_service"."outcome" is null when 'failure' then "wms"."proof_of_service"."reason" is not null and "wms"."proof_of_service"."object_key" is null and "wms"."proof_of_service"."weight_kg" is null and "wms"."proof_of_service"."volume_litres" is null and "wms"."proof_of_service"."outcome" is null when 'problem' then "wms"."proof_of_service"."reason" is not null and "wms"."proof_of_service"."object_key" is null and "wms"."proof_of_service"."weight_kg" is null and "wms"."proof_of_service"."volume_litres" is null and "wms"."proof_of_service"."outcome" is null and "wms"."proof_of_service"."note" is not null when 'route-started' then "wms"."proof_of_service"."reason" is null and "wms"."proof_of_service"."object_key" is null and "wms"."proof_of_service"."weight_kg" is null and "wms"."proof_of_service"."volume_litres" is null and "wms"."proof_of_service"."outcome" is null when 'route-ended' then "wms"."proof_of_service"."reason" is null and "wms"."proof_of_service"."object_key" is null and "wms"."proof_of_service"."weight_kg" is null and "wms"."proof_of_service"."volume_litres" is null and "wms"."proof_of_service"."outcome" is null when 'photo' then "wms"."proof_of_service"."reason" is null and "wms"."proof_of_service"."object_key" is not null and "wms"."proof_of_service"."weight_kg" is null and "wms"."proof_of_service"."volume_litres" is null and "wms"."proof_of_service"."outcome" is null when 'weight' then "wms"."proof_of_service"."reason" is null and "wms"."proof_of_service"."object_key" is null and "wms"."proof_of_service"."weight_kg" is not null and "wms"."proof_of_service"."volume_litres" is null and "wms"."proof_of_service"."outcome" is null when 'volume' then "wms"."proof_of_service"."reason" is null and "wms"."proof_of_service"."object_key" is null and "wms"."proof_of_service"."weight_kg" is null and "wms"."proof_of_service"."volume_litres" is not null and "wms"."proof_of_service"."outcome" is null when 'signature' then "wms"."proof_of_service"."reason" is null and "wms"."proof_of_service"."object_key" is not null and "wms"."proof_of_service"."weight_kg" is null and "wms"."proof_of_service"."volume_litres" is null and "wms"."proof_of_service"."outcome" is null when 'note' then "wms"."proof_of_service"."reason" is null and "wms"."proof_of_service"."object_key" is null and "wms"."proof_of_service"."weight_kg" is null and "wms"."proof_of_service"."volume_litres" is null and "wms"."proof_of_service"."outcome" is null and "wms"."proof_of_service"."note" is not null when 'correction' then "wms"."proof_of_service"."object_key" is null and "wms"."proof_of_service"."weight_kg" is null and "wms"."proof_of_service"."volume_litres" is null and "wms"."proof_of_service"."outcome" is not null and "wms"."proof_of_service"."note" is not null and "wms"."proof_of_service"."source" = 'dispatch' else false end);
--> statement-breakpoint
ALTER TABLE "wms"."tank_inspection" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tank_inspection_tenant_fence" ON "wms"."tank_inspection" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
ALTER TABLE "wms"."tank_installation" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tank_installation_tenant_fence" ON "wms"."tank_installation" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
ALTER TABLE "wms"."tank_installation" ADD CONSTRAINT "tank_installation_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "container_id" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "wms"."tank_inspection" FROM wms_api;
--> statement-breakpoint
CREATE TRIGGER "tank_installation_touch_updated_at" BEFORE UPDATE ON "wms"."tank_installation" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER "tank_installation_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."tank_installation" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('property', 'property_id');