import type { APIRequestContext } from "@playwright/test"
import type { Message, MessageTemplate } from "@waste/contracts/messaging"

import { dayIn } from "./dispatched-route"
import { uniqueName } from "./env"
import { expect, test } from "./fixtures"
import { answerOf, pick, toasts } from "./routes-support"
import { listAll, projectNamed, TESTER_PROJECT } from "./tester"

// The customer notices of a bulky collection on the Pilot (O16 of #290, part
// b). A service e-mail naming {{collectionDate}} is written for Copenhagen
// Central through the API; Settings › Message templates' Customer notices
// sends it when a bulky collection is booked and when one is cancelled, and
// the PUT carries those two notices alone. A customer of its own, with an
// e-mail, books a collection on a planning area drawn for the run; the
// worker's customer notices consumer queues the template to the customer with
// the booking's day filled in, and the log-only sender sends it. Cancelling
// the booking sends the second. The project's notices are put back to none at
// the end, so the other scenarios' bookings notify nobody. Everything is
// uniquely named and never cleaned up.

type Named = { id: string; name: string }

const made = async <T>(api: APIRequestContext, path: string, data: unknown): Promise<T> => {
  const response = await api.post(path, { data })
  expect(response.status(), `POST ${path}: ${await response.text()}`).toBe(201)
  return (await response.json()) as T
}

/** A square of about a hundred metres at a spot drawn for the run, far from the seed's areas and from any earlier run's. */
function spot(): { centre: [number, number]; square: { type: "Polygon"; coordinates: [number, number][][] } } {
  const [lon, lat] = [9 + Math.random() * 1.5, 56 + Math.random() * 1.2].map((value) => Math.round(value * 10_000) / 10_000)
  const d = 0.001
  return { centre: [lon, lat], square: { type: "Polygon", coordinates: [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]] } }
}

/** Reads the customer's messages until one with this subject has been settled by the worker, and answers it. */
async function settledMessage(api: APIRequestContext, customerId: string, subject: string): Promise<Message> {
  let found: Message | undefined
  await expect
    .poll(
      async () => {
        const page = (await (await api.get("/messages", { params: { customerId } })).json()) as { items: Message[] }
        found = page.items.find((item) => item.subject === subject)
        return found?.status ?? "missing"
      },
      { timeout: 90_000, intervals: [1_000, 2_000, 3_000] },
    )
    .toBe("sent")
  return found as Message
}

test("a project sends its bulky collections' customers the notices it chose in Settings, from its own templates, through the log-only sender", async ({ api, page }) => {
  test.setTimeout(180_000)
  const project = await projectNamed(api, TESTER_PROJECT)
  const rulesPath = `/projects/${project.id}/notification-rules`
  const template = await made<MessageTemplate>(api, "/message-templates", {
    projectId: project.id,
    name: uniqueName("E2E Bulky notice"),
    purpose: "service",
    channel: "email",
    subject: "Your bulky collection on {{collectionDate}}",
    body: "Dear {{recipientName}},\nwe collect your items on {{collectionDate}}.\n{{companyName}}",
  })

  // Settings › Message templates: the booked and the cancelled notice from the template.
  const read = answerOf(page, "GET", "/message-templates")
  await page.goto("/settings?pane=message-templates")
  expect((await read).status()).toBe(200)
  await pick(page.locator("body"), page, "Project", project.name)
  const section = page.getByTestId("customer-notices")
  await pick(section, page, "Bulky collection booked", template.name)
  await pick(section, page, "Bulky collection cancelled", template.name)
  const [saved] = await Promise.all([answerOf(page, "PUT", rulesPath), section.getByRole("button", { name: "Save notices" }).click()])
  expect(saved.status(), await saved.text()).toBe(200)
  expect(saved.request().postDataJSON()).toEqual({
    rules: [
      { event: "bulky-booking-booked", templateId: template.id },
      { event: "bulky-booking-cancelled", templateId: template.id },
    ],
  })
  await expect(toasts(page)).toContainText("Customer notices saved")

  try {
    // A customer of its own with an e-mail, at a property inside an area drawn for the run, under a signed agreement.
    const fraction = (await listAll<Named>(api, "/waste-fractions")).find((row) => row.name === "Residual")
    expect(fraction, "the seed holds a Residual fraction").toBeTruthy()
    const today = dayIn("Europe/Copenhagen")
    const { centre, square } = spot()
    const area = await made<Named>(api, "/planning-areas", { projectId: project.id, code: uniqueName("E2E-NTC").replace(/\s+/g, "-").toUpperCase(), name: uniqueName("E2E Notice area"), purpose: "service-operations", boundary: { boundary: square, validFrom: today } })
    const property = await made<Named>(api, "/properties", { projectId: project.id, name: uniqueName("E2E Notice property"), address: "Skovvej 3, 8600 Silkeborg", kind: "residential", location: { type: "Point", coordinates: centre } })
    const customer = await made<Named>(api, "/customers", { kind: "person", name: uniqueName("E2E Notice customer"), email: "bulky-notices@waste-e2e.example", serviceMessagesAllowed: true })
    const collection = await made<Named>(api, "/products", { projectId: project.id, name: uniqueName("E2E Notice residual"), kind: "container-collection", unit: "pickup", status: "active" })
    const bulky = await made<Named>(api, "/products", { projectId: project.id, name: uniqueName("E2E Notice bulky"), kind: "additional-service", unit: "job", status: "active" })
    const agreement = await made<{ id: string }>(api, "/agreements", { projectId: project.id, number: uniqueName("E2E-NTC").replace(/\s+/g, "-").toUpperCase(), customerId: customer.id, payerCustomerId: customer.id, status: "active", billingCadence: "monthly", currency: "DKK", validFrom: today, validTo: null })
    await made(api, `/agreements/${agreement.id}/subscriptions`, { productId: collection.id, propertyId: property.id, validFrom: today, validTo: null })
    await made(api, "/bulky-schedules", { projectId: project.id, planningAreaId: area.id, frequency: "daily", serviceDays: ["monday", "tuesday", "wednesday", "thursday", "friday"], holidayPolicy: "collect", slotsPerDay: 1, productId: bulky.id, validFrom: today })
    const fortnight = new Date(Date.parse(`${today}T00:00:00Z`) + 14 * 86_400_000).toISOString().slice(0, 10)
    const [first] = ((await (await api.get(`/bulky-bookings/availability?propertyId=${property.id}&from=${today}&to=${fortnight}`)).json()) as { days: { day: string }[] }).days
    expect(first, "a bookable day within a fortnight").toBeTruthy()

    // Booked: the worker sends the template to the customer, the day filled in.
    const booking = await made<{ id: string }>(api, "/bulky-bookings", { customerId: customer.id, agreementId: agreement.id, propertyId: property.id, wasteFractionId: fraction?.id, day: first.day, items: [{ description: "Sofa", quantity: 1 }] })
    const subject = `Your bulky collection on ${first.day}`
    const notice = await settledMessage(api, customer.id, subject)
    expect(notice).toMatchObject({ templateId: template.id, recipient: "bulky-notices@waste-e2e.example", purpose: "service", provider: "log" })
    expect(notice.body).toContain(`we collect your items on ${first.day}.`)

    // Cancelled: the second notice, from the same template.
    const cancelled = await api.post(`/bulky-bookings/${booking.id}/cancel`, { data: { reason: "Customer called" } })
    expect(cancelled.status(), await cancelled.text()).toBe(200)
    await expect
      .poll(async () => ((await (await api.get("/messages", { params: { customerId: customer.id } })).json()) as { items: Message[] }).items.filter((item) => item.subject === subject && item.status === "sent").length, { timeout: 90_000, intervals: [1_000, 2_000, 3_000] })
      .toBe(2)
  } finally {
    expect((await api.put(rulesPath, { data: { rules: [] } })).status()).toBe(200)
  }
})
