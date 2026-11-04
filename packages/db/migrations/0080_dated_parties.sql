-- A Property's parties dated (#374): parties written before this migration hold their role from the day each was written, on its project's clock.
-- drizzle-kit writes `valid_from` as one NOT NULL `ADD COLUMN`, which a database holding parties refuses, so it is added nullable, backfilled (src/sql/dated-parties.ts) and then required.
ALTER TABLE "wms"."property_party" DROP CONSTRAINT "property_party_property_id_customer_id_role_key";--> statement-breakpoint
ALTER TABLE "wms"."property_party" ADD COLUMN "valid_from" date;--> statement-breakpoint
UPDATE "wms"."property_party" AS pp SET "valid_from" = (pp."created_at" AT TIME ZONE p."timezone")::date FROM "wms"."project" AS p WHERE p."company_id" = pp."company_id" AND p."id" = pp."project_id";--> statement-breakpoint
ALTER TABLE "wms"."property_party" ALTER COLUMN "valid_from" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "wms"."property_party" ADD COLUMN "valid_to" date;--> statement-breakpoint
CREATE INDEX "property_party_property_id_idx" ON "wms"."property_party" USING btree ("company_id","property_id");--> statement-breakpoint
ALTER TABLE "wms"."property_party" ADD CONSTRAINT "property_party_validity" CHECK ("wms"."property_party"."valid_to" is null or "wms"."property_party"."valid_to" > "wms"."property_party"."valid_from");--> statement-breakpoint
ALTER TABLE "wms"."property_party" ADD CONSTRAINT "property_party_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "property_id" WITH =, "customer_id" WITH =, "role" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);
