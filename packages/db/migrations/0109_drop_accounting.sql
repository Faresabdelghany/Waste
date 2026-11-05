-- The accounting export removed (#291 C7, C7a and C7w, with SAF-T, C7b),
-- with Settings › Commercial › Accounting. drizzle-kit's statements drop the
-- mapping's four tables — accounting_account, accounting_settings,
-- accounting_vat_code and accounting_product_account — and the export's
-- three ledgers — accounting_export, accounting_export_voucher and
-- accounting_export_line — and with them their keys, indexes, fences,
-- touches and audit triggers; no other table names them. Then the module
-- key the exports were granted under, `commercial.accounting`, leaves every
-- role, a system role's or a custom one: its grants are deleted. The audit
-- log keeps the history the mapping's triggers wrote. The file is found by
-- its name, not its number, which it takes at its turn.
DROP TABLE "wms"."accounting_account" CASCADE;--> statement-breakpoint
DROP TABLE "wms"."accounting_export" CASCADE;--> statement-breakpoint
DROP TABLE "wms"."accounting_export_line" CASCADE;--> statement-breakpoint
DROP TABLE "wms"."accounting_export_voucher" CASCADE;--> statement-breakpoint
DROP TABLE "wms"."accounting_product_account" CASCADE;--> statement-breakpoint
DROP TABLE "wms"."accounting_settings" CASCADE;--> statement-breakpoint
DROP TABLE "wms"."accounting_vat_code" CASCADE;--> statement-breakpoint
DELETE FROM "wms"."role_grant" WHERE "module_key" = 'commercial.accounting';
