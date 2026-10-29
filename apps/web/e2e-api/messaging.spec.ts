import type { Customer, CustomerContact } from "@waste/contracts/customers"
import type { Message, MessageTemplate } from "@waste/contracts/messaging"

import { uniqueName } from "./env"
import { expect, test } from "./fixtures"
import { answerOf, pick, toasts } from "./routes-support"

// The messaging foundation on the Pilot (#291 C15). Settings › Message
// templates writes an e-mail template for service messages in Copenhagen
// Central, its POST naming the project. An organisation of its own, with an
// e-mail and a contact person reached by phone, opens in Customers ›
// Contacts & Companies, and Send message queues the template to the
// organisation's own address: the POST names the template and the customer,
// the message is answered queued, and the worker sends it through the
// log-only sender — the API reads it sent by `log` — and Refresh shows it
// Sent. Consent is honoured: a person who allows no service messages is sent
// the same template through the API, and the worker withholds it. Records
// are uniquely named and never cleaned up.

/** Reads a message until the worker has settled it, and answers how it stands. */
async function settled(api: import("@playwright/test").APIRequestContext, id: string): Promise<Message> {
  let message: Message | undefined
  await expect
    .poll(
      async () => {
        message = (await (await api.get(`/messages/${id}`)).json()) as Message
        return message.status
      },
      { timeout: 60_000, intervals: [500, 1_000, 2_000] },
    )
    .not.toBe("queued")
  return message as Message
}

test("a template written in Settings, sent to an organisation from its details through the log-only sender, and withheld from a customer who allows no service messages", async ({ api, page }) => {
  test.setTimeout(180_000)
  const templateName = uniqueName("E2E Collection moved")

  // Settings › Message templates: an e-mail for service messages in Copenhagen Central.
  const read = answerOf(page, "GET", "/message-templates")
  await page.goto("/settings?pane=message-templates")
  expect((await read).status()).toBe(200)
  await pick(page.locator("body"), page, "Project", "Copenhagen Central")
  await page.getByRole("button", { name: "Add template" }).click()
  const add = page.getByRole("dialog", { name: "Add template" })
  await add.getByLabel("Name").fill(templateName)
  await add.getByLabel("Subject").fill("Your collection, {{customerName}}")
  await add.getByLabel("Message").fill("Dear {{recipientName}},\nyour collection moves to Thursday.\n{{companyName}}")
  const [created] = await Promise.all([answerOf(page, "POST", "/message-templates"), add.getByRole("button", { name: "Add template" }).click()])
  expect(created.status(), await created.text()).toBe(201)
  const template = (await created.json()) as MessageTemplate
  expect(created.request().postDataJSON()).toEqual({ projectId: template.projectId, name: templateName, purpose: "service", channel: "email", subject: "Your collection, {{customerName}}", body: "Dear {{recipientName}},\nyour collection moves to Thursday.\n{{companyName}}", status: "active" })
  await expect(toasts(page)).toContainText("Template added")
  await expect(page.getByTestId("message-templates").getByText(templateName)).toBeVisible()

  // An organisation of its own, with its e-mail and a contact person reached by phone.
  const name = uniqueName("E2E Messaging Housing")
  const made = await api.post("/customers", { data: { kind: "organisation", name, email: "kontor@messaging.example" } })
  expect(made.status(), await made.text()).toBe(201)
  const organisation = (await made.json()) as Customer
  const contact = await api.post(`/customers/${organisation.id}/contacts`, { data: { name: "Ole Vicevært", role: "on-site", phone: "+45 20 30 40 50" } })
  expect(contact.status(), await contact.text()).toBe(201)
  expect(((await contact.json()) as CustomerContact).status).toBe("active")

  // Its details: Send message, the template to the organisation's own address.
  const customers = answerOf(page, "GET", "/customers")
  await page.goto("/customers?module=contacts")
  expect((await customers).status()).toBe(200)
  await page.getByRole("main").getByRole("textbox", { name: /^Search .+/ }).fill(name)
  await page.getByRole("button", { name: `Open ${name}` }).first().click()
  const section = page.getByTestId("customer-messages")
  await expect(section.getByText("No message has been sent to this customer.")).toBeVisible()
  await section.getByRole("button", { name: "Send message" }).click()
  const send = page.getByRole("dialog", { name: `Send a message to ${name}` })
  await pick(send, page, "Template", `${templateName} · E-mail`)
  await pick(send, page, "To", `${name} · kontor@messaging.example`)
  const [posted] = await Promise.all([answerOf(page, "POST", "/messages"), send.getByRole("button", { name: "Send message" }).click()])
  expect(posted.status(), await posted.text()).toBe(201)
  expect(posted.request().postDataJSON()).toEqual({ templateId: template.id, customerId: organisation.id })
  const queued = (await posted.json()) as Message
  expect(queued).toMatchObject({ status: "queued", recipient: "kontor@messaging.example", subject: `Your collection, ${name}` })
  await expect(toasts(page)).toContainText("Message queued")

  // The worker sends it through the log-only sender; Refresh shows it Sent.
  expect(await settled(api, queued.id)).toMatchObject({ status: "sent", provider: "log", providerMessageId: `log-${queued.id}`, attempts: 1 })
  await section.getByRole("button", { name: "Refresh" }).click()
  await expect(section.getByTestId("customer-message-rows").getByText("Sent · E-mail to kontor@messaging.example")).toBeVisible()

  // Consent: a person who allows no service messages is never sent one.
  const declined = await api.post("/customers", { data: { kind: "person", name: uniqueName("E2E No messages"), email: "no-messages@messaging.example", serviceMessagesAllowed: false } })
  expect(declined.status(), await declined.text()).toBe(201)
  const person = (await declined.json()) as Customer
  const toPerson = await api.post("/messages", { data: { templateId: template.id, customerId: person.id } })
  expect(toPerson.status(), await toPerson.text()).toBe(201)
  expect(await settled(api, ((await toPerson.json()) as Message).id)).toMatchObject({ status: "withheld", reason: "The customer allows no service messages", attempts: 0, sentAt: null })
})
