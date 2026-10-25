CREATE TABLE "wms"."payment" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"customer_id" uuid,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"paid_on" date NOT NULL,
	"reference" text,
	"payer_text" text,
	"source" text NOT NULL,
	"bank_line_key" text,
	"note" text,
	"recorded_by" uuid,
	CONSTRAINT "payment_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "payment_source_one_of" CHECK ("wms"."payment"."source" in ('manual', 'bank-file')),
	CONSTRAINT "payment_amount_positive" CHECK ("wms"."payment"."amount_minor" > 0),
	CONSTRAINT "payment_bank_line_shape" CHECK (("wms"."payment"."source" = 'bank-file') = ("wms"."payment"."bank_line_key" is not null))
);
--> statement-breakpoint
CREATE TABLE "wms"."payment_allocation" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payment_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"reverses_allocation_id" uuid,
	"recorded_by" uuid,
	CONSTRAINT "payment_allocation_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "payment_allocation_amount_shape" CHECK ("wms"."payment_allocation"."amount_minor" <> 0 and ("wms"."payment_allocation"."amount_minor" < 0) = ("wms"."payment_allocation"."reverses_allocation_id" is not null) and "wms"."payment_allocation"."reverses_allocation_id" <> "wms"."payment_allocation"."id")
);
--> statement-breakpoint
ALTER TABLE "wms"."payment" ADD CONSTRAINT "payment_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."payment" ADD CONSTRAINT "payment_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."payment" ADD CONSTRAINT "payment_customer_id_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "wms"."customer"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."payment" ADD CONSTRAINT "payment_recorded_by_fk" FOREIGN KEY ("company_id","recorded_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."payment_allocation" ADD CONSTRAINT "payment_allocation_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."payment_allocation" ADD CONSTRAINT "payment_allocation_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."payment_allocation" ADD CONSTRAINT "payment_allocation_payment_id_fk" FOREIGN KEY ("company_id","project_id","payment_id") REFERENCES "wms"."payment"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."payment_allocation" ADD CONSTRAINT "payment_allocation_invoice_id_fk" FOREIGN KEY ("company_id","project_id","invoice_id") REFERENCES "wms"."invoice"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."payment_allocation" ADD CONSTRAINT "payment_allocation_reverses_allocation_id_fk" FOREIGN KEY ("company_id","project_id","reverses_allocation_id") REFERENCES "wms"."payment_allocation"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."payment_allocation" ADD CONSTRAINT "payment_allocation_recorded_by_fk" FOREIGN KEY ("company_id","recorded_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_bank_line_key_idx" ON "wms"."payment" USING btree ("company_id","bank_line_key") WHERE "wms"."payment"."bank_line_key" is not null;--> statement-breakpoint
CREATE INDEX "payment_customer_id_idx" ON "wms"."payment" USING btree ("company_id","customer_id");--> statement-breakpoint
CREATE INDEX "payment_project_id_paid_on_idx" ON "wms"."payment" USING btree ("company_id","project_id","paid_on");--> statement-breakpoint
CREATE INDEX "payment_recorded_by_idx" ON "wms"."payment" USING btree ("company_id","recorded_by");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_allocation_reverses_allocation_id_idx" ON "wms"."payment_allocation" USING btree ("company_id","reverses_allocation_id") WHERE "wms"."payment_allocation"."reverses_allocation_id" is not null;--> statement-breakpoint
CREATE INDEX "payment_allocation_payment_id_idx" ON "wms"."payment_allocation" USING btree ("company_id","payment_id");--> statement-breakpoint
CREATE INDEX "payment_allocation_invoice_id_idx" ON "wms"."payment_allocation" USING btree ("company_id","invoice_id");--> statement-breakpoint
CREATE INDEX "payment_allocation_recorded_by_idx" ON "wms"."payment_allocation" USING btree ("company_id","recorded_by");--> statement-breakpoint
-- Hand-written from here on (migrations/README.md, #291 C6): the two payment
-- ledgers' tenant fences and revokes. Both are ledgers — a payment as it
-- arrived, an allocation applied or reversed by a row of its own — so the
-- API role appends and never rewrites, and neither carries an audit trigger
-- (EXEMPT in src/sql/audit-trail.ts: its rows are its own history).
ALTER TABLE "wms"."payment" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "payment_tenant_fence" ON "wms"."payment" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));--> statement-breakpoint
REVOKE UPDATE, DELETE ON "wms"."payment" FROM wms_api;--> statement-breakpoint
ALTER TABLE "wms"."payment_allocation" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "payment_allocation_tenant_fence" ON "wms"."payment_allocation" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));--> statement-breakpoint
REVOKE UPDATE, DELETE ON "wms"."payment_allocation" FROM wms_api;
