// Container hire and work-order charges on the web (M14 of #293): a hire
// product's free days set in Settings › Commercial › Products; the product
// each of the office's work orders is charged at set in Settings › Commercial
// › Work order charges, replaced whole; a project's hires and jobs held for
// review from Settings › Finance & invoicing; and a ready event held for
// review with the office's reason, counted held by a run's preview, then
// released. What the settings change is put back, since a developer's stack
// is shared across runs; the event is uniquely made, on a day of its own.
import type { APIRequestContext, Locator, Page } from "@playwright/test"

import { uniqueName } from "./env"
import { expect, test } from "./fixtures"
import { answerOf, toasts } from "./routes-support"
import { listAll, projectNamed, type Project } from "./tester"

type Product = { id: string; name: string; unit: string; freeDays: number | null }
type Agreement = { id: string; number: string }
type BillableEvent = { id: string; status: string; hold: { at: string; by: string | null; reason: string } | null }

/** A dialog by its heading: the details sheet and a form dialog may both be open. */
const dialogTitled = (page: Page, title: string) => page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: title, exact: true }) })

/** Picks an option of a select field in a dialog by its label and the start of the option's. */
async function pick(dialog: Locator, page: Page, field: RegExp, option: RegExp) {
  await dialog.getByRole("combobox", { name: field }).click()
  await page.getByRole("option", { name: option }).first().click()
}

/** A product of the project made through the API, active, sold by the job and with a VAT rate: what a work order is charged at. */
async function jobProduct(api: APIRequestContext, project: Project, prefix: string): Promise<Product> {
  const name = uniqueName(prefix)
  const response = await api.post("/products", { data: { projectId: project.id, name, kind: "additional-service", status: "active", unit: "job", vatPercent: 25 } })
  expect(response.status(), await response.text()).toBe(201)
  return (await response.json()) as Product
}

/** A service date of this spec's own, in the past — a run is for a closed period — and inside the seeded agreement's and price list's periods; the specs that bill keep months of their own. */
function dayOfItsOwn(): string {
  const offset = Math.floor(Date.now() / 1000) % 59
  return new Date(Date.UTC(2026, 0, 1) + offset * 86_400_000).toISOString().slice(0, 10)
}

test.describe("container hire and work-order charges (#293 M14)", () => {
  let copenhagen: Project

  test.beforeEach(async ({ api }) => {
    copenhagen = await projectNamed(api, "Copenhagen Central")
  })

  test("Settings › Commercial › Products gives a product sold by the day its free days, a field offered for that unit alone", async ({ api, page }) => {
    const name = uniqueName("E2E Skip hire")
    const loaded = answerOf(page, "GET", "/products")
    await page.goto("/settings?pane=commercial-products")
    expect((await loaded).status()).toBe(200)
    await page.getByRole("button", { name: "New product" }).click()
    const dialog = dialogTitled(page, "New product")
    await pick(dialog, page, /^Project/, /^Copenhagen Central/)
    await dialog.getByLabel(/^Product name/).fill(name)
    await pick(dialog, page, /^Type/, /^Additional service/)
    await pick(dialog, page, /^Status/, /^Active/)
    await expect(dialog.getByLabel(/^Free days/)).toHaveCount(0)
    await pick(dialog, page, /^Unit/, /^Per day/)
    await dialog.getByLabel(/^Free days/).fill("7")
    await dialog.getByLabel(/^VAT rate/).fill("25")
    const [created] = await Promise.all([answerOf(page, "POST", "/products"), dialog.getByRole("button", { name: "Create product" }).click()])
    expect(created.status(), await created.text()).toBe(201)
    expect(created.request().postDataJSON()).toMatchObject({ unit: "day", freeDays: 7 })
    const product = (await created.json()) as Product
    expect(((await (await api.get(`/products/${product.id}`)).json()) as Product).freeDays).toBe(7)
  })

  test.describe("work order charges", () => {
    test.afterEach(async ({ api }) => {
      const cleared = await api.put("/work-order-charges", { data: { projectId: copenhagen.id, charges: [] } })
      expect(cleared.status(), await cleared.text()).toBe(200)
    })

    test("Settings › Commercial › Work order charges sets the product a wash is charged at, the set replaced whole", async ({ api, page }) => {
      const wash = await jobProduct(api, copenhagen, "E2E Container wash")
      await page.goto("/settings?pane=commercial-work-order-charges")
      await expect(page.getByRole("heading", { name: "Work order charges" }).first()).toBeVisible()
      await page.getByLabel("Project", { exact: true }).click()
      await page.getByRole("option", { name: copenhagen.name, exact: true }).click()
      const charges = page.getByTestId("work-order-charges")
      await charges.getByRole("combobox", { name: "Wash charged at" }).click()
      await page.getByRole("option", { name: wash.name, exact: true }).click()
      const [saved] = await Promise.all([answerOf(page, "PUT", "/work-order-charges"), page.getByRole("button", { name: "Save charges" }).click()])
      expect(saved.status(), await saved.text()).toBe(200)
      expect(saved.request().postDataJSON()).toEqual({ projectId: copenhagen.id, charges: [{ service: "wash", productId: wash.id }] })
      await expect(toasts(page)).toContainText(`One work order is charged in ${copenhagen.name}.`)
      await expect(page.getByRole("button", { name: "Save charges" })).toBeDisabled()
      const read = (await (await api.get(`/work-order-charges?projectId=${copenhagen.id}`)).json()) as { charges: { service: string; productId: string }[] }
      expect(read.charges).toEqual([{ service: "wash", productId: wash.id }])
    })
  })

  test.describe("hold for review", () => {
    let harbor: Project

    test.beforeEach(async ({ api }) => {
      harbor = await projectNamed(api, "Harbor Commercial")
    })

    test.afterEach(async ({ api }) => {
      const restored = await api.patch(`/projects/${harbor.id}`, { data: { holdForReview: false } })
      expect(restored.status(), await restored.text()).toBe(200)
    })

    test("Settings › Finance & invoicing holds a project's hires and jobs for review, the patch saying that alone", async ({ api, page }) => {
      await page.goto("/settings?pane=finance-invoicing")
      const row = page.getByRole("row").filter({ hasText: harbor.name })
      await expect(row).toContainText("Billed as charged")
      await row.getByRole("button", { name: `Edit ${harbor.name}'s terms` }).click()
      const dialog = dialogTitled(page, `${harbor.name}'s terms`)
      await dialog.getByRole("switch", { name: "Hold hires and jobs for review" }).click()
      const [patched] = await Promise.all([answerOf(page, "PATCH", `/projects/${harbor.id}`), dialog.getByRole("button", { name: "Save terms" }).click()])
      expect(patched.status(), await patched.text()).toBe(200)
      expect(patched.request().postDataJSON()).toEqual({ holdForReview: true })
      await expect(row).toContainText("Held for review")
      expect(((await (await api.get(`/projects/${harbor.id}`)).json()) as { holdForReview: boolean }).holdForReview).toBe(true)
    })
  })

  test("Billable events: a ready event held for review with the office's reason, which a run's preview counts held, then released to billing", async ({ api, page }) => {
    const agreement = (await listAll<Agreement>(api, "/agreements")).find((candidate) => candidate.number === "AGR-2408")
    if (agreement === undefined) throw new Error("the seed has no AGR-2408")
    const bulky = (await listAll<Product>(api, "/products", { projectId: copenhagen.id })).find((candidate) => candidate.name === "Bulky waste pickup")
    if (bulky === undefined) throw new Error("the seed has no Bulky waste pickup in Copenhagen")
    const day = dayOfItsOwn()
    const note = uniqueName("E2E held sofa")
    const made = await api.post("/billable-events", { data: { projectId: copenhagen.id, agreementId: agreement.id, productId: bulky.id, quantity: 1, serviceDate: day, note } })
    expect(made.status(), await made.text()).toBe(201)
    const event = (await made.json()) as BillableEvent
    expect(event.status).toBe("ready")

    const loaded = answerOf(page, "GET", "/billable-events")
    await page.goto(`/commercial?module=events&record=event-${event.id}`)
    expect((await loaded).status()).toBe(200)
    const details = page.getByRole("dialog").filter({ has: page.getByTestId("event-commands") })
    await expect(details.getByRole("button", { name: "Release to billing" })).toHaveCount(0)
    await details.getByRole("button", { name: "Hold for review" }).click()
    const hold = dialogTitled(page, "Hold for review")
    await hold.getByLabel(/^Why it is held/).fill("Waiting for the driver's photo of the sofa")
    const [held] = await Promise.all([answerOf(page, "POST", `/billable-events/${event.id}/hold`), hold.getByRole("button", { name: "Hold for review" }).click()])
    expect(held.status(), await held.text()).toBe(200)
    expect(held.request().postDataJSON()).toEqual({ reason: "Waiting for the driver's photo of the sofa" })
    expect(((await held.json()) as BillableEvent).hold?.reason).toBe("Waiting for the driver's photo of the sofa")
    await expect(details.getByText(/Waiting for the driver's photo of the sofa/).first()).toBeVisible()
    await expect(details.getByRole("button", { name: "Hold for review" })).toHaveCount(0)

    // A run's preview over the day passes over it, and says so.
    const preview = await api.post("/billing-runs/preview", { data: { projectId: copenhagen.id, periodFrom: day, periodTo: day } })
    expect(preview.status(), await preview.text()).toBe(200)
    expect(((await preview.json()) as { heldEventCount: number }).heldEventCount).toBeGreaterThanOrEqual(1)

    await details.getByRole("button", { name: "Release to billing" }).click()
    const release = dialogTitled(page, "Release to billing")
    const [released] = await Promise.all([answerOf(page, "POST", `/billable-events/${event.id}/release`), release.getByRole("button", { name: "Release to billing" }).click()])
    expect(released.status(), await released.text()).toBe(200)
    expect((await released.json()) as BillableEvent).toMatchObject({ status: "ready", hold: null })
    await expect(details.getByRole("button", { name: "Hold for review" })).toBeVisible()

    // Left ready on a day of its own, it is cancelled so no later run of the day invoices it.
    const cancelled = await api.post(`/billable-events/${event.id}/cancel`, { data: { reason: "other", note: "E2E hold for review" } })
    expect(cancelled.status(), await cancelled.text()).toBe(200)
  })
})
