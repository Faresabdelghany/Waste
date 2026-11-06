-- The emission factors removed (M10 and M13 of #293 withdrawn by the owner, 2026-11-05): the fuels' factors, a vehicle type's consumption by fuel and the waste fractions' factors, the three tables the fleet-emissions and the sustainability reports read, dropped with their rows, which the owner decided to let go.
-- A DROP TABLE takes the table's fence, its triggers (the `updated_at` one and the audit trail's), the factors' exclusion constraints, its keys and its indexes with it; nothing else names the three tables — no key points at them, and no grant, publication or function of another file reads them — so the file is drizzle-kit's statements alone. The audit log keeps the rows' history, under their tables' names. A waste fraction's treatment stays the fraction's.
DROP TABLE "wms"."fuel_emission_factor" CASCADE;--> statement-breakpoint
DROP TABLE "wms"."vehicle_type_consumption" CASCADE;--> statement-breakpoint
DROP TABLE "wms"."waste_fraction_emission_factor" CASCADE;
