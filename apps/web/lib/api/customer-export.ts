// The reads a Customer's export is made of (#291 C19, part 2, #381): each
// family's own list, filtered by the customer, one after another — the
// customer itself, its row's history, its contact persons, the properties it
// is a party to, its agreements with each one's subscriptions, its billable
// events, invoices and payments, its tickets with each one's messages, its
// access credentials and recycling-centre visits, its bulky-waste bookings
// and its applications.
// A family the role is refused (403) is not included, with the API's
// sentence (lib/data/customer-export.ts); any other failure fails the export,
// so nobody is handed a file that is missing a family without knowing it.
import { listAll, get, type ApiClient } from "./client"
import { ApiProblem, problemSentence } from "./problem"
import type { CustomerExportSectionKey, SectionOutcome } from "@/lib/data/customer-export"

type Row = { id: string }

/** One family's read: its rows, or the refusal's sentence on a 403. */
async function section(read: () => Promise<unknown>): Promise<SectionOutcome> {
  try {
    return { included: true, data: await read() }
  } catch (error) {
    if (error instanceof ApiProblem && error.status === 403) return { included: false, reason: problemSentence(error.problem) }
    throw error
  }
}

/** Every family's outcome for the customer, by its server id. */
export async function readCustomerExport(client: ApiClient, customerId: string): Promise<Record<CustomerExportSectionKey, SectionOutcome>> {
  const byCustomer = (path: string) => () => listAll<Row>(client, path, { customerId })
  const encoded = encodeURIComponent(customerId)
  return {
    customer: await section(() => get(client, `/customers/${encoded}`)),
    history: await section(() => listAll(client, "/audit-events", { table: "customer", rowId: customerId })),
    contacts: await section(async () => (await get<{ items: unknown[] }>(client, `/customers/${encoded}/contacts`)).items),
    properties: await section(byCustomer("/properties")),
    agreements: await section(async () => {
      const agreements = await listAll<Row>(client, "/agreements", { customerId })
      const withSubscriptions = []
      for (const agreement of agreements) withSubscriptions.push({ ...agreement, subscriptions: await listAll(client, `/agreements/${encodeURIComponent(agreement.id)}/subscriptions`) })
      return withSubscriptions
    }),
    billableEvents: await section(byCustomer("/billable-events")),
    invoices: await section(byCustomer("/invoices")),
    payments: await section(byCustomer("/payments")),
    tickets: await section(async () => {
      const tickets = await listAll<Row>(client, "/tickets", { customerId })
      const withEvents = []
      for (const ticket of tickets) withEvents.push({ ...ticket, events: await listAll(client, `/tickets/${encodeURIComponent(ticket.id)}/events`) })
      return withEvents
    }),
    accessCredentials: await section(byCustomer("/access-credentials")),
    siteVisits: await section(byCustomer("/site-visits")),
    bulkyBookings: await section(byCustomer("/bulky-bookings")),
    applications: await section(byCustomer("/applications")),
  }
}
