-- Decommission Reasons (O30 of #290, row 9.6): the company's own list of why
-- a container is scrapped, kept in Settings › Master data, and the reason a
-- decommission names in the Stock Movement ledger. drizzle-kit's table, the
-- ledger's new column, its key and its index come first; then, hand-written
-- and run by the owner, every company is given the eight reasons it starts
-- with and every decommission already recorded is given `other`, its free
-- text kept as the note (src/sql/decommission-reasons.ts), so that the shape
-- check drizzle-kit wrote, moved below them, holds on every row; then the
-- table's fence, trigger and audit trail.
CREATE TABLE "wms"."decommission_reason" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	CONSTRAINT "decommission_reason_code_key" UNIQUE("company_id","code"),
	CONSTRAINT "decommission_reason_name_key" UNIQUE("company_id","name"),
	CONSTRAINT "decommission_reason_tenant_key" UNIQUE("company_id","id"),
	CONSTRAINT "decommission_reason_code_lowercase" CHECK ("wms"."decommission_reason"."code" = lower("wms"."decommission_reason"."code")),
	CONSTRAINT "decommission_reason_status_one_of" CHECK ("wms"."decommission_reason"."status" in ('active', 'inactive'))
);
--> statement-breakpoint
ALTER TABLE "wms"."stock_movement" ADD COLUMN "decommission_reason_id" uuid;
--> statement-breakpoint
ALTER TABLE "wms"."decommission_reason" ADD CONSTRAINT "decommission_reason_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "wms"."stock_movement" ADD CONSTRAINT "stock_movement_decommission_reason_id_fk" FOREIGN KEY ("company_id","decommission_reason_id") REFERENCES "wms"."decommission_reason"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "stock_movement_decommission_reason_id_idx" ON "wms"."stock_movement" USING btree ("company_id","decommission_reason_id");
--> statement-breakpoint
INSERT INTO "wms"."decommission_reason" ("company_id", "code", "name") SELECT c."id", v."code", v."name" FROM "wms"."company" AS c CROSS JOIN (VALUES ('damaged', 'Damaged'), ('worn-out', 'Worn out'), ('fire', 'Fire'), ('stolen', 'Stolen'), ('lost', 'Lost'), ('obsolete-type', 'Obsolete type'), ('customer-ended', 'Customer ended'), ('other', 'Other')) AS v ("code", "name") ON CONFLICT ("company_id", "code") DO NOTHING;
--> statement-breakpoint
UPDATE "wms"."stock_movement" AS m SET "decommission_reason_id" = r."id" FROM "wms"."decommission_reason" AS r WHERE r."company_id" = m."company_id" AND r."code" = 'other' AND m."kind" = 'decommission' AND m."decommission_reason_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "wms"."stock_movement" ADD CONSTRAINT "stock_movement_decommission_reason_shape" CHECK (("wms"."stock_movement"."kind" = 'decommission') = ("wms"."stock_movement"."decommission_reason_id" is not null));
--> statement-breakpoint
ALTER TABLE "wms"."decommission_reason" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "decommission_reason_tenant_fence" ON "wms"."decommission_reason" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "decommission_reason_touch_updated_at" BEFORE UPDATE ON "wms"."decommission_reason" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER "decommission_reason_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."decommission_reason" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
