import { API_SESSION_STORAGE_KEY } from "../lib/storage-keys"
import { accessTokenOf, expect, freshContext, signIn, test } from "./fixtures"
import { E2E } from "./env"
import { ensureTester } from "./tester"

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
// The tester is reactivated afterwards whatever happened, since the other
// specs sign in as it.
test.describe("the account's refusal ends the session", () => {
  test("the next API call after a deactivation ends the session, and /login shows the API's sentence", async ({ api, browser }) => {
    const { user } = await ensureTester(api, E2E.testerEmail)
    const context = await freshContext(browser)
    try {
      const page = await context.newPage()
      await signIn(page, E2E.testerEmail, E2E.loginPassword)
      await expect(page).toHaveURL(/\/operate/)

      const deactivated = await api.post(`/users/${user.id}/deactivate`)
      expect(deactivated.status(), await deactivated.text()).toBe(200)

      // A page whose modules the record store reads from the API: the first call is refused, and the session goes with it.
      await page.goto("/customers?module=contacts")
      await expect(page).toHaveURL(/\/login$/)
      await expect(page.locator("main").getByRole("alert")).toHaveText("No active account in this company is bound to this login")
      expect(await accessTokenOf(context), "the stored session is gone").toBeNull()
    } finally {
      const reactivated = await api.post(`/users/${user.id}/reactivate`)
      expect(reactivated.status(), await reactivated.text()).toBe(200)
      await context.close()
    }
  })

  test("a refresh Auth refuses for the deactivated account ends the session the same way, in Auth's words", async ({ api, browser }) => {
    const { user } = await ensureTester(api, E2E.testerEmail)
    const context = await freshContext(browser)
    try {
      const page = await context.newPage()
      await signIn(page, E2E.testerEmail, E2E.loginPassword)
      await expect(page).toHaveURL(/\/operate/)

      const deactivated = await api.post(`/users/${user.id}/deactivate`)
      expect(deactivated.status(), await deactivated.text()).toBe(200)

      // The access token about to run out, as a tab finds it after the hour:
      // the provider refreshes on its next load, no API call goes out under
      // the expiring token, and the hook refuses the refresh for the account.
      await page.evaluate((key) => {
        const raw = window.localStorage.getItem(key)
        if (raw === null) throw new Error("no stored session to age")
        const stored = JSON.parse(raw) as { expiresAt: number }
        window.localStorage.setItem(key, JSON.stringify({ ...stored, expiresAt: Date.now() }))
      }, API_SESSION_STORAGE_KEY)
      await page.reload()
      await expect(page).toHaveURL(/\/login$/)
      await expect(page.locator("main").getByRole("alert")).toContainText(/deactivated/)
      expect(await accessTokenOf(context), "the stored session is gone").toBeNull()
    } finally {
      const reactivated = await api.post(`/users/${user.id}/reactivate`)
      expect(reactivated.status(), await reactivated.text()).toBe(200)
      await context.close()
    }
  })

  test("reactivated, the account signs in again and is whole", async ({ api, browser }) => {
    await ensureTester(api, E2E.testerEmail)
    const context = await freshContext(browser)
    try {
      const page = await context.newPage()
      await signIn(page, E2E.testerEmail, E2E.loginPassword)
      await expect(page).toHaveURL(/\/operate/)
    } finally {
      await context.close()
    }
  })
})
