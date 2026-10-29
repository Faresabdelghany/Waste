import AxeBuilder from "@axe-core/playwright"
import type { Page as BrowserPage } from "@playwright/test"

import { expect, freshContext, test } from "./fixtures"

// A published project's branding on its public pages (M22 of #293), and
// every public page held to WCAG 2.1 A and AA by axe. The administrator
// publishes the seeded Copenhagen Central under an address of the run's own
// and sets its branding through the API. A visitor with no session then reads
// each page — the Sorting Guide with an answer, the Collection Days search,
// an address's days and the widget of both, the Drop-off Points — and finds
// the project's name on its colour beside its logo and the accessibility
// statement at the foot, with no violation axe can find. Its branding cleared,
// the pages read as before, again with none. The logo's address is answered
// here, so the run asks nothing of the internet. The project goes back
// unpublished and unbranded whatever happens.

type Project = { id: string; name: string }
type Listed<T> = { items: T[] }

const BRANDING = { brandColor: "#1f6f3f", logoUrl: "https://logo.e2e.example/kystbyen.svg", accessibilityStatementUrl: "https://kommune.e2e.example/tilgaengelighed" }
const UNBRANDED = { brandColor: null, logoUrl: null, accessibilityStatementUrl: null }
const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="64" height="32" fill="#ffffff"/></svg>`
/** What axe holds each page to: WCAG 2.0 and 2.1, A and AA. */
const WCAG_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]

/** Every violation axe finds on the page, by rule and the elements it names; none is the page passing. */
async function violationsOf(page: BrowserPage): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_AA).analyze()
  return violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`)
}

test("a published project's pages carry its colour, logo and accessibility statement, and every public page passes axe's WCAG 2.1 AA, branded or not", async ({ api, browser }) => {
  const listed = await api.get("/projects", { params: { limit: 200 } })
  expect(listed.status()).toBe(200)
  const project = ((await listed.json()) as Listed<Project>).items.find((candidate) => candidate.name === "Copenhagen Central")
  if (project === undefined) throw new Error("the seed holds no Copenhagen Central")
  const slug = `e2e-branding-${Date.now().toString(36)}`
  expect((await api.patch(`/projects/${project.id}`, { data: { publicSlug: slug } })).status()).toBe(200)

  const visitor = await freshContext(browser)
  await visitor.route("https://logo.e2e.example/**", (route) => route.fulfill({ status: 200, contentType: "image/svg+xml", body: LOGO }))
  try {
    const reader = await visitor.newPage()
    // The address the widget and the full page read: the search's first match.
    await reader.goto(`/p/${slug}/calendar?q=Strandboulevarden`)
    const firstAddress = reader.getByRole("main").getByRole("listitem").getByRole("link").first()
    await expect(firstAddress).toBeVisible()
    const addressPath = new URL(await firstAddress.evaluate((link) => (link as HTMLAnchorElement).href)).pathname
    const addressId = addressPath.split("/").at(-1) ?? ""

    const pages = [
      `/p/${slug}/sorting?q=glas`,
      `/p/${slug}/calendar?q=Strandboulevarden`,
      `/p/${slug}/calendar/${addressId}`,
      `/p/${slug}/calendar/embed?q=Strandboulevarden`,
      `/p/${slug}/calendar/embed/${addressId}`,
      `/p/${slug}/drop-off`,
    ]

    expect((await api.put(`/projects/${project.id}/branding`, { data: BRANDING })).status()).toBe(200)
    for (const path of pages) {
      await reader.goto(path)
      const mark = reader.getByTestId("project-mark")
      await expect(mark, path).toContainText("Copenhagen Central")
      await expect(mark, path).toHaveCSS("background-color", "rgb(31, 111, 63)")
      await expect(mark, path).toHaveCSS("color", "rgb(255, 255, 255)")
      await expect(mark.locator("img"), path).toHaveAttribute("src", BRANDING.logoUrl)
      await expect(reader.getByRole("link", { name: "Accessibility statement" }), path).toHaveAttribute("href", BRANDING.accessibilityStatementUrl)
      expect(await violationsOf(reader), `${path}, branded`).toEqual([])
    }

    expect((await api.put(`/projects/${project.id}/branding`, { data: UNBRANDED })).status()).toBe(200)
    for (const path of pages) {
      await reader.goto(path)
      const mark = reader.getByTestId("project-mark")
      await expect(mark, path).toContainText("Copenhagen Central")
      await expect(mark.locator("img"), path).toHaveCount(0)
      await expect(reader.getByRole("link", { name: "Accessibility statement" }), path).toHaveCount(0)
      expect(await violationsOf(reader), `${path}, unbranded`).toEqual([])
    }
  } finally {
    await visitor.close()
    await api.put(`/projects/${project.id}/branding`, { data: UNBRANDED })
    await api.patch(`/projects/${project.id}`, { data: { publicSlug: null } })
  }
})
