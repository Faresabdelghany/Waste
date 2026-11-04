// Portals & branding on the web (#487): on the Pilot the pane is the API's —
// each project's public pages under its `publicSlug`, published and closed
// through `PATCH /projects/:id`, and how many of its drivers may sign in to
// the Driver App — and a link to the browser's pane opens it. The fixtures'
// customer portal is not shown to a signed-in API user; a project's branding
// (M22 of #293) is set there, its colour held to WCAG 2.1 AA. The
// project is put back as it was found.
import { expect, test } from "./fixtures"
import { answerOf, toasts } from "./routes-support"
import { projectNamed, type Project } from "./tester"

test.describe("portals & branding (#487)", () => {
  let harbor: Project
  let before: string | null

  test.beforeEach(async ({ api }) => {
    harbor = await projectNamed(api, "Harbor Commercial")
    before = ((await (await api.get(`/projects/${harbor.id}`)).json()) as { publicSlug: string | null }).publicSlug
    if (before !== null) expect((await api.patch(`/projects/${harbor.id}`, { data: { publicSlug: null } })).status()).toBe(200)
  })

  test.afterEach(async ({ api }) => {
    expect((await api.patch(`/projects/${harbor.id}`, { data: { publicSlug: before } })).status()).toBe(200)
  })

  test("a link to the browser's pane opens the API's: a project is published under its address, its pages linked, and closed again; no fixture portal is shown", async ({ api, page }) => {
    await page.goto("/settings?pane=portals")
    await expect(page.getByRole("heading", { name: "Portals & branding" }).first()).toBeVisible()
    await expect(page.getByText("Copenhagen Customer Portal")).toHaveCount(0)
    await expect(page.getByText("1,408 authorized users")).toHaveCount(0)

    const row = page.getByRole("row").filter({ hasText: "Harbor Commercial" })
    await expect(row).toContainText("Not published")
    await expect(row).toContainText(/driver|No drivers/)

    await row.getByRole("button", { name: "Publish Harbor Commercial" }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByLabel("Public address").fill("Not A Slug")
    await expect(dialog.getByRole("button", { name: "Publish" })).toBeDisabled()
    const slug = `e2e-harbor-${Date.now().toString(36)}`
    await dialog.getByLabel("Public address").fill(slug)
    const [published] = await Promise.all([answerOf(page, "PATCH", `/projects/${harbor.id}`), dialog.getByRole("button", { name: "Publish" }).click()])
    expect(published.status(), await published.text()).toBe(200)
    expect(published.request().postDataJSON()).toMatchObject({ publicSlug: slug })
    await expect(toasts(page)).toContainText("Public pages published")
    await expect(row).toContainText(`Published at /p/${slug}`)
    for (const [label, path] of [["Collection days", "calendar"], ["Drop-off points", "drop-off"], ["Sorting guide", "sorting"]] as const) {
      await expect(row.getByRole("link", { name: label })).toHaveAttribute("href", `/p/${slug}/${path}`)
    }
    expect(((await (await api.get(`/projects/${harbor.id}`)).json()) as { publicSlug: string | null }).publicSlug).toBe(slug)

    const [closed] = await Promise.all([answerOf(page, "PATCH", `/projects/${harbor.id}`), row.getByRole("button", { name: "Unpublish Harbor Commercial" }).click()])
    expect(closed.status(), await closed.text()).toBe(200)
    await expect(row).toContainText("Not published")
    expect(((await (await api.get(`/projects/${harbor.id}`)).json()) as { publicSlug: string | null }).publicSlug).toBe(null)
  })
  test("a project's branding (M22 of #293) is set in the pane: a colour white text fails on is refused before the API, and the branding is written whole through its own route and read back", async ({ api, page }) => {
    const none = { brandColor: null, logoUrl: null, accessibilityStatementUrl: null }
    try {
      await page.goto("/settings?pane=portals")
      const row = page.getByRole("row").filter({ hasText: "Harbor Commercial" })
      await row.getByRole("button", { name: "Edit Harbor Commercial's branding" }).click()
      const dialog = page.getByRole("dialog")
      await dialog.getByLabel("Brand colour").fill("#ffd700")
      await expect(dialog.getByText(/White text on #ffd700 has a contrast of .* WCAG 2\.1 AA needs 4\.5 to 1/)).toBeVisible()
      await expect(dialog.getByRole("button", { name: "Save branding" })).toBeDisabled()
      await dialog.getByLabel("Brand colour").fill("#1F6F3F")
      await expect(dialog.getByText("Contrast with white text 6.17 to 1 — meets WCAG 2.1 AA")).toBeVisible()
      await expect(dialog.getByTestId("branding-preview")).toHaveText("Harbor Commercial")
      await dialog.getByLabel("Logo address").fill("http://kk.dk/logo.svg")
      await expect(dialog.getByText("An address is https, as https://kk.dk/logo.svg")).toBeVisible()
      await dialog.getByLabel("Logo address").fill("https://kk.dk/logo.svg")
      await dialog.getByLabel("Accessibility statement address").fill("https://was.digst.dk/harbor")
      const [saved] = await Promise.all([answerOf(page, "PUT", `/projects/${harbor.id}/branding`), dialog.getByRole("button", { name: "Save branding" }).click()])
      expect(saved.status(), await saved.text()).toBe(200)
      expect(saved.request().postDataJSON()).toEqual({ brandColor: "#1f6f3f", logoUrl: "https://kk.dk/logo.svg", accessibilityStatementUrl: "https://was.digst.dk/harbor" })
      await expect(toasts(page)).toContainText("Branding saved")
      await expect(row).toContainText("#1f6f3f · Logo · Accessibility statement")
      expect(((await (await api.get(`/projects/${harbor.id}`)).json()) as { branding: unknown }).branding).toEqual({ brandColor: "#1f6f3f", logoUrl: "https://kk.dk/logo.svg", accessibilityStatementUrl: "https://was.digst.dk/harbor" })
    } finally {
      expect((await api.put(`/projects/${harbor.id}/branding`, { data: none })).status()).toBe(200)
    }
  })
})
