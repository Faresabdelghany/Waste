-- #291 slice 5, #292 C5a: the parties an invoice document prints, frozen on
-- the invoice at issue (src/sql/invoice-parties.ts), and the company's postal
-- address, the seller's address a Danish invoice must print.
--
-- Invoices issued before this migration take today's parties: the backfill
-- below gives each one the company and the payer as they stand when it runs,
-- the best the ledger knows of them, since nothing recorded them at issue.
-- The column is added nullable, backfilled, then made NOT NULL, so a
-- database holding invoices takes it; drizzle-kit's single NOT NULL ADD
-- COLUMN is split in three here, which invoice-parties-rendering.test.ts pins.
ALTER TABLE "wms"."company" ADD COLUMN "postal_address" text;--> statement-breakpoint
ALTER TABLE "wms"."invoice" ADD COLUMN "parties" jsonb;--> statement-breakpoint
UPDATE "wms"."invoice" AS i SET "parties" = jsonb_build_object('seller', jsonb_build_object('legalName', c."legal_name", 'registrationNumber', c."registration_number", 'vatNumber', c."vat_number", 'postalAddress', c."postal_address", 'bankIban', c."bank_iban", 'bankBic', c."bank_bic", 'fikCreditorNumber', c."fik_creditor_number"), 'buyer', jsonb_build_object('name', cu."name", 'registrationNumber', cu."registration_number", 'billingAddress', cu."billing_address")) FROM "wms"."company" AS c, "wms"."customer" AS cu WHERE c."id" = i."company_id" AND cu."company_id" = i."company_id" AND cu."id" = i."customer_id";--> statement-breakpoint
ALTER TABLE "wms"."invoice" ALTER COLUMN "parties" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "wms"."invoice" ADD CONSTRAINT "invoice_parties_shape" CHECK (jsonb_typeof("wms"."invoice"."parties" -> 'seller') is not distinct from 'object' and jsonb_typeof("wms"."invoice"."parties" -> 'buyer') is not distinct from 'object');
