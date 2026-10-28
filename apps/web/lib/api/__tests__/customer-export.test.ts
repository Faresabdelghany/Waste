// The reads a Customer's export is made of (#291 C19, part 2): each family's
// own list filtered by the customer, an agreement's subscriptions and a
// ticket's messages read beside it, a family refused to the role (403) not
// included with the API's sentence, and any other failure failing the export.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { readCustomerExport } from "../customer-export"
import { clientOver, json, problem, scripted } from "./scripted-fetch"

const CUSTOMER = "0199a000-0000-7000-8000-000000000001"
const AGREEMENT = "0199a000-0000-7000-8000-000000000002"
const TICKET = "0199a000-0000-7000-8000-000000000003"
const page = (items: unknown[]) => json({ items, nextCursor: null })

describe("a customer's export, as the API answers it", () => {
  test("reads each family by the customer, with an agreement's subscriptions and a ticket's messages; a family refused to the role is not included", async () => {
    const { fetch, calls } = scripted([
      () => json({ id: CUSTOMER, name: "Østerbro Boligselskab" }),
      () => page([{ id: "a-1", table: "customer" }]),
      () => page([{ id: "p-1" }]),
      () => page([{ id: AGREEMENT }]),
      () => page([{ id: "s-1" }]),
      () => page([]),
      () => page([{ id: "i-1" }]),
      () => problem(403, "This account's role does not allow view on commercial.payments"),
      () => page([{ id: TICKET }]),
      () => page([{ id: "e-1", kind: "comment" }]),
      () => page([]),
      () => page([]),
      () => page([]),
      () => page([]),
    ])
    const outcomes = await readCustomerExport(clientOver(fetch), CUSTOMER)
    assert.deepEqual(
      calls.map((call) => { const url = new URL(call.url); return `${url.pathname}${url.searchParams.has("customerId") ? "?customerId" : ""}` }),
      [
        `/customers/${CUSTOMER}`,
        "/audit-events",
        "/properties?customerId",
        "/agreements?customerId",
        `/agreements/${AGREEMENT}/subscriptions`,
        "/billable-events?customerId",
        "/invoices?customerId",
        "/payments?customerId",
        "/tickets?customerId",
        `/tickets/${TICKET}/events`,
        "/access-credentials?customerId",
        "/site-visits?customerId",
        "/bulky-bookings?customerId",
        "/applications?customerId",
      ],
    )
    assert.equal(new URL(calls[1].url).searchParams.get("rowId"), CUSTOMER)
    assert.deepEqual(outcomes.agreements, { included: true, data: [{ id: AGREEMENT, subscriptions: [{ id: "s-1" }] }] })
    assert.deepEqual(outcomes.tickets, { included: true, data: [{ id: TICKET, events: [{ id: "e-1", kind: "comment" }] }] })
    assert.deepEqual(outcomes.payments, { included: false, reason: "This account's role does not allow view on commercial.payments" })
  })

  test("any other failure fails the export: no file missing a family without saying so", async () => {
    const { fetch } = scripted([() => json({ id: CUSTOMER, name: "Østerbro Boligselskab" }), () => problem(500, "The database did not answer")])
    await assert.rejects(readCustomerExport(clientOver(fetch), CUSTOMER), /The database did not answer/)
  })
})
