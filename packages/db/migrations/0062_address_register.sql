-- The address register (#291 C13, #290 O29): a property found in the national
-- address register, DAR, keeps the register's id for its address and the parts
-- the register holds beside it — the street and house number, a unit's floor
-- and door, the postcode and its town, the municipality's code — all present
-- with the id or none, and a postcode and a municipality code four digits.
-- Every column is nullable and every check passes a row that has none, so the
-- rows present, all typed, pass; no table is new, so nothing is hand-written.
ALTER TABLE "wms"."property" ADD COLUMN "address_id" uuid;--> statement-breakpoint
ALTER TABLE "wms"."property" ADD COLUMN "street_name" text;--> statement-breakpoint
ALTER TABLE "wms"."property" ADD COLUMN "house_number" text;--> statement-breakpoint
ALTER TABLE "wms"."property" ADD COLUMN "floor" text;--> statement-breakpoint
ALTER TABLE "wms"."property" ADD COLUMN "door" text;--> statement-breakpoint
ALTER TABLE "wms"."property" ADD COLUMN "postcode" text;--> statement-breakpoint
ALTER TABLE "wms"."property" ADD COLUMN "post_town" text;--> statement-breakpoint
ALTER TABLE "wms"."property" ADD COLUMN "municipality_code" text;--> statement-breakpoint
ALTER TABLE "wms"."property" ADD CONSTRAINT "property_address_shape" CHECK (("wms"."property"."address_id" is null) = ("wms"."property"."street_name" is null) and ("wms"."property"."address_id" is null) = ("wms"."property"."house_number" is null) and ("wms"."property"."address_id" is null) = ("wms"."property"."postcode" is null) and ("wms"."property"."address_id" is null) = ("wms"."property"."post_town" is null) and ("wms"."property"."address_id" is null) = ("wms"."property"."municipality_code" is null) and ("wms"."property"."address_id" is not null or ("wms"."property"."floor" is null and "wms"."property"."door" is null)));--> statement-breakpoint
ALTER TABLE "wms"."property" ADD CONSTRAINT "property_postcode_shape" CHECK ("wms"."property"."postcode" ~ '^[0-9]{4}$');--> statement-breakpoint
ALTER TABLE "wms"."property" ADD CONSTRAINT "property_municipality_code_shape" CHECK ("wms"."property"."municipality_code" ~ '^[0-9]{4}$');