// Ticket work priced on the web (#291 C3w): Settings › Commercial › Ticket
// charges sets the product a ticket kind's work is charged at, replaced
// whole; a completion that names none is charged at it, and one whose
// "Charged at" names a product of its own is charged at that one. The
// worker's consumer prices each ticket's event; both are read back through
// the API. The project's set is cleared again, since a developer's stack is
// shared across runs.
import type { APIRequestContext } from "@playwright/test"

import { uniqueName } from "./env"
import { expect, test } from "./fixtures"
import { answerOf, pick, toasts } from "./routes-support"
import { listAll, projectNamed, type Project } from "./tester"

type Product = { id: string; name: string }
type Agreement = { id: string; number: string }
type ApiTicket = { id: string; label: string; chargeProductId: string | null }
type Event = { id: string; status: string; productId: string | null; netMinor: number | null; links: { ticketId: string | null } }

/** A seeded product of the project by its name. */
async function productNamed(api: APIRequestContext, project: Project, name: string): Promise<Product> {
  const product = (await listAll<Product>(api, "/products", { projectId: project.id })).find((candidate) => candidate.name === name)
  if (product === undefined) throw new Error(`the seed has no ${name} in ${project.name}`)
  return product
}

/** An overflow about a seeded agreement, so its completion reaches one and Finance records its event. */
async function overflow(api: APIRequestContext, project: Project, agreement: Agreement): Promise<{ ticket: ApiTicket; subject: string }> {
  const subject = uniqueName("E2E overflow charged")
  const created = await api.post("/tickets", { data: { projectId: project.id, subject, description: "Bags beside the bin", kind: "overflow", links: { agreementId: agreement.id } } })
  expect(created.status(), await created.text()).toBe(201)
  return { ticket: (await created.json()) as ApiTicket, subject }
}

/** The ticket's billable event once the worker has recorded it. */
async function eventOf(api: APIRequestContext, ticket: ApiTicket): Promise<Event> {
  let found: Event | undefined
  await expect
    .poll(
      async () => {
        found = (await listAll<Event>(api, "/billable-events", { ticketId: ticket.id }))[0]
        return found?.status
      },
      { timeout: 30_000, message: `the worker records ${ticket.label}'s event` },
    )
    .toBe("ready")
  return found!
}

test.describe("ticket work priced (#291 C3)", () => {
  let project: Project
  let agreement: Agreement

  test.beforeEach(async ({ api }) => {
    project = await projectNamed(api, "Copenhagen Central")
    agreement = (await listAll<Agreement>(api, "/agreements")).find((candidate) => candidate.number === "AGR-2408") ?? (() => { throw new Error("the seed has no AGR-2408") })()
  })

  test.afterEach(async ({ api }) => {
    const cleared = await api.put("/ticket-charges", { data: { projectId: project.id, charges: [] } })
    expect(cleared.status(), await cleared.text()).toBe(200)
  })

  test("Settings › Ticket charges sets the product an overflow is charged at, the set replaced whole; a completion naming none is charged at it", async ({ api, page }) => {
    const bulky = await productNamed(api, project, "Bulky waste pickup")
    await page.goto("/settings?pane=commercial-ticket-charges")
    await expect(page.getByRole("heading", { name: "Ticket charges" }).first()).toBeVisible()
    await page.getByLabel("Project", { exact: true }).click()
    await page.getByRole("option", { name: project.name, exact: true }).click()
    const charges = page.getByTestId("ticket-charges")
    await charges.getByRole("combobox", { name: "Overflow charged at" }).click()
    await page.getByRole("option", { name: bulky.name, exact: true }).click()
    const [saved] = await Promise.all([answerOf(page, "PUT", "/ticket-charges"), page.getByRole("button", { name: "Save charges" }).click()])
    expect(saved.status(), await saved.text()).toBe(200)
    expect(saved.request().postDataJSON()).toEqual({ projectId: project.id, charges: [{ kind: "overflow", productId: bulky.id }] })
    await expect(toasts(page)).toContainText(`One ticket kind is charged in ${project.name}.`)
    await expect(page.getByRole("button", { name: "Save charges" })).toBeDisabled()

    const { ticket } = await overflow(api, project, agreement)
    const completed = await api.post(`/tickets/${ticket.id}/complete`, { data: { resolution: "serviced", note: "Emptied again" } })
    expect(completed.status(), await completed.text()).toBe(200)
    expect(((await completed.json()) as ApiTicket).chargeProductId).toBeNull()
    expect((await eventOf(api, ticket)).productId).toBe(bulky.id)
  })

  test("a completion's Charged at names its own product, over the kind's, and the ticket's event is priced at it", async ({ api, page }) => {
    const [bulky, residual] = await Promise.all([productNamed(api, project, "Bulky waste pickup"), productNamed(api, project, "Residual waste · 240L bin")])
    const set = await api.put("/ticket-charges", { data: { projectId: project.id, charges: [{ kind: "overflow", productId: bulky.id }] } })
    expect(set.status(), await set.text()).toBe(200)
    const { ticket, subject } = await overflow(api, project, agreement)

    await page.goto(`/tickets?module=tickets&record=ticket-${ticket.id}`)
    const details = page.getByRole("dialog", { name: subject })
    const commands = details.getByTestId("ticket-commands")
    await expect(commands.getByRole("button", { name: "Complete" })).toBeEnabled({ timeout: 30_000 })
    await commands.getByRole("button", { name: "Complete" }).click()
    const complete = page.getByRole("dialog", { name: "Complete" })
    await pick(complete, page, "Resolution", "Serviced")
    await pick(complete, page, "Charged at", residual.name)
    await complete.getByRole("textbox", { name: /^How it was resolved/ }).fill("Emptied the residual bin again")
    const [answered] = await Promise.all([answerOf(page, "POST", `/tickets/${ticket.id}/complete`), complete.getByRole("button", { name: "Complete" }).click()])
    expect(answered.status(), await answered.text()).toBe(200)
    expect(answered.request().postDataJSON()).toEqual({ resolution: "serviced", note: "Emptied the residual bin again", productId: residual.id })
    expect(((await answered.json()) as ApiTicket).chargeProductId).toBe(residual.id)
    expect((await eventOf(api, ticket)).productId).toBe(residual.id)
  })
})
