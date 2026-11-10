import { billableEvent, billingRun, invoice } from "@waste/db/schema/finance"
import { eventsFrom } from "@waste/db/shapes/billable-events"
import { runColumns } from "@waste/db/shapes/billing-runs"
import { invoiceColumns } from "@waste/db/shapes/invoices"
import { scoped } from "../scoped"

export const {
  scope: eventScope,
  noSuch: noSuchEvent,
  get: getEvent,
  locked: lockedEvent,
  list: listEvents,
} = scoped(billableEvent, { noun: "billable event", reach: "projects", read: (tx, principal) => eventsFrom(tx, principal.companyId).query })

export const { find: findRun, get: getRun, list: listRuns } = scoped(billingRun, { noun: "billing run", reach: "projects", columns: runColumns })

export const { scope: invoiceScope, get: getInvoice, list: listInvoices } = scoped(invoice, { noun: "invoice", reach: "projects", columns: invoiceColumns })
