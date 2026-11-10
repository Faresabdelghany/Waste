// A route's and a stop's statuses and the reasons a stop is missed, as a
// person reads them: the one labels module the office's pages and the Driver
// App's screens both read.
import type { DriverPickupReason, PickupStatus, RouteStatus } from "@waste/domain/execution/vocabulary"

import { statusLabel } from "@/lib/records/fields"

export const ROUTE_STATUS_LABELS: Readonly<Record<RouteStatus, string>> = {
  planned: "Planned",
  ready: "Ready",
  active: "Active",
  completed: "Completed",
  cancelled: "Cancelled",
}

export const PICKUP_STATUS_LABELS: Readonly<Record<PickupStatus, string>> = {
  planned: "To do",
  completed: "Completed",
  skipped: "Skipped",
  failed: "Failed",
}

export const DRIVER_REASON_LABELS: Readonly<Record<DriverPickupReason, string>> = {
  inaccessible: "Inaccessible",
  contamination: "Contamination",
  "not-presented": "Not presented",
  capacity: "Over capacity",
  safety: "Safety",
  other: "Other",
}

/** A stop's reason in the Driver App's words ("Over capacity" for `capacity`); the system's four as any token is spelled. */
export const pickupReasonLabel = (reason: string) => (DRIVER_REASON_LABELS as Readonly<Record<string, string>>)[reason] ?? statusLabel(reason)
