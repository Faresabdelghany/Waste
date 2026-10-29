// A Customer's export on the Pilot (#291 C19, part 2, #381): from its
// details, everything held about it as one JSON file, read from the API's own
// reads filtered by the customer — the customer, its history, its agreements
// with their subscriptions, its properties and the rest — each read under its
// own grant, a part the role is refused named in the file. The seeded
// Østerbro Housing holds agreements, so its file carries them.
import type { Agreement } from "@waste/contracts/agreements"
import type { Customer } from "@waste/contracts/customers"
import { readFile } from "node:fs/promises"

import { expect, test } from "./fixtures"
import { answerOf, toasts } from "./routes-support"
import { listAll } from "./tester"

test("a customer's details export everything held about it as one file, read by the customer from each family's own list", async ({ api, page }) => {
  const housing = (await listAll<Customer>(api, "/customers")).find((customer) => customer.name.startsWith("Østerbro Housing"))
  if (housing === undefined) throw new Error("the seed holds no Østerbro Housing")
  const agreements = await listAll<Agreement>(api, "/agreements", { customerId: housing.id })

  const customers = answerOf(page, "GET", "/customers")
  await page.goto("/customers?module=contacts")
  expect((await customers).status()).toBe(200)
  await page.getByRole("main").getByRole("textbox", { name: /^Search .+/ }).fill(housing.name)
  await page.getByRole("button", { name: `Open ${housing.name}` }).first().click()

  // Each family is read by the customer; the page's own unfiltered reads of the same lists may answer alongside it.
  const byCustomer = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return response.request().method() === "GET" && url.pathname === "/waste-api/invoices" && url.searchParams.get("customerId") === housing.id
  })
  const [download, invoices] = await Promise.all([page.waitForEvent("download"), byCustomer, page.getByRole("button", { name: "Export customer data" }).click()])
  expect(invoices.status(), "each family is read by the customer").toBe(200)
  expect(download.suggestedFilename()).toMatch(/^customer-export-osterbro-housing.*\.json$/)
  await expect(toasts(page)).toContainText("Customer data exported")

  const file = JSON.parse(await readFile(await download.path(), "utf8")) as { customerId: string; customerName: string; sections: Record<string, unknown>; notIncluded: unknown[] }
  expect(file.customerId).toBe(housing.id)
  expect(file.customerName).toBe(housing.name)
  expect((file.sections.customer as Customer).name).toBe(housing.name)
  expect(file.notIncluded, "the administrator reads every family").toEqual([])
  const exported = file.sections.agreements as (Agreement & { subscriptions: unknown[] })[]
  expect(exported.map((agreement) => agreement.id).sort()).toEqual(agreements.map((agreement) => agreement.id).sort())
  for (const agreement of exported) expect(Array.isArray(agreement.subscriptions)).toBe(true)
  for (const key of ["history", "contacts", "properties", "billableEvents", "invoices", "payments", "tickets", "accessCredentials", "siteVisits", "bulkyBookings", "applications"]) expect(Array.isArray(file.sections[key]), key).toBe(true)
})
