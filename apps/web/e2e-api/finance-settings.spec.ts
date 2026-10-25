// Finance settings on the web (#291 C4w): on the Pilot, Settings › Finance &
// invoicing is the API's — the company's invoice identity, saved through
// `PATCH /company` as the wire spells it, and each project's payment terms
// and reference scheme through `PATCH /projects/:id` — and a link to the
// browser's pane opens it. A FIK scheme is not offered before the company
// has a creditor number, and a malformed code is refused before the API is
// asked. A customer's own terms are its form's. The company and the project
// are put back afterwards, the project first, since the API refuses to clear
// the creditor number while a project's invoices name it.
import { uniqueName } from "./env"
import { expect, test } from "./fixtures"
import { answerOf, toasts } from "./routes-support"
import { projectNamed, type Project } from "./tester"

type Company = { vatNumber: string | null; bankIban: string | null; bankBic: string | null; fikCreditorNumber: string | null }
type ApiProject = Project & { paymentTermsDays: number; paymentReferenceScheme: string }
type Customer = { id: string; name: string; paymentTermsDays: number | null }

const NO_IDENTITY: Company = { vatNumber: null, bankIban: null, bankBic: null, fikCreditorNumber: null }

test.describe("finance settings (#291 C4)", () => {
  let harbor: Project

  test.beforeEach(async ({ api }) => {
    harbor = await projectNamed(api, "Harbor Commercial")
  })

  test.afterEach(async ({ api }) => {
    const project = await api.patch(`/projects/${harbor.id}`, { data: { paymentTermsDays: 30, paymentReferenceScheme: "none" } })
    expect(project.status(), await project.text()).toBe(200)
    const company = await api.patch("/company", { data: NO_IDENTITY })
    expect(company.status(), await company.text()).toBe(200)
  })

  test("a link to the browser's Finance pane opens the API's; without a creditor number no FIK scheme is offered, and a malformed IBAN is refused before the API", async ({ page }) => {
    await page.goto("/settings?pane=finance")
    await expect(page.getByRole("heading", { name: "Finance & invoicing" }).first()).toBeVisible()
    await expect(page.getByRole("heading", { name: "Invoice identity" })).toBeVisible()

    await page.getByLabel("IBAN", { exact: true }).fill("DK50")
    await expect(page.getByText("An IBAN is its country's two letters, two check digits and the account, as DK5000400440116243")).toBeVisible()
    await expect(page.getByRole("button", { name: "Save identity" })).toBeDisabled()

    await page.getByRole("button", { name: "Edit Harbor Commercial's terms" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog.getByText("Set the company's FIK creditor number above to use a FIK scheme.")).toBeVisible()
    await dialog.getByRole("combobox", { name: "Payment reference" }).click()
    await expect(page.getByRole("option", { name: "FIK 71" })).toBeDisabled()
    await expect(page.getByRole("option", { name: "None" })).toBeEnabled()
  })

  test("the company's identity is saved as the wire spells it, and a project's terms and FIK scheme read back in its row", async ({ api, page }) => {
    await page.goto("/settings?pane=finance-invoicing")
    await page.getByLabel("VAT number", { exact: true }).fill("dk 1234 5678")
    await page.getByLabel("IBAN", { exact: true }).fill("dk50 0040 0440 1162 43")
    await page.getByLabel("BIC", { exact: true }).fill("dabadkkk")
    await page.getByLabel("FIK creditor number", { exact: true }).fill("8512 3456")
    const [saved] = await Promise.all([answerOf(page, "PATCH", "/company"), page.getByRole("button", { name: "Save identity" }).click()])
    expect(saved.status(), await saved.text()).toBe(200)
    expect(saved.request().postDataJSON()).toEqual({ vatNumber: "DK12345678", bankIban: "DK5000400440116243", bankBic: "DABADKKK", fikCreditorNumber: "85123456" })
    await expect(toasts(page)).toContainText("Invoice identity saved")
    expect(((await (await api.get("/company")).json()) as Company).fikCreditorNumber).toBe("85123456")
    // The form starts again from what the API answered.
    await expect(page.getByLabel("IBAN", { exact: true })).toHaveValue("DK5000400440116243")

    await page.getByRole("button", { name: "Edit Harbor Commercial's terms" }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByLabel("Payment terms (days)").fill("400")
    await expect(dialog.getByText("Payment terms are a whole number of days from 0 to 365")).toBeVisible()
    await dialog.getByLabel("Payment terms (days)").fill("14")
    await dialog.getByRole("combobox", { name: "Payment reference" }).click()
    await page.getByRole("option", { name: "FIK 71" }).click()
    const [patched] = await Promise.all([answerOf(page, "PATCH", `/projects/${harbor.id}`), dialog.getByRole("button", { name: "Save terms" }).click()])
    expect(patched.status(), await patched.text()).toBe(200)
    expect(patched.request().postDataJSON()).toEqual({ paymentTermsDays: 14, paymentReferenceScheme: "fik-71" })
    await expect(toasts(page)).toContainText("Harbor Commercial's next invoices follow them.")
    const row = page.getByRole("row").filter({ hasText: "Harbor Commercial" })
    await expect(row).toContainText("14 days")
    await expect(row).toContainText("FIK 71")
    expect((await (await api.get(`/projects/${harbor.id}`)).json()) as ApiProject).toMatchObject({ paymentTermsDays: 14, paymentReferenceScheme: "fik-71" })

    // The creditor number a project's invoices name is not cleared under it: the API's sentence, the identity kept.
    await page.getByLabel("FIK creditor number", { exact: true }).fill("")
    const [refused] = await Promise.all([answerOf(page, "PATCH", "/company"), page.getByRole("button", { name: "Save identity" }).click()])
    expect(refused.status()).toBe(409)
    expect(((await (await api.get("/company")).json()) as Company).fikCreditorNumber).toBe("85123456")
  })

  test("a customer created with terms of its own carries them", async ({ api, page }) => {
    const name = uniqueName("E2E Terms Organisation")
    const loaded = answerOf(page, "GET", "/customers")
    await page.goto("/customers?module=contacts")
    expect((await loaded).status()).toBe(200)
    await page.getByRole("button", { name: "Create party" }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByRole("combobox", { name: /^Party type/ }).click()
    await page.getByRole("option", { name: "Company or organization" }).click()
    await dialog.getByLabel("Display or legal name").fill(name)
    await dialog.getByLabel("Organization identifier").fill(`${Date.now() % 10_000}`.padStart(4, "0") + `${Math.floor(Math.random() * 10_000)}`.padStart(4, "0"))
    await dialog.getByLabel("Payment terms (days)").fill("8")
    await dialog.getByRole("combobox", { name: /^Role/ }).click()
    await page.getByRole("option", { name: "Customer", exact: true }).click()
    await dialog.getByLabel("Relationship effective from").fill("2026-10-01")
    const [created] = await Promise.all([answerOf(page, "POST", "/customers"), dialog.getByRole("button", { name: "Create party" }).click()])
    expect(created.status(), await created.text()).toBe(201)
    const body = (await created.json()) as Customer
    expect(body).toMatchObject({ name, paymentTermsDays: 8 })
    expect(((await (await api.get(`/customers/${body.id}`)).json()) as Customer).paymentTermsDays).toBe(8)
  })
})
