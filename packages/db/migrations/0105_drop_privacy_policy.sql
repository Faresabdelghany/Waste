-- Privacy, audit & retention removed (#487, #291 C19): a project's privacy
-- policy goes, and with it the three columns 0077 gave `project` — the days
-- its drivers' positions and its stops' photos and signatures are kept, and
-- the purpose its positions are recorded for — and their three checks, as
-- drizzle-kit writes them. The removal is the owner's decision, so the
-- columns are dropped bare, without the guard migrations/README.md asks of a
-- dropped column: a policy is carried nowhere, and the worker's nightly
-- purges keep each kind for the deployment's days alone
-- (`POSITION_RETENTION_DAYS`, `PROOF_RETENTION_DAYS`). The access module
-- `configure.privacy` leaves the vocabulary with it, so below drizzle-kit's
-- statements, hand-written and run by the owner, every role's grant on it is
-- deleted, which the audit trail records under its role. The file is found by
-- its name, not its number, which it takes at its turn.
ALTER TABLE "wms"."project" DROP CONSTRAINT "project_position_retention_range";--> statement-breakpoint
ALTER TABLE "wms"."project" DROP CONSTRAINT "project_proof_retention_range";--> statement-breakpoint
ALTER TABLE "wms"."project" DROP CONSTRAINT "project_gps_purpose_one_of";--> statement-breakpoint
ALTER TABLE "wms"."project" DROP COLUMN "position_retention_days";--> statement-breakpoint
ALTER TABLE "wms"."project" DROP COLUMN "proof_retention_days";--> statement-breakpoint
ALTER TABLE "wms"."project" DROP COLUMN "gps_purpose";
--> statement-breakpoint
DELETE FROM "wms"."role_grant" WHERE "module_key" = 'configure.privacy';
