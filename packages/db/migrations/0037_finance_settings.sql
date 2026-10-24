ALTER TABLE "wms"."company" ADD COLUMN "vat_number" text;--> statement-breakpoint
ALTER TABLE "wms"."company" ADD COLUMN "bank_iban" text;--> statement-breakpoint
ALTER TABLE "wms"."company" ADD COLUMN "bank_bic" text;--> statement-breakpoint
ALTER TABLE "wms"."company" ADD COLUMN "fik_creditor_number" text;--> statement-breakpoint
ALTER TABLE "wms"."project" ADD COLUMN "payment_terms_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "wms"."project" ADD COLUMN "payment_reference_scheme" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "wms"."customer" ADD COLUMN "payment_terms_days" integer;--> statement-breakpoint
ALTER TABLE "wms"."invoice" ADD COLUMN "payment_reference" text;--> statement-breakpoint
ALTER TABLE "wms"."company" ADD CONSTRAINT "company_vat_number_shape" CHECK ("wms"."company"."vat_number" ~ '^[A-Z]{2}[0-9A-Z]{2,13}$');--> statement-breakpoint
ALTER TABLE "wms"."company" ADD CONSTRAINT "company_bank_iban_shape" CHECK ("wms"."company"."bank_iban" ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$');--> statement-breakpoint
ALTER TABLE "wms"."company" ADD CONSTRAINT "company_bank_bic_shape" CHECK ("wms"."company"."bank_bic" ~ '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$');--> statement-breakpoint
ALTER TABLE "wms"."company" ADD CONSTRAINT "company_fik_creditor_number_shape" CHECK ("wms"."company"."fik_creditor_number" ~ '^[0-9]{8}$');--> statement-breakpoint
ALTER TABLE "wms"."project" ADD CONSTRAINT "project_payment_reference_scheme_one_of" CHECK ("wms"."project"."payment_reference_scheme" in ('none', 'fik-71', 'fik-75'));--> statement-breakpoint
ALTER TABLE "wms"."project" ADD CONSTRAINT "project_payment_terms_range" CHECK ("wms"."project"."payment_terms_days" between 0 and 365);--> statement-breakpoint
ALTER TABLE "wms"."customer" ADD CONSTRAINT "customer_payment_terms_range" CHECK ("wms"."customer"."payment_terms_days" between 0 and 365);--> statement-breakpoint
ALTER TABLE "wms"."invoice" ADD CONSTRAINT "invoice_payment_reference_shape" CHECK ("wms"."invoice"."payment_reference" is null or ("wms"."invoice"."kind" = 'invoice' and "wms"."invoice"."payment_reference" ~ '^[0-9]{15,16}$'));