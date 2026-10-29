-- Right-sizing proposals (M23b of #293, row 26.5): a subscription's
-- container a size down or up, or its collections fewer or more, proposed
-- from its drivers' fill estimates (`right_sizing_proposal`), one open per
-- subscription, approved by the office into a subscription change or
-- dismissed with why. Below drizzle-kit's statements: the table's fence, its
-- touch trigger and its audit trail. No row present changes meaning.
CREATE TABLE "wms"."right_sizing_proposal" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"suggested_product_id" uuid,
	"evidence" text[] NOT NULL,
	"evidence_through" timestamp with time zone NOT NULL,
	"subscription_updated_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"dismiss_note" text,
	"changed_on" date,
	"replacement_subscription_id" uuid,
	CONSTRAINT "right_sizing_proposal_direction_one_of" CHECK ("wms"."right_sizing_proposal"."direction" in ('smaller', 'bigger', 'less-frequent', 'more-frequent')),
	CONSTRAINT "right_sizing_proposal_status_one_of" CHECK ("wms"."right_sizing_proposal"."status" in ('open', 'approved', 'dismissed')),
	CONSTRAINT "right_sizing_proposal_evidence_subset_of" CHECK ("wms"."right_sizing_proposal"."evidence" <@ ARRAY['empty', 'quarter', 'half', 'three-quarters', 'full', 'overflowing']::text[]),
	CONSTRAINT "right_sizing_proposal_evidence_non_empty" CHECK (cardinality("wms"."right_sizing_proposal"."evidence") > 0),
	CONSTRAINT "right_sizing_proposal_suggestion_shape" CHECK (("wms"."right_sizing_proposal"."direction" in ('smaller', 'bigger')) = ("wms"."right_sizing_proposal"."suggested_product_id" is not null)),
	CONSTRAINT "right_sizing_proposal_decided_shape" CHECK (("wms"."right_sizing_proposal"."status" <> 'open') = ("wms"."right_sizing_proposal"."decided_at" is not null and "wms"."right_sizing_proposal"."decided_by" is not null)),
	CONSTRAINT "right_sizing_proposal_dismiss_shape" CHECK (("wms"."right_sizing_proposal"."status" = 'dismissed') = ("wms"."right_sizing_proposal"."dismiss_note" is not null)),
	CONSTRAINT "right_sizing_proposal_change_shape" CHECK (("wms"."right_sizing_proposal"."changed_on" is null) = ("wms"."right_sizing_proposal"."replacement_subscription_id" is null) and ("wms"."right_sizing_proposal"."changed_on" is null or "wms"."right_sizing_proposal"."status" = 'approved'))
);
--> statement-breakpoint
ALTER TABLE "wms"."right_sizing_proposal" ADD CONSTRAINT "right_sizing_proposal_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."right_sizing_proposal" ADD CONSTRAINT "right_sizing_proposal_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."right_sizing_proposal" ADD CONSTRAINT "right_sizing_proposal_subscription_id_fk" FOREIGN KEY ("company_id","project_id","subscription_id") REFERENCES "wms"."subscription"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."right_sizing_proposal" ADD CONSTRAINT "right_sizing_proposal_product_id_fk" FOREIGN KEY ("company_id","project_id","product_id") REFERENCES "wms"."product"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."right_sizing_proposal" ADD CONSTRAINT "right_sizing_proposal_suggested_product_id_fk" FOREIGN KEY ("company_id","project_id","suggested_product_id") REFERENCES "wms"."product"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."right_sizing_proposal" ADD CONSTRAINT "right_sizing_proposal_replacement_subscription_id_fk" FOREIGN KEY ("company_id","project_id","replacement_subscription_id") REFERENCES "wms"."subscription"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."right_sizing_proposal" ADD CONSTRAINT "right_sizing_proposal_decided_by_fk" FOREIGN KEY ("company_id","decided_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "right_sizing_proposal_subscription_id_open_key" ON "wms"."right_sizing_proposal" USING btree ("company_id","subscription_id") WHERE "wms"."right_sizing_proposal"."status" = 'open';--> statement-breakpoint
CREATE INDEX "right_sizing_proposal_subscription_id_idx" ON "wms"."right_sizing_proposal" USING btree ("company_id","subscription_id");--> statement-breakpoint
CREATE INDEX "right_sizing_proposal_project_id_idx" ON "wms"."right_sizing_proposal" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "right_sizing_proposal_product_id_idx" ON "wms"."right_sizing_proposal" USING btree ("company_id","product_id");--> statement-breakpoint
CREATE INDEX "right_sizing_proposal_suggested_product_id_idx" ON "wms"."right_sizing_proposal" USING btree ("company_id","suggested_product_id");--> statement-breakpoint
CREATE INDEX "right_sizing_proposal_replacement_subscription_id_idx" ON "wms"."right_sizing_proposal" USING btree ("company_id","replacement_subscription_id");--> statement-breakpoint
CREATE INDEX "right_sizing_proposal_decided_by_idx" ON "wms"."right_sizing_proposal" USING btree ("company_id","decided_by");
--> statement-breakpoint
ALTER TABLE "wms"."right_sizing_proposal" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "right_sizing_proposal_tenant_fence" ON "wms"."right_sizing_proposal" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "right_sizing_proposal_touch_updated_at" BEFORE UPDATE ON "wms"."right_sizing_proposal" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER "right_sizing_proposal_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."right_sizing_proposal" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
