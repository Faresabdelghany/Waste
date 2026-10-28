-- The stale-position rule (O8 of #290, decided on #344): an alert's rule
-- grows by `position-stale`, a running session heard from but sending no
-- position for ten minutes. No table is new, so nothing is hand-written, and
-- no alert present names the new rule.
ALTER TABLE "wms"."alert" DROP CONSTRAINT "alert_rule_one_of";--> statement-breakpoint
ALTER TABLE "wms"."alert" ADD CONSTRAINT "alert_rule_one_of" CHECK ("wms"."alert"."rule" in ('route-not-started', 'session-silent', 'licence-expiring', 'ticket-overdue', 'position-stale'));