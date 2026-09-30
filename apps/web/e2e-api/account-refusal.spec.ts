import type { APIRequestContext, BrowserContext, Page } from "@playwright/test"

import { API_SESSION_STORAGE_KEY } from "../lib/storage-keys"
import { accessTokenOf, apiAs, chainLanded, expect, freshContext, signIn, test as base } from "./fixtures"
import { E2E } from "./env"
import { ensureTester, TESTER_PROJECT, TESTER_ROLE, type User } from "./tester"

// The account-level refusal (#150; #151's second slice): unlike a grant
// refused in-session (grant-refusal.spec.ts), the refusal of the account
// itself ends the session, and /login says why in the words of whoever
// refused it (lib/api/session.ts, `ended.reason === "refused"`). It arrives
// two ways, both from the administrator deactivating the account through the
// API — the operation Users & roles runs since #163 — while the person is
// signed in:
//
//   the API's     — the next call the browser makes meets the one problem type
//                   beyond `about:blank`, `urn:waste:problem:no-active-account`,
//                   since the API looks the caller up on every request; the
//                   client ends the session before the error is thrown, and
//                   the gate sends the tab to bare /login, carrying no `next`;
//   Auth's        — a refresh the access token hook refuses, since it runs on
//                   every token issue: "This account is deactivated" comes
//                   back as the grant's error, and a 4xx at refresh ends the
//                   session in that sentence.
//
// The deactivation is a fixture's, so the reactivation is its teardown: it
// runs on a failure and on a timeout alike, with a budget of its own, since
// every other spec signs in as the tester. The browser context is closed
// whatever the reactivation answered.

type Deactivated = {
  /** The tester's page, signed in through the form and landed, its account then deactivated by the administrator. */
  page: Page
  context: BrowserContext
  user: User
}

const test = base.extend<{ deactivated: Deactivated }>({
  deactivated: async ({ api, browser }, use) => {
    const { user } = await ensureTester(api, E2E.testerEmail)
    const context = await freshContext(browser)
    let deactivatedAt: number | null = null
    try {
      const page = await context.newPage()
      await signIn(page, E2E.testerEmail, E2E.loginPassword)
      await expect(page).toHaveURL(/\/operate/)
      // The store's module reads must have landed before the account goes:
      // a read still in flight would meet the refusal first and end the
      // session before the test asks for it (#180 lengthened the chain).
      await chainLanded(page)
      const deactivated = await api.post(`/users/${user.id}/deactivate`)
      expect(deactivated.status(), await deactivated.text()).toBe(200)
      deactivatedAt = Date.now()
      await use({ page, context, user })
    } finally {
      let reactivation: string | null = null
      if (deactivatedAt !== null) {
        const reactivated = await api.post(`/users/${user.id}/reactivate`)
        if (reactivated.status() !== 200) reactivation = `reactivating the tester answered ${reactivated.status()}: ${await reactivated.text()}`
      }
      await context.close()
      if (reactivation !== null) throw new Error(reactivation)
    }
  },
})

test.describe("the account's refusal ends the session", () => {
  test("the next API call after a deactivation is refused, the session ends, and /login shows the API's sentence", async ({ deactivated: { page, context } }) => {
    // A full navigation: the first call the page makes is the provider's own `GET /me`, and it is the one refused.
    const me = page.waitForResponse((response) => new URL(response.url()).pathname === "/waste-api/me")
    await page.goto("/customers?module=contacts")
    const refused = await me
    expect(refused.status()).toBe(403)
    expect(await refused.json()).toMatchObject({ type: "urn:waste:problem:no-active-account", status: 403 })

    await expect(page).toHaveURL(/\/login$/)
    await expect(page.locator("main").getByRole("alert")).toHaveText("No active account in this company is bound to this login")
    expect(await accessTokenOf(context), "the stored session is gone").toBeNull()
  })

  test("a refresh Auth refuses for the deactivated account ends the session the same way, in Auth's words", async ({ deactivated: { page, context } }) => {
    // The access token about to run out, as a tab finds it after the hour:
    // the provider refreshes on its next load, no API call goes out under
    // the expiring token, and the hook refuses the refresh for the account.
    await page.evaluate((key) => {
      const raw = window.localStorage.getItem(key)
      if (raw === null) throw new Error("no stored session to age")
      const stored = JSON.parse(raw) as { expiresAt: number }
      window.localStorage.setItem(key, JSON.stringify({ ...stored, expiresAt: Date.now() }))
    }, API_SESSION_STORAGE_KEY)
    const refresh = page.waitForResponse((response) => new URL(response.url()).pathname === "/auth/v1/token" && new URL(response.url()).searchParams.get("grant_type") === "refresh_token")
    await page.reload()
    expect((await refresh).status()).toBe(403)

    await expect(page).toHaveURL(/\/login$/)
    await expect(page.locator("main").getByRole("alert")).toContainText(/deactivated/)
    expect(await accessTokenOf(context), "the stored session is gone").toBeNull()
  })

  test("reactivated, the account signs in again whole: its role, its one project, its status", async ({ api, browser }) => {
    const { user } = await ensureTester(api, E2E.testerEmail)
    const context = await freshContext(browser)
    let tester: APIRequestContext | null = null
    try {
      const page = await context.newPage()
      await signIn(page, E2E.testerEmail, E2E.loginPassword)
      await expect(page).toHaveURL(/\/operate/)
      const token = await accessTokenOf(context)
      expect(token).not.toBeNull()
      tester = await apiAs(token as string)
      const me = await tester.get("/me")
      expect(me.status()).toBe(200)
      const body = (await me.json()) as { role: { name: string }; projects: { name: string }[] }
      expect(body.role.name).toBe(TESTER_ROLE)
      expect(body.projects.map((project) => project.name)).toEqual([TESTER_PROJECT])
      const read = await api.get(`/users/${user.id}`)
      expect(read.status()).toBe(200)
      expect(await read.json()).toMatchObject({ status: "active", deactivatedAt: null })
    } finally {
      await tester?.dispose()
      await context.close()
    }
  })
})
