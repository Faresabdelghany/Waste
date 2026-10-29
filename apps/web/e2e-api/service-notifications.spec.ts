import type { APIRequestContext } from "@playwright/test"
import type { Message, MessageTemplate } from "@waste/contracts/messaging"

import { dayIn } from "./dispatched-route"
import { uniqueName } from "./env"
import { expect, test } from "./fixtures"
import { answerOf, pick, toasts } from "./routes-support"
import { projectNamed, TESTER_PROJECT } from "./tester"

// The service notifications on the Pilot (C18 of #291). Two service e-mails
// are written for Copenhagen Central through the API: a ticket reply naming
// {{ticketNumber}} and {{replyText}}, and a route notice naming
// {{collectionDate}}. Settings › Message templates' Customer notices offers
// the reply's template for a ticket's reply alone — not for a booking, which
// fills neither value — and sends a cancelled route's notice to a
// notification area drawn for the run, ticked under the notice; the PUT
// carries the reply's rule, and the broadcast's with its area. A customer of
// its own, with an e-mail, is named by a ticket; the office's reply to the
// customer there is queued by the worker's customer notices consumer with the
// ticket's label and the reply's words, and the log-only sender sends it. The
// project's notices are put back to none at the end, so the other scenarios'
// tickets and routes notify nobody. Everything is uniquely named and never
// cleaned up.

type Named = { id: string; name: string }

const made = async <T>(api: APIRequestContext, path: string, data: unknown): Promise<T> => {
  const response = await api.post(path, { data })
  expect(response.status(), `POST ${path}: ${await response.text()}`).toBe(201)
  return (await response.json()) as T
}

/** A square of about a hundred metres at a spot drawn for the run, far from the seed's areas and from any earlier run's. */
function square(): { type: "Polygon"; coordinates: [number, number][][] } {
  const [lon, lat] = [9 + Math.random() * 1.5, 56 + Math.random() * 1.2].map((value) => Math.round(value * 10_000) / 10_000)
  const d = 0.001
  return { type: "Polygon", coordinates: [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]] }
}

test("a project sends a ticket's customer the office's reply, and a cancelled route's notice to the areas it ticked, from the notices it chose in Settings", async ({ api, page }) => {
  test.setTimeout(180_000)
  const project = await projectNamed(api, TESTER_PROJECT)
  const rulesPath = `/projects/${project.id}/notification-rules`
  const reply = await made<MessageTemplate>(api, "/message-templates", {
    projectId: project.id,
    name: uniqueName("E2E Ticket reply"),
    purpose: "service",
    channel: "email",
    subject: "About your ticket {{ticketNumber}}",
    body: "Dear {{recipientName}},\n{{replyText}}\n{{companyName}}",
  })
  const routeNotice = await made<MessageTemplate>(api, "/message-templates", {
    projectId: project.id,
    name: uniqueName("E2E Route notice"),
    purpose: "service",
    channel: "email",
    subject: "Your collection on {{collectionDate}}",
    body: "Dear {{recipientName}}, your collection on {{collectionDate}} is cancelled.",
  })
  const area = await made<Named>(api, "/planning-areas", {
    projectId: project.id,
    code: uniqueName("E2E-NTF").replace(/\s+/g, "-").toUpperCase(),
    name: uniqueName("E2E Notification area"),
    purpose: "notification",
    boundary: { boundary: square(), validFrom: dayIn("Europe/Copenhagen") },
  })

  // Settings › Message templates: the reply's template is a ticket reply's alone; the route notice goes to the area ticked.
  const read = answerOf(page, "GET", "/message-templates")
  await page.goto("/settings?pane=message-templates")
  expect((await read).status()).toBe(200)
  await pick(page.locator("body"), page, "Project", project.name)
  const section = page.getByTestId("customer-notices")
  await section.getByLabel("Bulky collection booked").click()
  await expect(page.getByRole("option", { name: reply.name })).toHaveCount(0)
  await page.keyboard.press("Escape")
  await pick(section, page, "Ticket reply", reply.name)
  await pick(section, page, "Route cancelled", routeNotice.name)
  await section.getByTestId("notice-areas-route-cancelled").getByRole("checkbox", { name: area.name }).click()
  const [saved] = await Promise.all([answerOf(page, "PUT", rulesPath), section.getByRole("button", { name: "Save notices" }).click()])
  expect(saved.status(), await saved.text()).toBe(200)
  expect(saved.request().postDataJSON()).toEqual({
    rules: [
      { event: "ticket-replied", templateId: reply.id },
      { event: "route-cancelled", templateId: routeNotice.id, planningAreaIds: [area.id] },
    ],
  })
  await expect(toasts(page)).toContainText("Customer notices saved")

  try {
    // A ticket naming a customer of its own with an e-mail; the office replies to the customer on it.
    const customer = await made<Named>(api, "/customers", { kind: "person", name: uniqueName("E2E Reply customer"), email: "ticket-replies@waste-e2e.example", serviceMessagesAllowed: true })
    const ticket = await made<{ id: string; label: string }>(api, "/tickets", { projectId: project.id, subject: uniqueName("E2E Lid broken"), description: "The lid hangs by one hinge", kind: "complaint", links: { customerId: customer.id } })
    const words = "We replace the lid on Thursday."
    await made(api, `/tickets/${ticket.id}/comments`, { body: words, visibility: "customer" })
    await made(api, `/tickets/${ticket.id}/comments`, { body: "Internal: order a lid", visibility: "internal" })

    const subject = `About your ticket ${ticket.label}`
    let found: Message[] = []
    await expect
      .poll(
        async () => {
          found = ((await (await api.get("/messages", { params: { customerId: customer.id } })).json()) as { items: Message[] }).items
          return found.filter((item) => item.subject === subject).map((item) => item.status)
        },
        { timeout: 90_000, intervals: [1_000, 2_000, 3_000] },
      )
      .toEqual(["sent"])
    const sent = found.find((item) => item.subject === subject) as Message
    expect(sent).toMatchObject({ templateId: reply.id, recipient: "ticket-replies@waste-e2e.example", purpose: "service", provider: "log" })
    expect(sent.body).toContain(words)
    expect(found, "an internal comment is not the customer's news").toHaveLength(1)
  } finally {
    expect((await api.put(rulesPath, { data: { rules: [] } })).status()).toBe(200)
  }
})
