-- A waste fraction's hazardous flag (O18 of #290, row 1.16), what its
-- transfer note prints: `hazardous`, NOT NULL and false by default, and
-- `waste_fraction_hazardous_shape`, which holds a fraction under a starred
-- code of the European List of Waste — a hazardous entry — to hazardous
-- (@waste/domain/registry/waste-code's `hazardousAgrees`). A fraction filed
-- under a starred code before this migration is hazardous by its code, so the
-- backfill between drizzle-kit's two statements sets it before the check is
-- added. The table's fence, trigger and audit trail stand as they were; a
-- column needs no statement of its own. The file is found by its name, not
-- its number, which it takes at its turn.
ALTER TABLE "wms"."waste_fraction" ADD COLUMN "hazardous" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "wms"."waste_fraction" SET "hazardous" = true WHERE "waste_code" like '%*';--> statement-breakpoint
ALTER TABLE "wms"."waste_fraction" ADD CONSTRAINT "waste_fraction_hazardous_shape" CHECK ("wms"."waste_fraction"."hazardous" or "wms"."waste_fraction"."waste_code" is null or "wms"."waste_fraction"."waste_code" not like '%*');
