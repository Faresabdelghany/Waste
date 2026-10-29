-- Field inspections and the driver's fill estimate (M23a of #293, rows 26.4
-- and 26.5): an inspector's visit to a container or a property
-- (`field_inspection`) and its photos (`field_inspection_photo`, a ledger of
-- keys in the private `proofs` bucket); a stop's fill estimate
-- (`pickup.fill_level`), which a driver's `record-fill` sets; and the driver
-- command's kind grown by `record-fill`. Below drizzle-kit's statements: each
-- table's fence, the ledger's revoke from the API role, the inspection's touch
-- trigger and its audit trail. No row present changes meaning: no receipt
-- holds the new kind yet, and every stop reads as not estimated.
CREATE TABLE "wms"."field_inspection" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"container_id" uuid,
	"property_id" uuid,
	"inspector_id" uuid NOT NULL,
	"inspected_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"findings" text[] DEFAULT '{}'::text[] NOT NULL,
	"note" text,
	"status" text DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "field_inspection_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "field_inspection_subject_exactly_one" CHECK (("wms"."field_inspection"."container_id" is not null)::int + ("wms"."field_inspection"."property_id" is not null)::int = 1),
	CONSTRAINT "field_inspection_outcome_one_of" CHECK ("wms"."field_inspection"."outcome" in ('compliant', 'minor', 'major')),
	CONSTRAINT "field_inspection_status_one_of" CHECK ("wms"."field_inspection"."status" in ('open', 'closed')),
	CONSTRAINT "field_inspection_findings_subset_of" CHECK ("wms"."field_inspection"."findings" <@ ARRAY['contamination', 'wrong-fraction', 'overfilled', 'damaged', 'blocked-access', 'missing-container', 'other']::text[]),
	CONSTRAINT "field_inspection_findings_shape" CHECK (("wms"."field_inspection"."outcome" = 'compliant') = (cardinality("wms"."field_inspection"."findings") = 0)),
	CONSTRAINT "field_inspection_closed_shape" CHECK (("wms"."field_inspection"."status" = 'closed') = ("wms"."field_inspection"."closed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "wms"."field_inspection_photo" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"inspection_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"recorded_by" uuid NOT NULL,
	CONSTRAINT "field_inspection_photo_object_key_key" UNIQUE("company_id","object_key")
);
--> statement-breakpoint
ALTER TABLE "wms"."driver_command" DROP CONSTRAINT "driver_command_kind_one_of";--> statement-breakpoint
ALTER TABLE "wms"."pickup" ADD COLUMN "fill_level" text;--> statement-breakpoint
ALTER TABLE "wms"."field_inspection" ADD CONSTRAINT "field_inspection_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."field_inspection" ADD CONSTRAINT "field_inspection_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."field_inspection" ADD CONSTRAINT "field_inspection_container_id_fk" FOREIGN KEY ("company_id","project_id","container_id") REFERENCES "wms"."container"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."field_inspection" ADD CONSTRAINT "field_inspection_property_id_fk" FOREIGN KEY ("company_id","project_id","property_id") REFERENCES "wms"."property"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."field_inspection" ADD CONSTRAINT "field_inspection_inspector_id_fk" FOREIGN KEY ("company_id","inspector_id") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."field_inspection_photo" ADD CONSTRAINT "field_inspection_photo_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."field_inspection_photo" ADD CONSTRAINT "field_inspection_photo_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."field_inspection_photo" ADD CONSTRAINT "field_inspection_photo_inspection_id_fk" FOREIGN KEY ("company_id","project_id","inspection_id") REFERENCES "wms"."field_inspection"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."field_inspection_photo" ADD CONSTRAINT "field_inspection_photo_recorded_by_fk" FOREIGN KEY ("company_id","recorded_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "field_inspection_container_id_idx" ON "wms"."field_inspection" USING btree ("company_id","container_id","inspected_at");--> statement-breakpoint
CREATE INDEX "field_inspection_property_id_idx" ON "wms"."field_inspection" USING btree ("company_id","property_id","inspected_at");--> statement-breakpoint
CREATE INDEX "field_inspection_project_id_idx" ON "wms"."field_inspection" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "field_inspection_inspector_id_idx" ON "wms"."field_inspection" USING btree ("company_id","inspector_id");--> statement-breakpoint
CREATE INDEX "field_inspection_photo_inspection_id_idx" ON "wms"."field_inspection_photo" USING btree ("company_id","inspection_id");--> statement-breakpoint
CREATE INDEX "field_inspection_photo_project_id_idx" ON "wms"."field_inspection_photo" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "field_inspection_photo_recorded_by_idx" ON "wms"."field_inspection_photo" USING btree ("company_id","recorded_by");--> statement-breakpoint
ALTER TABLE "wms"."driver_command" ADD CONSTRAINT "driver_command_kind_one_of" CHECK ("wms"."driver_command"."kind" in ('start-route', 'arrive', 'complete-pickup', 'skip-pickup', 'fail-pickup', 'report-problem', 'add-photo', 'add-weight', 'add-signature', 'add-note', 'record-unload', 'pause', 'resume', 'end-route', 'record-positions', 'pre-trip-check', 'record-fill'));--> statement-breakpoint
ALTER TABLE "wms"."pickup" ADD CONSTRAINT "pickup_fill_level_one_of" CHECK ("wms"."pickup"."fill_level" in ('empty', 'quarter', 'half', 'three-quarters', 'full', 'overflowing'));
--> statement-breakpoint
ALTER TABLE "wms"."field_inspection" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "field_inspection_tenant_fence" ON "wms"."field_inspection" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
ALTER TABLE "wms"."field_inspection_photo" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "field_inspection_photo_tenant_fence" ON "wms"."field_inspection_photo" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "wms"."field_inspection_photo" FROM wms_api;
--> statement-breakpoint
CREATE TRIGGER "field_inspection_touch_updated_at" BEFORE UPDATE ON "wms"."field_inspection" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER "field_inspection_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."field_inspection" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
