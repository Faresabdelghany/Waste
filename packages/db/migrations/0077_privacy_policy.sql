ALTER TABLE "wms"."project" ADD COLUMN "position_retention_days" integer;--> statement-breakpoint
ALTER TABLE "wms"."project" ADD COLUMN "proof_retention_days" integer;--> statement-breakpoint
ALTER TABLE "wms"."project" ADD COLUMN "gps_purpose" text;--> statement-breakpoint
ALTER TABLE "wms"."project" ADD CONSTRAINT "project_position_retention_range" CHECK ("wms"."project"."position_retention_days" between 1 and 30);--> statement-breakpoint
ALTER TABLE "wms"."project" ADD CONSTRAINT "project_proof_retention_range" CHECK ("wms"."project"."proof_retention_days" between 1 and 3650);--> statement-breakpoint
ALTER TABLE "wms"."project" ADD CONSTRAINT "project_gps_purpose_one_of" CHECK ("wms"."project"."gps_purpose" in ('dispatch', 'dispatch-and-proof'));