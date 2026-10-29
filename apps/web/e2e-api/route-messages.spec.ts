import type { RouteMessage } from "@waste/contracts/route-messages"

import { dayIn, driverNamed, SEEDED_DRIVER } from "./dispatched-route"
import { E2E, uniqueName } from "./env"
import { expect, freshContext, signIn, test } from "./fixtures"
import { answerOf, openRoute } from "./routes-support"
import { projectNamed, TESTER_PROJECT } from "./tester"

// Driver messaging on the Pilot (O24 of #290). The office makes a route of
// its own for the seeded driver and writes to him from the route's details;
// the POST carries the text alone. The driver signs in on a phone, opens the
// route and reads the office's message, and answers it; the POST carries the
// id his device minted and the text. The office's details, read again, show
// the thread: the office's message, then the driver's, under his name. The
// route is made for the run and never cleaned up.

test("the office writes to a route's driver from its details, the driver reads it on the route's screen and answers, and the office reads the answer", async ({ api, browser, page: office }) => {
  test.setTimeout(150_000)
  const project = await projectNamed(api, TESTER_PROJECT)
  const driver = await driverNamed(api, SEEDED_DRIVER.name)
  const made = await api.post("/routes", { data: { projectId: project.id, operatingDate: dayIn("Europe/Copenhagen"), driverId: driver.id, acceptSameDay: true } })
  expect(made.status(), await made.text()).toBe(201)
  const route = (await made.json()) as { id: string; label: string }

  // The office writes from the route's details.
  const officeText = uniqueName("Gate code at the depot is 4711")
  const details = await openRoute(office, route)
  const section = details.getByTestId("route-messages")
  await expect(section.getByText("No message yet between the office and the driver.")).toBeVisible()
  await section.getByLabel("Message to the driver").fill(officeText)
  const [sent] = await Promise.all([answerOf(office, "POST", `/routes/${route.id}/messages`), section.getByRole("button", { name: "Send to driver" }).click()])
  expect(sent.status(), await sent.text()).toBe(201)
  expect(sent.request().postDataJSON()).toEqual({ body: officeText })
  await expect(section.getByText(officeText)).toBeVisible()

  // The driver reads it on the route's screen and answers.
  const context = await freshContext(browser, { viewport: { width: 390, height: 844 } })
  const driverText = uniqueName("Thanks, on my way")
  try {
    const phone = await context.newPage()
    await signIn(phone, SEEDED_DRIVER.email, E2E.loginPassword)
    await expect(phone).toHaveURL(/\/driver$/)
    await phone.goto(`/driver/routes/${route.id}`)
    const thread = phone.getByRole("region", { name: "Messages with the office" })
    await expect(thread.getByText(officeText)).toBeVisible({ timeout: 30_000 })
    await thread.getByLabel("Message to the office").fill(driverText)
    const [answered] = await Promise.all([answerOf(phone, "POST", `/driver/routes/${route.id}/messages`), thread.getByRole("button", { name: "Send to the office" }).click()])
    expect(answered.status(), await answered.text()).toBe(201)
    const body = answered.request().postDataJSON() as { id: string; body: string }
    expect(body.body).toBe(driverText)
    expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    await expect(thread.getByText(driverText)).toBeVisible()
  } finally {
    await context.close()
  }

  // The office reads the thread: its message, then the driver's under his name.
  const read = (await (await api.get(`/routes/${route.id}/messages`)).json()) as RouteMessage[]
  expect(read.map((message) => [message.author, message.body, message.senderName])).toEqual([
    ["office", officeText, expect.any(String)],
    ["driver", driverText, SEEDED_DRIVER.name],
  ])
  const again = await openRoute(office, route)
  await expect(again.getByTestId("route-messages").getByText(`${SEEDED_DRIVER.name} (driver)`)).toBeVisible()
  await expect(again.getByTestId("route-messages").getByText(driverText)).toBeVisible()
})
