import { accessTokenOf, apiAs, expect, freshContext, signIn, test } from "./fixtures"
import { E2E } from "./env"
import { ensureTester } from "./tester"

// Scenario 2: a grant refused in-session. The tester's role, Route Planner,
// reads the customers but has no grant on the organisation, so when the
// record store loads the switched modules after sign-in the API answers
// `about:blank` 403 for Company & Projects, and the person is told in the
// API's own words (business-record-store.tsx, `reportProblem`) — while the
// session stays open: authentication and authorization are apart
// (lib/api/session.ts), and only the account's own refusal ends a session.
test("a role without the grant is refused in the API's words and stays signed in", async ({ api, browser }) => {
  await ensureTester(api, E2E.testerEmail)

  const context = await freshContext(browser)
  try {
    const page = await context.newPage()
    await signIn(page, E2E.testerEmail, E2E.loginPassword)
    await page.goto("/customers?module=contacts")
    await expect(page.getByText("configure.organization could not be read from the API")).toBeVisible()
    await expect(page.getByText("This account's role does not allow view on configure.organization")).toBeVisible()

    // Still here, still signed in: the page was not sent to /login, and the token the browser holds is still taken.
    await expect(page).toHaveURL(/\/customers/)
    const token = await accessTokenOf(context)
    expect(token).not.toBeNull()
    const tester = await apiAs(token as string)
    try {
      const me = await tester.get("/me")
      expect(me.status()).toBe(200)
      const customers = await tester.get("/customers", { params: { limit: 1 } })
      expect(customers.status()).toBe(200)
      const projects = await tester.get("/projects", { params: { limit: 1 } })
      expect(projects.status()).toBe(403)
      expect(await projects.json()).toMatchObject({ type: "about:blank", status: 403, detail: "This account's role does not allow view on configure.organization" })
    } finally {
      await tester.dispose()
    }
  } finally {
    await context.close()
  }
})
