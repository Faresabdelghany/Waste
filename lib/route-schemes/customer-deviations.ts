// Customer-scoped Collection Deviations (PLAN_SIMPLIFICATION Q8 follow-up 1,
// issue #10): a customer-scoped deviation is a promise-level date change for
// one customer — it moves that customer's promised pickup dates without
// remapping whole-route generation (deviationMatchesScheme keeps returning
// false for customer scope). This module derives the portal/notification view
// of those records. Pure data logic, harness-tested in
// scripts/customer-deviation-harness.ts.

import type { BusinessRecord } from "../data/business-modules"
import { APPROVED_DEVIATION_STATUSES, parseDeviationDate } from "./generation"
import { stringValue } from "./validation"

export type CustomerDeviationNotice = {
  /** The deviation record backing this notice. */
  recordId: string
  name: string
  /** ISO date of the original service promise. */
  originalDate: string
  /** ISO date the pickup actually happens for this customer. */
  replacementDate: string
  reason: string
  /** True once the customer notification went out (record status Notified). */
  notified: boolean
}

/**
 * The customer-facing promise changes for one customer: deviation records
 * with `scopeType: "customer"` whose `customerId` matches, in an actionable
 * status (Approved/Notified, same set generation honors — Drafts are not yet
 * promises; Executed/Cancelled no longer change an upcoming date), sorted by
 * original date. Dates are read the same way generation reads them (ISO
 * submittedValues first, "24 Dec 2026" facts as fallback).
 */
export function customerDeviationNotices(
  records: readonly BusinessRecord[],
  customerId: string,
): CustomerDeviationNotice[] {
  if (!customerId) return []
  const notices: CustomerDeviationNotice[] = []
  for (const record of records) {
    if (!APPROVED_DEVIATION_STATUSES.has(record.status)) continue
    const values = record.submittedValues ?? {}
    if (stringValue(values, "scopeType") !== "customer") continue
    if (stringValue(values, "customerId") !== customerId) continue
    const originalDate =
      parseDeviationDate(stringValue(values, "originalDate")) ??
      parseDeviationDate(record.facts?.["Original date"])
    const replacementDate =
      parseDeviationDate(stringValue(values, "replacementDate")) ??
      parseDeviationDate(record.facts?.["Replacement date"])
    if (!originalDate || !replacementDate) continue
    notices.push({
      recordId: record.id,
      name: record.name,
      originalDate,
      replacementDate,
      // submittedValues first, like the dates — edits update submittedValues
      // while the fixture "Reason" fact survives the generic facts merge.
      reason:
        stringValue(values, "deviationReason") ??
        record.facts?.Reason ??
        "Approved deviation",
      notified: record.status === "Notified",
    })
  }
  return notices.sort((a, b) => a.originalDate.localeCompare(b.originalDate))
}
