// A Customer's export (#291 C19, part 2): every family in the file's order,
// a family the role was refused named with the API's sentence, and the file
// named after the customer and the day.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { CUSTOMER_EXPORT_SECTIONS, customerExportFileName, customerExportOf, type CustomerExportSectionKey, type SectionOutcome } from "../customer-export"

const everything = (outcome: (key: CustomerExportSectionKey) => SectionOutcome) =>
  Object.fromEntries(CUSTOMER_EXPORT_SECTIONS.map(({ key }) => [key, outcome(key)])) as Record<CustomerExportSectionKey, SectionOutcome>

describe("a customer's export", () => {
  test("holds every family answered, in the file's order, and names the ones the role was refused with the API's reason", () => {
    const document = customerExportOf({
      customerId: "c-1",
      customerName: "Østerbro Boligselskab",
      exportedAt: "2026-10-28T22:00:00.000Z",
      exportedBy: "Mette Holm",
      outcomes: everything((key) => (key === "payments" ? { included: false, reason: "This account's role does not allow view on commercial.payments" } : { included: true, data: [key] })),
    })
    assert.deepEqual(Object.keys(document.sections), CUSTOMER_EXPORT_SECTIONS.map(({ key }) => key).filter((key) => key !== "payments"))
    assert.deepEqual(document.sections.invoices, ["invoices"])
    assert.deepEqual(document.notIncluded, [{ section: "Payments", reason: "This account's role does not allow view on commercial.payments" }])
    assert.equal(document.customerName, "Østerbro Boligselskab")
    assert.match(document.about, /GDPR article 15/)
  })

  test("is named after the customer in plain letters and the day", () => {
    assert.equal(customerExportFileName("Østerbro Boligselskab", "2026-10-28"), "customer-export-osterbro-boligselskab-2026-10-28.json")
    assert.equal(customerExportFileName("Ærø & Åbenrå ApS", "2026-10-28"), "customer-export-aero-abenra-aps-2026-10-28.json")
    assert.equal(customerExportFileName("!!!", "2026-10-28"), "customer-export-customer-2026-10-28.json")
  })
})
