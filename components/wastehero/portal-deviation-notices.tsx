"use client"

// Customer-facing view of customer-scoped Collection Deviations
// (PLAN_SIMPLIFICATION Q8 follow-up 1, issue #10): a banner on the citizen
// portal listing this customer's approved pickup-date changes. Route
// generation ignores customer scope — these are promise-level notices only.
// Copy stays customer-plain: no operator workflow state ("Notification
// pending"), and customer-level language (a customer can span properties).

import { CalendarClock } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { useModuleRecords } from "@/components/wastehero/scheme-route-map"
import { customerDeviationNotices } from "@/lib/route-schemes/customer-deviations"
import { formatServiceDate } from "@/lib/route-schemes/recurrence"

type PortalDeviationNoticesProps = {
  /** The customers.contacts record the signed-in portal identity represents. */
  customerId: string
}

export function PortalDeviationNotices({
  customerId,
}: PortalDeviationNoticesProps) {
  const deviationRecords = useModuleRecords("plan", "collection-deviations")
  const notices = customerDeviationNotices(deviationRecords, customerId)
  if (notices.length === 0) return null

  return (
    <section
      aria-label="Collection date changes"
      className="border-b border-amber-200/70 bg-amber-50 px-4 py-3 dark:border-amber-500/20 dark:bg-amber-500/10 sm:px-6"
    >
      <div className="flex items-center gap-2 text-sm font-medium text-amber-900 dark:text-amber-100">
        <CalendarClock className="size-4 shrink-0" aria-hidden />
        Changes to your upcoming collections
      </div>
      <ul className="mt-2 space-y-2">
        {notices.map((notice) => (
          <li
            key={notice.recordId}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-amber-900/90 dark:text-amber-100/90"
          >
            <span className="font-medium">{notice.name}</span>
            <span>
              <s>{formatServiceDate(notice.originalDate)}</s>
              {" → "}
              {formatServiceDate(notice.replacementDate)}
            </span>
            <span className="text-amber-800/80 dark:text-amber-200/80">
              {notice.reason}
            </span>
            {notice.notified ? null : <Badge variant="outline">New</Badge>}
          </li>
        ))}
      </ul>
    </section>
  )
}
