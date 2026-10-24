-- A waste fraction's waste code (#291 slice 29, C29): the entry of the
-- European List of Waste the national waste-data system keys a fraction by,
-- six digits with an asterisk after a hazardous entry's, held to
-- @waste/domain/registry/waste-code's shape. Nullable and added bare: a
-- fraction is collected before anyone files it, every row already present
-- has none and passes the check, and the waste-data report names a fraction
-- without one with a warning. The table's fence, trigger and audit trail
-- stand as 0004 and 0019 wrote them; a column needs no statement of its own.
ALTER TABLE "wms"."waste_fraction" ADD COLUMN "waste_code" text;--> statement-breakpoint
ALTER TABLE "wms"."waste_fraction" ADD CONSTRAINT "waste_fraction_waste_code_shape" CHECK ("wms"."waste_fraction"."waste_code" ~ '^(0[1-9]|1[0-9]|20)[0-9]{4}\*?$');