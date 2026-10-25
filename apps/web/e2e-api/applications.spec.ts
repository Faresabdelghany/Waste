import type { Page } from "@playwright/test"

import { expect, test } from "./fixtures"
import { uniqueName } from "./env"
import { pick } from "./routes-support"
import { projectNamed, TESTER_PROJECT } from "./tester"

// An Application on the Pilot (M7 of #293), through Customers › Applications:
// recorded by its own form as it reached the office — naming the customer's
// subscription, which the picker offers from the agreements module — taken into review, and
// decided through the Decide dialog — a partial grant over a month, the
// dialog's last day in force the wire's first day out, with its conditions
// and how to appeal — its Decision listed in the details and printed as the
// decision letter; then reopened on an appeal and the appeal withdrawn, back
// to the Decision it had. Each is the request the API takes, read back from
// the API.
type Application = { id: string; number: number; status: string; kind: string; customerId: string; decision: { id: string; outcome: string; validFrom: string | null; validTo: string | null } | null }

/** A day `offset` days from today, `YYYY-MM-DD` on the UTC calendar: never after today on the project's clock, which runs ahead of UTC. */
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

/** The browser's API call a submit or a press makes: the answer of the request path `path`, method `method`. */
const answerOf = (page: Page, method: string, path: string) =>
  page.waitForResponse((response) => response.request().method() === method && new URL(response.url()).pathname === `/waste-api${path}`)

test("an application recorded, reviewed and decided in part, its letter printed, and an appeal withdrawn back to its decision, each the API's own request", async ({ page, api }) => {
  const project = await projectNamed(api, TESTER_PROJECT)
  const made = async <T>(path: string, data: unknown): Promise<T> => {
    const response = await api.post(path, { data })
    expect(response.status(), `POST ${path}`).toBe(201)
    return (await response.json()) as T
  }
  const customer = await made<{ id: string; name: string }>("/customers", { kind: "person", name: uniqueName("E2E Applicant") })
  const product = await made<{ id: string; name: string }>("/products", { projectId: project.id, name: uniqueName("E2E Applicant product"), kind: "container-collection", unit: "pickup", status: "active" })
  const property = await made<{ id: string }>("/properties", { projectId: project.id, name: uniqueName("E2E Applicant property"), address: "Parkvej 20, 2100 København Ø", kind: "residential" })
  const number = uniqueName("E2E-APPL").replace(/\s+/g, "-").toUpperCase()
  const agreement = await made<{ id: string; number: string }>("/agreements", { projectId: project.id, number, customerId: customer.id, payerCustomerId: customer.id, status: "active", billingCadence: "monthly", currency: "DKK", validFrom: day(-30), validTo: null })
  const subscription = await made<{ id: string }>(`/agreements/${agreement.id}/subscriptions`, { productId: product.id, propertyId: property.id, validFrom: day(-30), validTo: null })
  const loaded = answerOf(page, "GET", "/applications")
  await page.goto("/customers?module=applications")
  expect((await loaded).status()).toBe(200)

  // Recorded by the module's own form: the customer's statement, no place.
  await page.getByRole("main").getByRole("button", { name: "Record application" }).click()
  const form = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Record application" }) })
  await pick(form, page, "Project", TESTER_PROJECT)
  await pick(form, page, "Applies for", "Fee correction")
  await form.getByLabel("Received on").fill(day(0))
  await pick(form, page, "Customer", customer.name)
  await pick(form, page, "Subscription", `${agreement.number} · ${product.name}`)
  await form.getByLabel("What the customer asks").fill("The bin was emptied every other week, not weekly.")
  const [recorded] = await Promise.all([answerOf(page, "POST", "/applications"), form.getByRole("button", { name: "Record application" }).click()])
  expect(recorded.status()).toBe(201)
  expect(recorded.request().postDataJSON()).toMatchObject({ kind: "fee-correction", channel: "email", receivedOn: day(0), customerId: customer.id, subscriptionId: subscription.id })
  const application = (await recorded.json()) as Application

  // Its details, which the workspace opens on the row it made: the commands its status moves it by.
  const name = `Application ${application.number} · Fee correction`
  const sheet = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name }) })
  const commands = sheet.getByTestId("application-commands")
  await expect(commands.getByText("Not decided yet.")).toBeVisible()
  const [reviewed] = await Promise.all([answerOf(page, "POST", `/applications/${application.id}/review`), commands.getByRole("button", { name: "Take into review" }).click()])
  expect(reviewed.status()).toBe(200)

  // Decided in part over a month from a week on: the dialog's last day in, the wire's end the day after.
  await commands.getByRole("button", { name: "Decide" }).click()
  const deciding = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Decide the application" }) })
  await pick(deciding, page, "Outcome", "Partly granted")
  await deciding.getByLabel("Conditions or reasons").fill("Half the fee is refunded.")
  await deciding.getByLabel("First day in force").fill(day(7))
  await deciding.getByLabel("Last day in force").fill(day(36))
  await deciding.getByLabel("How to appeal").fill("Write to the municipality within four weeks.")
  const [decided] = await Promise.all([answerOf(page, "POST", `/applications/${application.id}/decide`), deciding.getByRole("button", { name: "Record decision" }).click()])
  expect(decided.status()).toBe(200)
  expect(decided.request().postDataJSON()).toEqual({ outcome: "partly-granted", conditions: "Half the fee is refunded.", validFrom: day(7), validTo: day(37), appealText: "Write to the municipality within four weeks." })
  const decision = ((await decided.json()) as Application).decision
  await expect(commands.getByTestId("application-decisions").getByRole("listitem")).toHaveText([new RegExp(`Partly granted · ${day(7)} to ${day(36)}$`)])

  // The letter, printed from its own page.
  const [letterPage] = await Promise.all([page.context().waitForEvent("page"), commands.getByRole("link", { name: "Decision letter" }).click()])
  const letter = letterPage.getByTestId("decision-letter")
  await expect(letter.getByRole("heading", { name: `Decision on application ${application.number}: Fee correction` })).toBeVisible()
  await expect(letter.getByText("Your application is granted in part.")).toBeVisible()
  await expect(letter.getByText(`The decision is in force from ${day(7)} up to and including ${day(36)}.`)).toBeVisible()
  await expect(letter.getByText("Write to the municipality within four weeks.")).toBeVisible()
  await letterPage.close()

  // Reopened on an appeal, then the appeal withdrawn: back to the Decision it had.
  const [reopened] = await Promise.all([answerOf(page, "POST", `/applications/${application.id}/reopen`), commands.getByRole("button", { name: "Reopen on appeal" }).click()])
  expect(reopened.status()).toBe(200)
  const [withdrawn] = await Promise.all([answerOf(page, "POST", `/applications/${application.id}/withdraw`), commands.getByRole("button", { name: "Withdraw appeal" }).click()])
  expect(withdrawn.status()).toBe(200)
  const after = (await (await api.get(`/applications/${application.id}`)).json()) as Application
  expect([after.status, after.decision?.id]).toEqual(["decided", decision?.id])
  await expect(commands.getByRole("button", { name: "Reopen on appeal" })).toBeVisible()
})
