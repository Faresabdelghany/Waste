// Everything about a Customer, as one file (#291 C19, part 2, #381): the
// answer to a person's request to see what the company holds about them. It
// is put together from the API's own reads of each family, filtered by the
// customer (lib/api/customer-export.ts), so every row is the wire's shape and
// every read is fenced and granted as it is anywhere else. A family the
// person's role may not read is named as not included, with the API's
// sentence, never left out silently. Pure: the document and its file name.

/** The families the export reads, in the file's order. */
export const CUSTOMER_EXPORT_SECTIONS = [
  { key: "customer", title: "The customer" },
  { key: "history", title: "Its history" },
  { key: "contacts", title: "Contact persons" },
  { key: "messages", title: "Messages sent to it" },
  { key: "properties", title: "Properties it is a party to" },
  { key: "agreements", title: "Agreements and their subscriptions" },
  { key: "billableEvents", title: "Billable events" },
  { key: "invoices", title: "Invoices and credit notes" },
  { key: "payments", title: "Payments" },
  { key: "tickets", title: "Tickets and their messages" },
  { key: "accessCredentials", title: "Access credentials" },
  { key: "siteVisits", title: "Recycling-centre visits" },
  { key: "bulkyBookings", title: "Bulky-waste bookings" },
  { key: "applications", title: "Applications" },
] as const

export type CustomerExportSectionKey = (typeof CUSTOMER_EXPORT_SECTIONS)[number]["key"]

/** What one family's read came to: its rows, or why the person's role was not answered them. */
export type SectionOutcome = { included: true; data: unknown } | { included: false; reason: string }

export type CustomerExportDocument = {
  /** What this file is, for whoever opens it. */
  about: string
  customerId: string
  customerName: string
  exportedAt: string
  exportedBy: string
  /** Each family the person's role was answered, in the file's order. */
  sections: Partial<Record<CustomerExportSectionKey, unknown>>
  /** Each family it was not, and the API's reason. */
  notIncluded: { section: string; reason: string }[]
}

export function customerExportOf(input: {
  customerId: string
  customerName: string
  exportedAt: string
  exportedBy: string
  outcomes: Readonly<Record<CustomerExportSectionKey, SectionOutcome>>
}): CustomerExportDocument {
  const sections: Partial<Record<CustomerExportSectionKey, unknown>> = {}
  const notIncluded: { section: string; reason: string }[] = []
  for (const { key, title } of CUSTOMER_EXPORT_SECTIONS) {
    const outcome = input.outcomes[key]
    if (outcome.included) sections[key] = outcome.data
    else notIncluded.push({ section: title, reason: outcome.reason })
  }
  return {
    about: "Everything the company holds about this customer, as its systems answered it at the time of export (GDPR article 15).",
    customerId: input.customerId,
    customerName: input.customerName,
    exportedAt: input.exportedAt,
    exportedBy: input.exportedBy,
    sections,
    notIncluded,
  }
}

/** `customer-export-osterbro-boligselskab-2026-10-28.json`: the customer's name in plain letters and the day. */
export function customerExportFileName(customerName: string, day: string): string {
  const slug = customerName
    .normalize("NFKD")
    .replace(/[øØ]/g, "o")
    .replace(/[æÆ]/g, "ae")
    .replace(/[åÅ]/g, "a")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return `customer-export-${slug === "" ? "customer" : slug}-${day}.json`
}
