import type { Customer, CustomerContact } from "@waste/contracts/customers"

import { uniqueName } from "./env"
import { expect, test } from "./fixtures"
import { answerOf, pick, toasts } from "./routes-support"

// An organisation's Contact Persons on the Pilot (#291 C14). An organisation
// of its own, made through the API, opens in Customers › Contacts &
// Companies: its details list no contact yet; Add contact posts a billing
// contact under it, the e-mail lowercased by the API, and the list reads it
// back; Edit retires the contact as inactive, the patch naming it, and the
// list says so. A person customer's details carry no such section, since a
// person is their own contact. Records are uniquely named and never cleaned up.

test("an organisation's contact persons: one added with a role and an e-mail, then retired as inactive", async ({ api, page }) => {
  const name = uniqueName("E2E Housing")
  const made = await api.post("/customers", { data: { kind: "organisation", name } })
  expect(made.status(), await made.text()).toBe(201)
  const organisation = (await made.json()) as Customer
  const personName = uniqueName("E2E Resident")
  expect((await api.post("/customers", { data: { kind: "person", name: personName } })).status()).toBe(201)

  const customers = answerOf(page, "GET", "/customers")
  await page.goto("/customers?module=contacts")
  expect((await customers).status()).toBe(200)
  const search = page.getByRole("main").getByRole("textbox", { name: /^Search .+/ })
  await search.fill(name)
  const listed = answerOf(page, "GET", `/customers/${organisation.id}/contacts`)
  await page.getByRole("button", { name: `Open ${name}` }).first().click()
  expect((await listed).status()).toBe(200)
  const section = page.getByTestId("contact-persons")
  await expect(section.getByText("No one is registered to speak for this organisation yet.")).toBeVisible()

  // Add contact: a billing contact reached by e-mail.
  await section.getByRole("button", { name: "Add contact" }).click()
  const add = page.getByRole("dialog", { name: `New contact person for ${name}` })
  await add.getByLabel("Name").fill("Hanne Holm")
  await pick(add, page, "Role", "Billing")
  await add.getByLabel("E-mail").fill("Hanne.Holm@Example.DK")
  const [created] = await Promise.all([answerOf(page, "POST", `/customers/${organisation.id}/contacts`), add.getByRole("button", { name: "Add contact" }).click()])
  expect(created.status(), await created.text()).toBe(201)
  expect(created.request().postDataJSON()).toEqual({ name: "Hanne Holm", role: "billing", email: "Hanne.Holm@Example.DK", phone: null, status: "active" })
  const hanne = (await created.json()) as CustomerContact
  expect(hanne.email).toBe("hanne.holm@example.dk")
  await expect(toasts(page)).toContainText("Contact person added")
  const rows = section.getByTestId("contact-person-rows")
  await expect(rows.getByText("Billing · hanne.holm@example.dk")).toBeVisible()

  // Edit: she has left, so she is made inactive, never deleted.
  await rows.getByRole("button", { name: "Edit" }).click()
  const edit = page.getByRole("dialog", { name: `Contact person of ${name}` })
  await pick(edit, page, "Status", "Inactive — has left")
  const [patched] = await Promise.all([answerOf(page, "PATCH", `/customer-contacts/${hanne.id}`), edit.getByRole("button", { name: "Save contact" }).click()])
  expect(patched.status(), await patched.text()).toBe(200)
  expect(patched.request().postDataJSON()).toMatchObject({ status: "inactive" })
  await expect(rows.getByText("Billing · hanne.holm@example.dk · Inactive")).toBeVisible()
  const read = (await (await api.get(`/customers/${organisation.id}/contacts`)).json()) as { items: CustomerContact[] }
  expect(read.items.map((contact) => [contact.name, contact.status])).toEqual([["Hanne Holm", "inactive"]])

  // A person is their own contact: no section in their details.
  await page.keyboard.press("Escape")
  await search.fill(personName)
  await page.getByRole("button", { name: `Open ${personName}` }).first().click()
  await expect(page.getByTestId("customer-sustainability")).toBeVisible()
  await expect(page.getByTestId("contact-persons")).toHaveCount(0)
})
