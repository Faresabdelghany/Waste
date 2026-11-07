-- The company's scale-ticket counter ignored by its audit trail: 0019 gave the
-- company's trigger the three document counters it then had, and the scale
-- house's (0089) was never added, so every scale ticket numbered wrote a row
-- of history on the company. The trigger is replaced with every counter the
-- company declares (`COMPANY_COUNTERS`, src/schema/organisation.ts), as
-- `replaceAuditTrail` spells it (src/sql/audit-trail.ts). Hand-written whole;
-- the rows already written stay in the log as they were recorded.
DROP TRIGGER "company_audit_trail" ON "wms"."company";
--> statement-breakpoint
CREATE TRIGGER "company_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."company" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '', 'next_route_number', 'next_ticket_number', 'next_invoice_number', 'next_scale_ticket_number');
