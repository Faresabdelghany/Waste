// Privacy, audit & retention on the web (#487): on the Pilot the pane is the
// API's — the company's whole history, read from `GET /audit-events` with no
// row, newest first, each request one entry with who made it and the reason
// it was given — and a link to the browser's pane opens it. The browser's
// fixture policies are not shown to a signed-in API user; each project's own
// privacy policy (#291 C19) is, read with the project and written whole
// through `PUT /projects/:id/privacy-policy`. The project is put back as it
// was found.
import { uniqueName } from "./env"
import { expect, test } from "./fixtures"
import { answerOf, toasts } from "./routes-support"
import { projectNamed } from "./tester"

const NO_POLICY = { positionRetentionDays: null, proofRetentionDays: null, gpsPurpose: null }

test.describe("privacy, audit & retention (#487)", () => {
  test("a link to the browser's pane opens the API's: the company's history names the change, who made it and why, and no fixture policy is shown", async ({ api, page }) => {
    const name = uniqueName("E2E Audited Organisation")
    const reason = uniqueName("Signed up at the counter")
    const created = await api.post("/customers", { data: { kind: "organisation", name }, headers: { "waste-change-reason": encodeURIComponent(reason) } })
    expect(created.status(), await created.text()).toBe(201)

    const [read] = await Promise.all([answerOf(page, "GET", "/audit-events"), page.goto("/settings?pane=privacy")])
    expect(read.status(), await read.text()).toBe(200)
    expect(new URL(read.url()).searchParams.has("table"), "the company's whole history names no row").toBe(false)
    await expect(page.getByRole("heading", { name: "Privacy, audit & retention" }).first()).toBeVisible()
    await expect(page.getByText("Immutable audit history")).toBeVisible()
    await expect(page.getByText("Permitted GPS purpose")).toHaveCount(0)
    await expect(page.getByText("GPS retention")).toHaveCount(0)

    const entry = page.getByRole("list", { name: "Audit history" }).getByRole("listitem").filter({ hasText: `Reason: ${reason}` })
    await expect(entry).toHaveCount(1)
    await expect(entry).toContainText(/Created customer/)

    // Refresh asks again, and the entry is still there.
    const [again] = await Promise.all([answerOf(page, "GET", "/audit-events"), page.getByRole("button", { name: "Refresh" }).click()])
    expect(again.status()).toBe(200)
    await expect(entry).toHaveCount(1)
  })
  test("a project's privacy policy (#291 C19) is set in the pane, written whole through its own route and read back; a period out of bounds is refused before the API", async ({ api, page }) => {
    const harbor = await projectNamed(api, "Harbor Commercial")
    try {
      await page.goto("/settings?pane=privacy-audit")
      const row = page.getByRole("table", { name: "Retention by project" }).getByRole("row").filter({ hasText: "Harbor Commercial" })
      await expect(row).toContainText("Deployment setting")
      await expect(row).toContainText("Not declared")

      await row.getByRole("button", { name: "Edit Harbor Commercial's privacy policy" }).click()
      const dialog = page.getByRole("dialog")
      await dialog.getByLabel("Positions kept (days)").fill("31")
      await expect(dialog.getByText("Positions are kept a whole number of days from 1 to 30")).toBeVisible()
      await expect(dialog.getByRole("button", { name: "Save policy" })).toBeDisabled()
      await dialog.getByLabel("Positions kept (days)").fill("14")
      await dialog.getByLabel("Photos and signatures kept (days)").fill("365")
      await dialog.getByRole("combobox", { name: "GPS purpose" }).click()
      await page.getByRole("option", { name: "Dispatch and proof of service" }).click()
      const [saved] = await Promise.all([answerOf(page, "PUT", `/projects/${harbor.id}/privacy-policy`), dialog.getByRole("button", { name: "Save policy" }).click()])
      expect(saved.status(), await saved.text()).toBe(200)
      expect(saved.request().postDataJSON()).toEqual({ positionRetentionDays: 14, proofRetentionDays: 365, gpsPurpose: "dispatch-and-proof" })
      await expect(toasts(page)).toContainText("Privacy policy saved")
      await expect(row).toContainText("14 days")
      await expect(row).toContainText("365 days")
      await expect(row).toContainText("Dispatch and proof of service")
      expect(((await (await api.get(`/projects/${harbor.id}`)).json()) as { privacyPolicy: unknown }).privacyPolicy).toEqual({ positionRetentionDays: 14, proofRetentionDays: 365, gpsPurpose: "dispatch-and-proof" })
    } finally {
      expect((await api.put(`/projects/${harbor.id}/privacy-policy`, { data: NO_POLICY })).status()).toBe(200)
    }
  })
})
