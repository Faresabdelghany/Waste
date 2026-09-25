CREATE TABLE "wms"."billable_event" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"service_date" date NOT NULL,
	"agreement_id" uuid,
	"subscription_id" uuid,
	"product_id" uuid,
	"quantity" integer NOT NULL,
	"unit_price_minor" integer,
	"net_minor" integer,
	"vat_percent" integer,
	"vat_minor" integer,
	"currency" text,
	"price_list_row_id" uuid,
	"block_reason" text,
	"route_id" uuid,
	"pickup_id" uuid,
	"ticket_id" uuid,
	"reverses_event_id" uuid,
	"source_event_id" uuid,
	"created_by" uuid,
	"override_reason" text,
	"note" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	CONSTRAINT "billable_event_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "billable_event_kind_one_of" CHECK ("wms"."billable_event"."kind" in ('pickup', 'ticket', 'manual', 'reversal')),
	CONSTRAINT "billable_event_block_reason_one_of" CHECK ("wms"."billable_event"."block_reason" in ('no-subscription', 'agreement-draft', 'no-price-list', 'no-price-row', 'no-product', 'no-vat-rate')),
	CONSTRAINT "billable_event_cancel_reason_one_of" CHECK ("wms"."billable_event"."cancel_reason" in ('pickup-corrected', 'duplicate', 'not-delivered', 'other')),
	CONSTRAINT "billable_event_quantity_positive" CHECK ("wms"."billable_event"."quantity" > 0),
	CONSTRAINT "billable_event_priced_references" CHECK ("wms"."billable_event"."block_reason" is not null or ("wms"."billable_event"."agreement_id" is not null and "wms"."billable_event"."product_id" is not null)),
	CONSTRAINT "billable_event_priced_shape" CHECK (("wms"."billable_event"."block_reason" is null) = ("wms"."billable_event"."net_minor" is not null) and ("wms"."billable_event"."net_minor" is null) = ("wms"."billable_event"."unit_price_minor" is null) and ("wms"."billable_event"."net_minor" is null) = ("wms"."billable_event"."vat_percent" is null) and ("wms"."billable_event"."net_minor" is null) = ("wms"."billable_event"."vat_minor" is null) and ("wms"."billable_event"."net_minor" is null) = ("wms"."billable_event"."currency" is null)),
	CONSTRAINT "billable_event_amounts_shape" CHECK ("wms"."billable_event"."net_minor" is null or "wms"."billable_event"."net_minor" = (case "wms"."billable_event"."kind" when 'reversal' then -1 else 1 end) * "wms"."billable_event"."unit_price_minor" * "wms"."billable_event"."quantity"),
	CONSTRAINT "billable_event_vat_shape" CHECK ("wms"."billable_event"."vat_minor" is null or "wms"."billable_event"."vat_minor" = round("wms"."billable_event"."net_minor" * "wms"."billable_event"."vat_percent" / 100.0)),
	CONSTRAINT "billable_event_row_shape" CHECK ("wms"."billable_event"."price_list_row_id" is not null or "wms"."billable_event"."block_reason" is not null or "wms"."billable_event"."kind" in ('manual', 'reversal')),
	CONSTRAINT "billable_event_override_shape" CHECK (("wms"."billable_event"."kind" = 'manual' and "wms"."billable_event"."price_list_row_id" is null and "wms"."billable_event"."block_reason" is null) = ("wms"."billable_event"."override_reason" is not null)),
	CONSTRAINT "billable_event_pickup_shape" CHECK ("wms"."billable_event"."pickup_id" is null or "wms"."billable_event"."route_id" is not null),
	CONSTRAINT "billable_event_kind_shape" CHECK (case "wms"."billable_event"."kind" when 'pickup' then "wms"."billable_event"."pickup_id" is not null and "wms"."billable_event"."ticket_id" is null and "wms"."billable_event"."reverses_event_id" is null when 'ticket' then "wms"."billable_event"."ticket_id" is not null and "wms"."billable_event"."pickup_id" is null and "wms"."billable_event"."reverses_event_id" is null when 'manual' then "wms"."billable_event"."pickup_id" is null and "wms"."billable_event"."ticket_id" is null and "wms"."billable_event"."reverses_event_id" is null and "wms"."billable_event"."created_by" is not null when 'reversal' then "wms"."billable_event"."reverses_event_id" is not null and "wms"."billable_event"."pickup_id" is null and "wms"."billable_event"."ticket_id" is null and "wms"."billable_event"."net_minor" is not null and "wms"."billable_event"."net_minor" <= 0 else false end),
	CONSTRAINT "billable_event_origin_shape" CHECK (("wms"."billable_event"."created_by" is null) = ("wms"."billable_event"."source_event_id" is not null)),
	CONSTRAINT "billable_event_cancel_shape" CHECK (("wms"."billable_event"."cancelled_at" is null) = ("wms"."billable_event"."cancel_reason" is null) and ("wms"."billable_event"."cancelled_by" is null or "wms"."billable_event"."cancelled_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "wms"."billing_run" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"requested_by" uuid,
	"completed_at" timestamp with time zone,
	"event_count" integer DEFAULT 0 NOT NULL,
	"invoice_count" integer DEFAULT 0 NOT NULL,
	"excluded_customer_count" integer DEFAULT 0 NOT NULL,
	"net_minor" bigint DEFAULT 0 NOT NULL,
	"vat_minor" bigint DEFAULT 0 NOT NULL,
	"note" text,
	CONSTRAINT "billing_run_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "billing_run_status_one_of" CHECK ("wms"."billing_run"."status" in ('requested', 'completed', 'failed')),
	CONSTRAINT "billing_run_period_shape" CHECK ("wms"."billing_run"."period_to" >= "wms"."billing_run"."period_from"),
	CONSTRAINT "billing_run_stamps_shape" CHECK (("wms"."billing_run"."status" = 'completed') = ("wms"."billing_run"."completed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "wms"."billing_run_exclusion" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"billing_run_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"event_count" integer NOT NULL,
	CONSTRAINT "billing_run_exclusion_billing_run_id_customer_id_key" UNIQUE("company_id","billing_run_id","customer_id"),
	CONSTRAINT "billing_run_exclusion_reason_one_of" CHECK ("wms"."billing_run_exclusion"."reason" in ('all-events-blocked')),
	CONSTRAINT "billing_run_exclusion_event_count_positive" CHECK ("wms"."billing_run_exclusion"."event_count" > 0)
);
--> statement-breakpoint
CREATE TABLE "wms"."invoice" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"number" integer NOT NULL,
	"kind" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"issued_on" date NOT NULL,
	"due_on" date NOT NULL,
	"period_from" date,
	"period_to" date,
	"billing_run_id" uuid,
	"credits_invoice_id" uuid,
	"credit_reason" text,
	"credit_note" text,
	"net_minor" bigint NOT NULL,
	"vat_minor" bigint NOT NULL,
	"gross_minor" bigint NOT NULL,
	"issued_by" uuid,
	CONSTRAINT "invoice_number_key" UNIQUE("company_id","number"),
	CONSTRAINT "invoice_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "invoice_kind_one_of" CHECK ("wms"."invoice"."kind" in ('invoice', 'credit-note')),
	CONSTRAINT "invoice_credit_reason_one_of" CHECK ("wms"."invoice"."credit_reason" in ('service-not-delivered', 'quantity-correction', 'price-correction', 'duplicate', 'other')),
	CONSTRAINT "invoice_due_shape" CHECK ("wms"."invoice"."due_on" >= "wms"."invoice"."issued_on"),
	CONSTRAINT "invoice_period_shape" CHECK (("wms"."invoice"."period_from" is null) = ("wms"."invoice"."period_to" is null) and ("wms"."invoice"."kind" = 'invoice') = ("wms"."invoice"."period_from" is not null)),
	CONSTRAINT "invoice_kind_shape" CHECK (("wms"."invoice"."kind" = 'invoice') = ("wms"."invoice"."billing_run_id" is not null) and ("wms"."invoice"."kind" = 'credit-note') = ("wms"."invoice"."credits_invoice_id" is not null) and ("wms"."invoice"."kind" = 'credit-note') = ("wms"."invoice"."credit_reason" is not null)),
	CONSTRAINT "invoice_credits_shape" CHECK ("wms"."invoice"."credits_invoice_id" <> "wms"."invoice"."id"),
	CONSTRAINT "invoice_totals_shape" CHECK ("wms"."invoice"."gross_minor" = "wms"."invoice"."net_minor" + "wms"."invoice"."vat_minor" and ("wms"."invoice"."kind" <> 'credit-note' or "wms"."invoice"."net_minor" <= 0))
);
--> statement-breakpoint
CREATE TABLE "wms"."invoice_line" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"billable_event_id" uuid,
	"credits_line_id" uuid,
	"description" text NOT NULL,
	"product_id" uuid,
	"service_date" date,
	"quantity" integer NOT NULL,
	"unit_price_minor" integer NOT NULL,
	"net_minor" integer NOT NULL,
	"vat_percent" integer NOT NULL,
	"vat_minor" integer NOT NULL,
	CONSTRAINT "invoice_line_invoice_id_position_key" UNIQUE("company_id","invoice_id","position"),
	CONSTRAINT "invoice_line_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "invoice_line_position_positive" CHECK ("wms"."invoice_line"."position" > 0),
	CONSTRAINT "invoice_line_quantity_positive" CHECK ("wms"."invoice_line"."quantity" > 0),
	CONSTRAINT "invoice_line_source_exactly_one" CHECK (("wms"."invoice_line"."billable_event_id" is not null)::int + ("wms"."invoice_line"."credits_line_id" is not null)::int = 1),
	CONSTRAINT "invoice_line_amounts_shape" CHECK (abs("wms"."invoice_line"."net_minor") = "wms"."invoice_line"."unit_price_minor" * "wms"."invoice_line"."quantity" and ("wms"."invoice_line"."credits_line_id" is null or "wms"."invoice_line"."net_minor" <= 0)),
	CONSTRAINT "invoice_line_vat_shape" CHECK ("wms"."invoice_line"."vat_minor" = round("wms"."invoice_line"."net_minor" * "wms"."invoice_line"."vat_percent" / 100.0))
);
--> statement-breakpoint
CREATE TABLE "wms"."price_list" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"currency" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"notes" text,
	CONSTRAINT "price_list_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "price_list_validity" CHECK ("wms"."price_list"."valid_to" is null or "wms"."price_list"."valid_to" > "wms"."price_list"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "wms"."price_list_row" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"price_list_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"unit_price_minor" integer NOT NULL,
	"planning_area_id" uuid,
	"customer_kind" text,
	"container_type_id" uuid,
	"waste_fraction_id" uuid,
	"customer_id" uuid,
	"note" text,
	"condition_key" text GENERATED ALWAYS AS (coalesce("planning_area_id"::text, '') || '/' || coalesce("customer_kind", '') || '/' || coalesce("container_type_id"::text, '') || '/' || coalesce("waste_fraction_id"::text, '') || '/' || coalesce("customer_id"::text, '')) STORED NOT NULL,
	CONSTRAINT "price_list_row_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "price_list_row_validity" CHECK ("wms"."price_list_row"."valid_to" is null or "wms"."price_list_row"."valid_to" > "wms"."price_list_row"."valid_from"),
	CONSTRAINT "price_list_row_customer_kind_one_of" CHECK ("wms"."price_list_row"."customer_kind" in ('person', 'organisation')),
	CONSTRAINT "price_list_row_unit_price_not_negative" CHECK ("wms"."price_list_row"."unit_price_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "wms"."service_area" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"boundary_text" text NOT NULL,
	"notes" text,
	CONSTRAINT "service_area_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "service_area_validity" CHECK ("wms"."service_area"."valid_to" is null or "wms"."service_area"."valid_to" > "wms"."service_area"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "wms"."service_area_assignment" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"service_area_id" uuid NOT NULL,
	"service_provider_id" uuid NOT NULL,
	"notes" text,
	CONSTRAINT "service_area_assignment_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "service_area_assignment_validity" CHECK ("wms"."service_area_assignment"."valid_to" is null or "wms"."service_area_assignment"."valid_to" > "wms"."service_area_assignment"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "wms"."service_area_planning_area" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"service_area_id" uuid NOT NULL,
	"planning_area_id" uuid NOT NULL,
	CONSTRAINT "service_area_planning_area_membership_key" UNIQUE("company_id","service_area_id","planning_area_id")
);
--> statement-breakpoint
CREATE TABLE "wms"."service_area_waste_fraction" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"service_area_id" uuid NOT NULL,
	"waste_fraction_id" uuid NOT NULL,
	CONSTRAINT "service_area_waste_fraction_membership_key" UNIQUE("company_id","service_area_id","waste_fraction_id")
);
--> statement-breakpoint
CREATE TABLE "wms"."service_provider_price" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"service_area_assignment_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"bid_minor" integer NOT NULL,
	"unit_price_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"indexed_from_id" uuid,
	"index_label" text,
	"index_basis_points" integer,
	"index_base" text,
	"notes" text,
	CONSTRAINT "service_provider_price_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "service_provider_price_validity" CHECK ("wms"."service_provider_price"."valid_to" is null or "wms"."service_provider_price"."valid_to" > "wms"."service_provider_price"."valid_from"),
	CONSTRAINT "service_provider_price_index_base_one_of" CHECK ("wms"."service_provider_price"."index_base" in ('bid', 'current-fee')),
	CONSTRAINT "service_provider_price_bid_not_negative" CHECK ("wms"."service_provider_price"."bid_minor" >= 0),
	CONSTRAINT "service_provider_price_unit_price_not_negative" CHECK ("wms"."service_provider_price"."unit_price_minor" >= 0),
	CONSTRAINT "service_provider_price_index_shape" CHECK (("wms"."service_provider_price"."indexed_from_id" is null) = ("wms"."service_provider_price"."index_label" is null) and ("wms"."service_provider_price"."indexed_from_id" is null) = ("wms"."service_provider_price"."index_basis_points" is null) and ("wms"."service_provider_price"."indexed_from_id" is null) = ("wms"."service_provider_price"."index_base" is null) and "wms"."service_provider_price"."indexed_from_id" <> "wms"."service_provider_price"."id")
);
--> statement-breakpoint
CREATE TABLE "wms"."settlement" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"service_area_assignment_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"currency" text NOT NULL,
	"calculated_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"line_count" integer DEFAULT 0 NOT NULL,
	"net_minor" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "settlement_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "settlement_validity" CHECK ("wms"."settlement"."valid_to" is null or "wms"."settlement"."valid_to" > "wms"."settlement"."valid_from"),
	CONSTRAINT "settlement_status_one_of" CHECK ("wms"."settlement"."status" in ('open', 'calculated', 'closed')),
	CONSTRAINT "settlement_stamps_shape" CHECK (case "wms"."settlement"."status" when 'open' then "wms"."settlement"."calculated_at" is null and "wms"."settlement"."closed_at" is null and "wms"."settlement"."closed_by" is null when 'calculated' then "wms"."settlement"."calculated_at" is not null and "wms"."settlement"."closed_at" is null and "wms"."settlement"."closed_by" is null when 'closed' then "wms"."settlement"."calculated_at" is not null and "wms"."settlement"."closed_at" is not null and "wms"."settlement"."closed_by" is not null else false end),
	CONSTRAINT "settlement_period_closed" CHECK ("wms"."settlement"."valid_to" is not null)
);
--> statement-breakpoint
CREATE TABLE "wms"."settlement_event" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settlement_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"line_count" integer NOT NULL,
	"net_minor" bigint NOT NULL,
	"reason" text,
	"recorded_by" uuid NOT NULL,
	CONSTRAINT "settlement_event_kind_one_of" CHECK ("wms"."settlement_event"."kind" in ('calculated', 'closed', 'reopened')),
	CONSTRAINT "settlement_event_status_one_of" CHECK ("wms"."settlement_event"."status" in ('open', 'calculated', 'closed')),
	CONSTRAINT "settlement_event_reason_shape" CHECK (("wms"."settlement_event"."kind" = 'reopened') = ("wms"."settlement_event"."reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "wms"."settlement_line" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settlement_id" uuid NOT NULL,
	"billable_event_id" uuid NOT NULL,
	"service_provider_price_id" uuid,
	"quantity" integer NOT NULL,
	"unit_price_minor" integer,
	"net_minor" integer,
	CONSTRAINT "settlement_line_settlement_id_billable_event_id_key" UNIQUE("company_id","settlement_id","billable_event_id"),
	CONSTRAINT "settlement_line_quantity_positive" CHECK ("wms"."settlement_line"."quantity" > 0),
	CONSTRAINT "settlement_line_priced_shape" CHECK (("wms"."settlement_line"."service_provider_price_id" is null) = ("wms"."settlement_line"."net_minor" is null) and ("wms"."settlement_line"."net_minor" is null) = ("wms"."settlement_line"."unit_price_minor" is null))
);
--> statement-breakpoint
CREATE TABLE "wms"."weight_review" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unload_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"note" text,
	"correction_unload_id" uuid,
	"reviewed_by" uuid NOT NULL,
	CONSTRAINT "weight_review_decision_one_of" CHECK ("wms"."weight_review"."decision" in ('approved', 'rejected', 'corrected')),
	CONSTRAINT "weight_review_note_shape" CHECK ("wms"."weight_review"."decision" <> 'rejected' or "wms"."weight_review"."note" is not null),
	CONSTRAINT "weight_review_correction_shape" CHECK (("wms"."weight_review"."decision" = 'corrected') = ("wms"."weight_review"."correction_unload_id" is not null) and ("wms"."weight_review"."correction_unload_id" is null or "wms"."weight_review"."correction_unload_id" <> "wms"."weight_review"."unload_id"))
);
--> statement-breakpoint
ALTER TABLE "wms"."outbox_event" DROP CONSTRAINT "outbox_event_kind_one_of";--> statement-breakpoint
ALTER TABLE "wms"."outbox_event" DROP CONSTRAINT "outbox_event_aggregate_kind_one_of";--> statement-breakpoint
ALTER TABLE "wms"."company" ADD COLUMN "next_invoice_number" integer DEFAULT 1000 NOT NULL;--> statement-breakpoint
ALTER TABLE "wms"."product" ADD COLUMN "invoice_name" text;--> statement-breakpoint
ALTER TABLE "wms"."product" ADD COLUMN "invoice_code" text;--> statement-breakpoint
ALTER TABLE "wms"."product" ADD COLUMN "vat_percent" integer;--> statement-breakpoint
ALTER TABLE "wms"."agreement" ADD COLUMN "price_list_id" uuid;--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD CONSTRAINT "billable_event_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD CONSTRAINT "billable_event_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD CONSTRAINT "billable_event_agreement_id_fk" FOREIGN KEY ("company_id","project_id","agreement_id") REFERENCES "wms"."agreement"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD CONSTRAINT "billable_event_subscription_id_fk" FOREIGN KEY ("company_id","project_id","subscription_id") REFERENCES "wms"."subscription"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD CONSTRAINT "billable_event_product_id_fk" FOREIGN KEY ("company_id","project_id","product_id") REFERENCES "wms"."product"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD CONSTRAINT "billable_event_price_list_row_id_fk" FOREIGN KEY ("company_id","project_id","price_list_row_id") REFERENCES "wms"."price_list_row"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD CONSTRAINT "billable_event_route_id_fk" FOREIGN KEY ("company_id","project_id","route_id") REFERENCES "wms"."route"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD CONSTRAINT "billable_event_route_id_pickup_id_fk" FOREIGN KEY ("company_id","project_id","route_id","pickup_id") REFERENCES "wms"."pickup"("company_id","project_id","route_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD CONSTRAINT "billable_event_ticket_id_fk" FOREIGN KEY ("company_id","project_id","ticket_id") REFERENCES "wms"."ticket"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD CONSTRAINT "billable_event_reverses_event_id_fk" FOREIGN KEY ("company_id","project_id","reverses_event_id") REFERENCES "wms"."billable_event"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD CONSTRAINT "billable_event_created_by_fk" FOREIGN KEY ("company_id","created_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD CONSTRAINT "billable_event_cancelled_by_fk" FOREIGN KEY ("company_id","cancelled_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."billing_run" ADD CONSTRAINT "billing_run_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."billing_run" ADD CONSTRAINT "billing_run_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."billing_run" ADD CONSTRAINT "billing_run_requested_by_fk" FOREIGN KEY ("company_id","requested_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."billing_run_exclusion" ADD CONSTRAINT "billing_run_exclusion_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."billing_run_exclusion" ADD CONSTRAINT "billing_run_exclusion_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."billing_run_exclusion" ADD CONSTRAINT "billing_run_exclusion_billing_run_id_fk" FOREIGN KEY ("company_id","project_id","billing_run_id") REFERENCES "wms"."billing_run"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."billing_run_exclusion" ADD CONSTRAINT "billing_run_exclusion_customer_id_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "wms"."customer"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."invoice" ADD CONSTRAINT "invoice_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."invoice" ADD CONSTRAINT "invoice_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."invoice" ADD CONSTRAINT "invoice_customer_id_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "wms"."customer"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."invoice" ADD CONSTRAINT "invoice_billing_run_id_fk" FOREIGN KEY ("company_id","project_id","billing_run_id") REFERENCES "wms"."billing_run"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."invoice" ADD CONSTRAINT "invoice_credits_invoice_id_fk" FOREIGN KEY ("company_id","project_id","credits_invoice_id") REFERENCES "wms"."invoice"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."invoice" ADD CONSTRAINT "invoice_issued_by_fk" FOREIGN KEY ("company_id","issued_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."invoice_line" ADD CONSTRAINT "invoice_line_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."invoice_line" ADD CONSTRAINT "invoice_line_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."invoice_line" ADD CONSTRAINT "invoice_line_invoice_id_fk" FOREIGN KEY ("company_id","project_id","invoice_id") REFERENCES "wms"."invoice"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."invoice_line" ADD CONSTRAINT "invoice_line_billable_event_id_fk" FOREIGN KEY ("company_id","project_id","billable_event_id") REFERENCES "wms"."billable_event"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."invoice_line" ADD CONSTRAINT "invoice_line_credits_line_id_fk" FOREIGN KEY ("company_id","project_id","credits_line_id") REFERENCES "wms"."invoice_line"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."invoice_line" ADD CONSTRAINT "invoice_line_product_id_fk" FOREIGN KEY ("company_id","project_id","product_id") REFERENCES "wms"."product"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."price_list" ADD CONSTRAINT "price_list_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."price_list" ADD CONSTRAINT "price_list_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."price_list_row" ADD CONSTRAINT "price_list_row_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."price_list_row" ADD CONSTRAINT "price_list_row_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."price_list_row" ADD CONSTRAINT "price_list_row_price_list_id_fk" FOREIGN KEY ("company_id","project_id","price_list_id") REFERENCES "wms"."price_list"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."price_list_row" ADD CONSTRAINT "price_list_row_product_id_fk" FOREIGN KEY ("company_id","project_id","product_id") REFERENCES "wms"."product"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."price_list_row" ADD CONSTRAINT "price_list_row_planning_area_id_fk" FOREIGN KEY ("company_id","project_id","planning_area_id") REFERENCES "wms"."planning_area"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."price_list_row" ADD CONSTRAINT "price_list_row_container_type_id_fk" FOREIGN KEY ("company_id","container_type_id") REFERENCES "wms"."container_type"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."price_list_row" ADD CONSTRAINT "price_list_row_waste_fraction_id_fk" FOREIGN KEY ("company_id","waste_fraction_id") REFERENCES "wms"."waste_fraction"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."price_list_row" ADD CONSTRAINT "price_list_row_customer_id_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "wms"."customer"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."service_area" ADD CONSTRAINT "service_area_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."service_area" ADD CONSTRAINT "service_area_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."service_area_assignment" ADD CONSTRAINT "service_area_assignment_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."service_area_assignment" ADD CONSTRAINT "service_area_assignment_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."service_area_assignment" ADD CONSTRAINT "service_area_assignment_service_area_id_fk" FOREIGN KEY ("company_id","project_id","service_area_id") REFERENCES "wms"."service_area"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."service_area_assignment" ADD CONSTRAINT "service_area_assignment_service_provider_id_fk" FOREIGN KEY ("company_id","service_provider_id") REFERENCES "wms"."service_provider"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."service_area_planning_area" ADD CONSTRAINT "service_area_planning_area_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."service_area_planning_area" ADD CONSTRAINT "service_area_planning_area_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."service_area_planning_area" ADD CONSTRAINT "service_area_planning_area_service_area_id_fk" FOREIGN KEY ("company_id","project_id","service_area_id") REFERENCES "wms"."service_area"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."service_area_planning_area" ADD CONSTRAINT "service_area_planning_area_planning_area_id_fk" FOREIGN KEY ("company_id","project_id","planning_area_id") REFERENCES "wms"."planning_area"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."service_area_waste_fraction" ADD CONSTRAINT "service_area_waste_fraction_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."service_area_waste_fraction" ADD CONSTRAINT "service_area_waste_fraction_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."service_area_waste_fraction" ADD CONSTRAINT "service_area_waste_fraction_service_area_id_fk" FOREIGN KEY ("company_id","project_id","service_area_id") REFERENCES "wms"."service_area"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."service_area_waste_fraction" ADD CONSTRAINT "service_area_waste_fraction_waste_fraction_id_fk" FOREIGN KEY ("company_id","waste_fraction_id") REFERENCES "wms"."waste_fraction"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."service_provider_price" ADD CONSTRAINT "service_provider_price_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."service_provider_price" ADD CONSTRAINT "service_provider_price_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."service_provider_price" ADD CONSTRAINT "service_provider_price_service_area_assignment_id_fk" FOREIGN KEY ("company_id","project_id","service_area_assignment_id") REFERENCES "wms"."service_area_assignment"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."service_provider_price" ADD CONSTRAINT "service_provider_price_product_id_fk" FOREIGN KEY ("company_id","project_id","product_id") REFERENCES "wms"."product"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."service_provider_price" ADD CONSTRAINT "service_provider_price_indexed_from_id_fk" FOREIGN KEY ("company_id","project_id","indexed_from_id") REFERENCES "wms"."service_provider_price"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."settlement" ADD CONSTRAINT "settlement_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."settlement" ADD CONSTRAINT "settlement_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."settlement" ADD CONSTRAINT "settlement_service_area_assignment_id_fk" FOREIGN KEY ("company_id","project_id","service_area_assignment_id") REFERENCES "wms"."service_area_assignment"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."settlement" ADD CONSTRAINT "settlement_closed_by_fk" FOREIGN KEY ("company_id","closed_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."settlement_event" ADD CONSTRAINT "settlement_event_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."settlement_event" ADD CONSTRAINT "settlement_event_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."settlement_event" ADD CONSTRAINT "settlement_event_settlement_id_fk" FOREIGN KEY ("company_id","project_id","settlement_id") REFERENCES "wms"."settlement"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."settlement_event" ADD CONSTRAINT "settlement_event_recorded_by_fk" FOREIGN KEY ("company_id","recorded_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."settlement_line" ADD CONSTRAINT "settlement_line_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."settlement_line" ADD CONSTRAINT "settlement_line_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."settlement_line" ADD CONSTRAINT "settlement_line_settlement_id_fk" FOREIGN KEY ("company_id","project_id","settlement_id") REFERENCES "wms"."settlement"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."settlement_line" ADD CONSTRAINT "settlement_line_billable_event_id_fk" FOREIGN KEY ("company_id","project_id","billable_event_id") REFERENCES "wms"."billable_event"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."settlement_line" ADD CONSTRAINT "settlement_line_service_provider_price_id_fk" FOREIGN KEY ("company_id","project_id","service_provider_price_id") REFERENCES "wms"."service_provider_price"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."weight_review" ADD CONSTRAINT "weight_review_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."weight_review" ADD CONSTRAINT "weight_review_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Moved up from where drizzle-kit wrote it, below the foreign keys and the indexes:
-- weight_review_unload_id_fk and weight_review_correction_unload_id_fk point at
-- this key, and Postgres needs the key before the reference (the 0007
-- precedent, container_service_placement_container_id_project_key). The
-- statements are drizzle-kit's, in the one order that applies; the rendering
-- test compares the head as a set.
ALTER TABLE "wms"."unload" ADD CONSTRAINT "unload_project_key" UNIQUE("company_id","project_id","id");--> statement-breakpoint
ALTER TABLE "wms"."weight_review" ADD CONSTRAINT "weight_review_unload_id_fk" FOREIGN KEY ("company_id","project_id","unload_id") REFERENCES "wms"."unload"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."weight_review" ADD CONSTRAINT "weight_review_correction_unload_id_fk" FOREIGN KEY ("company_id","project_id","correction_unload_id") REFERENCES "wms"."unload"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."weight_review" ADD CONSTRAINT "weight_review_reviewed_by_fk" FOREIGN KEY ("company_id","reviewed_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billable_event_source_event_id_idx" ON "wms"."billable_event" USING btree ("company_id","source_event_id") WHERE "wms"."billable_event"."source_event_id" is not null;--> statement-breakpoint
CREATE INDEX "billable_event_project_id_service_date_idx" ON "wms"."billable_event" USING btree ("company_id","project_id","service_date");--> statement-breakpoint
CREATE INDEX "billable_event_agreement_id_idx" ON "wms"."billable_event" USING btree ("company_id","agreement_id");--> statement-breakpoint
CREATE INDEX "billable_event_subscription_id_idx" ON "wms"."billable_event" USING btree ("company_id","subscription_id");--> statement-breakpoint
CREATE INDEX "billable_event_product_id_idx" ON "wms"."billable_event" USING btree ("company_id","product_id");--> statement-breakpoint
CREATE INDEX "billable_event_route_id_idx" ON "wms"."billable_event" USING btree ("company_id","route_id");--> statement-breakpoint
CREATE INDEX "billable_event_pickup_id_idx" ON "wms"."billable_event" USING btree ("company_id","pickup_id");--> statement-breakpoint
CREATE INDEX "billable_event_ticket_id_idx" ON "wms"."billable_event" USING btree ("company_id","ticket_id");--> statement-breakpoint
CREATE INDEX "billable_event_price_list_row_id_idx" ON "wms"."billable_event" USING btree ("company_id","price_list_row_id");--> statement-breakpoint
CREATE INDEX "billable_event_reverses_event_id_idx" ON "wms"."billable_event" USING btree ("company_id","reverses_event_id");--> statement-breakpoint
CREATE INDEX "billable_event_created_by_idx" ON "wms"."billable_event" USING btree ("company_id","created_by");--> statement-breakpoint
CREATE INDEX "billable_event_cancelled_by_idx" ON "wms"."billable_event" USING btree ("company_id","cancelled_by");--> statement-breakpoint
CREATE INDEX "billing_run_project_id_period_from_idx" ON "wms"."billing_run" USING btree ("company_id","project_id","period_from");--> statement-breakpoint
CREATE INDEX "billing_run_requested_by_idx" ON "wms"."billing_run" USING btree ("company_id","requested_by");--> statement-breakpoint
CREATE INDEX "billing_run_exclusion_customer_id_idx" ON "wms"."billing_run_exclusion" USING btree ("company_id","customer_id");--> statement-breakpoint
CREATE INDEX "billing_run_exclusion_project_id_idx" ON "wms"."billing_run_exclusion" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "invoice_customer_id_idx" ON "wms"."invoice" USING btree ("company_id","customer_id");--> statement-breakpoint
CREATE INDEX "invoice_billing_run_id_idx" ON "wms"."invoice" USING btree ("company_id","billing_run_id");--> statement-breakpoint
CREATE INDEX "invoice_credits_invoice_id_idx" ON "wms"."invoice" USING btree ("company_id","credits_invoice_id");--> statement-breakpoint
CREATE INDEX "invoice_project_id_issued_on_idx" ON "wms"."invoice" USING btree ("company_id","project_id","issued_on");--> statement-breakpoint
CREATE INDEX "invoice_issued_by_idx" ON "wms"."invoice" USING btree ("company_id","issued_by");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_line_billable_event_id_idx" ON "wms"."invoice_line" USING btree ("company_id","billable_event_id") WHERE "wms"."invoice_line"."billable_event_id" is not null;--> statement-breakpoint
CREATE INDEX "invoice_line_credits_line_id_idx" ON "wms"."invoice_line" USING btree ("company_id","credits_line_id");--> statement-breakpoint
CREATE INDEX "invoice_line_product_id_idx" ON "wms"."invoice_line" USING btree ("company_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "price_list_default_idx" ON "wms"."price_list" USING btree ("company_id","project_id") WHERE "wms"."price_list"."is_default";--> statement-breakpoint
CREATE INDEX "price_list_project_id_name_idx" ON "wms"."price_list" USING btree ("company_id","project_id","name");--> statement-breakpoint
CREATE INDEX "price_list_row_price_list_id_product_id_idx" ON "wms"."price_list_row" USING btree ("company_id","price_list_id","product_id");--> statement-breakpoint
CREATE INDEX "price_list_row_product_id_idx" ON "wms"."price_list_row" USING btree ("company_id","product_id");--> statement-breakpoint
CREATE INDEX "price_list_row_planning_area_id_idx" ON "wms"."price_list_row" USING btree ("company_id","planning_area_id");--> statement-breakpoint
CREATE INDEX "price_list_row_container_type_id_idx" ON "wms"."price_list_row" USING btree ("company_id","container_type_id");--> statement-breakpoint
CREATE INDEX "price_list_row_waste_fraction_id_idx" ON "wms"."price_list_row" USING btree ("company_id","waste_fraction_id");--> statement-breakpoint
CREATE INDEX "price_list_row_customer_id_idx" ON "wms"."price_list_row" USING btree ("company_id","customer_id");--> statement-breakpoint
CREATE INDEX "service_area_project_id_name_idx" ON "wms"."service_area" USING btree ("company_id","project_id","name");--> statement-breakpoint
CREATE INDEX "service_area_assignment_service_provider_id_idx" ON "wms"."service_area_assignment" USING btree ("company_id","service_provider_id");--> statement-breakpoint
CREATE INDEX "service_area_planning_area_project_id_idx" ON "wms"."service_area_planning_area" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "service_area_planning_area_planning_area_id_idx" ON "wms"."service_area_planning_area" USING btree ("company_id","planning_area_id");--> statement-breakpoint
CREATE INDEX "service_area_waste_fraction_project_id_idx" ON "wms"."service_area_waste_fraction" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "service_area_waste_fraction_waste_fraction_id_idx" ON "wms"."service_area_waste_fraction" USING btree ("company_id","waste_fraction_id");--> statement-breakpoint
CREATE INDEX "service_provider_price_assignment_product_idx" ON "wms"."service_provider_price" USING btree ("company_id","service_area_assignment_id","product_id");--> statement-breakpoint
CREATE INDEX "service_provider_price_product_id_idx" ON "wms"."service_provider_price" USING btree ("company_id","product_id");--> statement-breakpoint
CREATE INDEX "service_provider_price_indexed_from_id_idx" ON "wms"."service_provider_price" USING btree ("company_id","indexed_from_id");--> statement-breakpoint
CREATE INDEX "settlement_service_area_assignment_id_idx" ON "wms"."settlement" USING btree ("company_id","service_area_assignment_id");--> statement-breakpoint
CREATE INDEX "settlement_project_id_status_idx" ON "wms"."settlement" USING btree ("company_id","project_id","status");--> statement-breakpoint
CREATE INDEX "settlement_closed_by_idx" ON "wms"."settlement" USING btree ("company_id","closed_by");--> statement-breakpoint
CREATE INDEX "settlement_event_settlement_id_idx" ON "wms"."settlement_event" USING btree ("company_id","settlement_id","id");--> statement-breakpoint
CREATE INDEX "settlement_event_project_id_idx" ON "wms"."settlement_event" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "settlement_event_recorded_by_idx" ON "wms"."settlement_event" USING btree ("company_id","recorded_by");--> statement-breakpoint
CREATE INDEX "settlement_line_billable_event_id_idx" ON "wms"."settlement_line" USING btree ("company_id","billable_event_id");--> statement-breakpoint
CREATE INDEX "settlement_line_service_provider_price_id_idx" ON "wms"."settlement_line" USING btree ("company_id","service_provider_price_id");--> statement-breakpoint
CREATE INDEX "settlement_line_project_id_idx" ON "wms"."settlement_line" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "weight_review_unload_id_idx" ON "wms"."weight_review" USING btree ("company_id","unload_id","id");--> statement-breakpoint
CREATE INDEX "weight_review_correction_unload_id_idx" ON "wms"."weight_review" USING btree ("company_id","correction_unload_id");--> statement-breakpoint
CREATE INDEX "weight_review_reviewed_by_idx" ON "wms"."weight_review" USING btree ("company_id","reviewed_by");--> statement-breakpoint
CREATE INDEX "weight_review_project_id_idx" ON "wms"."weight_review" USING btree ("company_id","project_id");--> statement-breakpoint
ALTER TABLE "wms"."agreement" ADD CONSTRAINT "agreement_price_list_id_fk" FOREIGN KEY ("company_id","project_id","price_list_id") REFERENCES "wms"."price_list"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_invoice_code_idx" ON "wms"."product" USING btree ("company_id","project_id","invoice_code") WHERE "wms"."product"."invoice_code" is not null;--> statement-breakpoint
CREATE INDEX "agreement_price_list_id_idx" ON "wms"."agreement" USING btree ("company_id","price_list_id");--> statement-breakpoint
ALTER TABLE "wms"."product" ADD CONSTRAINT "product_vat_percent_range" CHECK ("wms"."product"."vat_percent" between 0 and 100);--> statement-breakpoint
ALTER TABLE "wms"."outbox_event" ADD CONSTRAINT "outbox_event_kind_one_of" CHECK ("wms"."outbox_event"."kind" in ('route-dispatched', 'route-started', 'route-completed', 'route-cancelled', 'route-reassigned', 'pickup-completed', 'pickup-failed', 'pickup-skipped', 'pickup-problem-reported', 'pickup-corrected', 'unload-recorded', 'command-rejected', 'ticket-opened', 'ticket-completed', 'ticket-rejected', 'invoice-issued', 'settlement-closed'));--> statement-breakpoint
ALTER TABLE "wms"."outbox_event" ADD CONSTRAINT "outbox_event_aggregate_kind_one_of" CHECK ("wms"."outbox_event"."aggregate_kind" in ('route', 'pickup', 'unload', 'command', 'ticket', 'invoice', 'settlement'));
--> statement-breakpoint
-- Hand-written from here on (migrations/README.md): the fence of each of the
-- sixteen tables, then its updated_at trigger — or, for the five ledgers,
-- billing_run_exclusion, invoice, invoice_line, settlement_event and
-- weight_review, the REVOKE of UPDATE and DELETE from the API role — and
-- then the six exclusion constraints of the effective-dated tables, copied
-- verbatim from the helpers in src/sql/, which the gate in
-- src/__tests__/hand-written.test.ts holds the file to (Issue #112).
ALTER TABLE "wms"."price_list" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "price_list_tenant_fence" ON "wms"."price_list" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "price_list_touch_updated_at" BEFORE UPDATE ON "wms"."price_list" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."price_list_row" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "price_list_row_tenant_fence" ON "wms"."price_list_row" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "price_list_row_touch_updated_at" BEFORE UPDATE ON "wms"."price_list_row" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."service_area" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "service_area_tenant_fence" ON "wms"."service_area" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "service_area_touch_updated_at" BEFORE UPDATE ON "wms"."service_area" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."service_area_planning_area" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "service_area_planning_area_tenant_fence" ON "wms"."service_area_planning_area" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "service_area_planning_area_touch_updated_at" BEFORE UPDATE ON "wms"."service_area_planning_area" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."service_area_waste_fraction" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "service_area_waste_fraction_tenant_fence" ON "wms"."service_area_waste_fraction" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "service_area_waste_fraction_touch_updated_at" BEFORE UPDATE ON "wms"."service_area_waste_fraction" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."service_area_assignment" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "service_area_assignment_tenant_fence" ON "wms"."service_area_assignment" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "service_area_assignment_touch_updated_at" BEFORE UPDATE ON "wms"."service_area_assignment" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."service_provider_price" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "service_provider_price_tenant_fence" ON "wms"."service_provider_price" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "service_provider_price_touch_updated_at" BEFORE UPDATE ON "wms"."service_provider_price" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "billable_event_tenant_fence" ON "wms"."billable_event" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "billable_event_touch_updated_at" BEFORE UPDATE ON "wms"."billable_event" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."billing_run" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "billing_run_tenant_fence" ON "wms"."billing_run" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "billing_run_touch_updated_at" BEFORE UPDATE ON "wms"."billing_run" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."billing_run_exclusion" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "billing_run_exclusion_tenant_fence" ON "wms"."billing_run_exclusion" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "wms"."billing_run_exclusion" FROM wms_api;
--> statement-breakpoint
ALTER TABLE "wms"."invoice" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "invoice_tenant_fence" ON "wms"."invoice" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "wms"."invoice" FROM wms_api;
--> statement-breakpoint
ALTER TABLE "wms"."invoice_line" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "invoice_line_tenant_fence" ON "wms"."invoice_line" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "wms"."invoice_line" FROM wms_api;
--> statement-breakpoint
ALTER TABLE "wms"."settlement" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "settlement_tenant_fence" ON "wms"."settlement" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "settlement_touch_updated_at" BEFORE UPDATE ON "wms"."settlement" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."settlement_line" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "settlement_line_tenant_fence" ON "wms"."settlement_line" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "settlement_line_touch_updated_at" BEFORE UPDATE ON "wms"."settlement_line" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."settlement_event" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "settlement_event_tenant_fence" ON "wms"."settlement_event" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "wms"."settlement_event" FROM wms_api;
--> statement-breakpoint
ALTER TABLE "wms"."weight_review" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "weight_review_tenant_fence" ON "wms"."weight_review" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "wms"."weight_review" FROM wms_api;
--> statement-breakpoint
ALTER TABLE "wms"."price_list" ADD CONSTRAINT "price_list_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "project_id" WITH =, "code" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);
--> statement-breakpoint
ALTER TABLE "wms"."price_list_row" ADD CONSTRAINT "price_list_row_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "price_list_id" WITH =, "product_id" WITH =, "condition_key" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);
--> statement-breakpoint
ALTER TABLE "wms"."service_area" ADD CONSTRAINT "service_area_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "project_id" WITH =, "code" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);
--> statement-breakpoint
ALTER TABLE "wms"."service_area_assignment" ADD CONSTRAINT "service_area_assignment_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "service_area_id" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);
--> statement-breakpoint
ALTER TABLE "wms"."service_provider_price" ADD CONSTRAINT "service_provider_price_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "service_area_assignment_id" WITH =, "product_id" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);
--> statement-breakpoint
ALTER TABLE "wms"."settlement" ADD CONSTRAINT "settlement_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "service_area_assignment_id" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);
