// The Price Engine's lists on the Pilot (Issue #185, #148): the categories
// each module's toolbar filters by, read off the facts its adapter writes
// (lib/api/records/pricing.ts, billing.ts), and what it opens on. The price
// rows' table lists the rows alone, never the lists they are filed under,
// which are the same module's first kind; the billable events open on the
// two a person acts on, blocked and ready. An invoice is filtered by what its
// payments make of it too, and the payments by where they stand and who paid
// them (#291 C6).
import { singleFilterValue } from "@waste/domain/business-filters"

import type { BusinessRecord } from "@/lib/data/business-modules"
import { isPriceRowRecord } from "@/lib/data/commercial"

import type { ModuleList } from "./command-surfaces"

const fact = (key: string) => (record: BusinessRecord) => singleFilterValue(record.facts[key])
const status = (record: BusinessRecord) => [record.status]

export const PRICE_ROWS_LIST: ModuleList = {
  shows: isPriceRowRecord,
  readers: () => ({ statuses: status, priceLists: fact("Price list"), products: fact("Product"), planningAreas: fact("Zone"), customers: fact("Negotiated customer") }),
  initial: {},
}

/**
 * Billable events open on what is still to be invoiced, the blocked to put
 * right and the ready to bill (#148). An event's customers are both its
 * agreement's parties, the customer served and the payer invoiced (#256), so
 * the filter finds what a payer is billed as the invoices' does.
 */
export const EVENTS_LIST: ModuleList = {
  readers: () => ({ statuses: status, kinds: fact("Kind"), blockReasons: fact("Block reason"), agreements: fact("Agreement"), customers: (record) => [...new Set([...fact("Customer")(record), ...fact("Payer")(record)])], products: fact("Product"), routes: fact("Route"), serviceDates: fact("Service date") }),
  initial: { statuses: ["Blocked", "Ready"] },
}

export const BILLING_LIST: ModuleList = {
  readers: () => ({ statuses: status }),
  initial: {},
}

export const INVOICES_LIST: ModuleList = {
  readers: () => ({ kinds: fact("Kind"), statuses: status, paymentStatuses: fact("Payment"), customers: fact("Customer"), billingRuns: fact("Billing run") }),
  initial: {},
}

export const PAYMENTS_LIST: ModuleList = {
  readers: () => ({ statuses: status, sources: fact("Source"), customers: fact("Payer") }),
  initial: {},
}
