-- A run goes payer by payer in batches (#329): a payer whose ready events
-- alone are more than one batch takes is refused alone, an exclusion of its
-- own reason, rather than split across invoices. drizzle-kit's statements
-- alone: the exclusion's reason check grows by `too-many-events`. No row
-- holds the new reason, so nothing is guarded and nothing is hand-written.
ALTER TABLE "wms"."billing_run_exclusion" DROP CONSTRAINT "billing_run_exclusion_reason_one_of";--> statement-breakpoint
ALTER TABLE "wms"."billing_run_exclusion" ADD CONSTRAINT "billing_run_exclusion_reason_one_of" CHECK ("wms"."billing_run_exclusion"."reason" in ('all-events-blocked', 'all-events-held', 'all-events-blocked-or-held', 'too-many-events'));