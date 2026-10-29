// Privacy, audit & retention on the web (#487): on the Pilot the pane is the
// API's — the company's whole history, read from `GET /audit-events` with no
// row, newest first, each request one entry with who made it and the reason
// it was given — and a link to the browser's pane opens it. The browser's
// GPS purpose and retention policies (C19's, #381, with no API yet) are not
// shown to a signed-in API user.
import { uniqueName } from "./env"
import { expect, test } from "./fixtures"
import { answerOf } from "./routes-support"

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
})
