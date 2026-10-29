import { expect, freshContext, signIn, test } from "./fixtures"
import { dispatchedRouteFor, SEEDED_DRIVER } from "./dispatched-route"
import { E2E } from "./env"

// Offline reading (O25 of #290) on a phone-sized browser against the real
// door: the seeded driver opens the route the office dispatched, the phone
// loses its signal, and a reload still shows the day — the start screen and
// the route's stops as the server last answered them, each marked as that
// answer and when — through the app shell's service worker and the display
// cache. Back online, the live read replaces the kept one and its mark.

test("a driver reads their route with no signal, marked as the server's last answer, and the live read takes over once back online", async ({ api, browser }) => {
  test.setTimeout(120_000)
  const { route } = await dispatchedRouteFor(api)
  const context = await freshContext(browser, { viewport: { width: 390, height: 844 }, serviceWorkers: "allow" })
  try {
    const page = await context.newPage()
    await signIn(page, SEEDED_DRIVER.email, E2E.loginPassword)
    await expect(page).toHaveURL(/\/driver$/)
    const card = page.getByRole("article", { name: `Route ${route.label}` })
    await expect(card).toBeVisible()
    // The shell's worker is in place, and the app opened as a driver opens it, so the worker answers its pages.
    await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration("/driver"))?.active?.state), { timeout: 15_000 }).toBe("activated")
    await page.goto("/driver")
    await card.getByRole("link", { name: "Open route" }).click()
    await expect(page).toHaveURL(new RegExp(`/driver/routes/${route.id}$`))
    const stops = page.getByRole("article", { name: /^Stop \d+$/ })
    await expect(stops.first()).toBeVisible()
    const count = await stops.count()
    const offlineCopy = page.getByRole("note", { name: "Offline copy" })
    await expect(offlineCopy).toHaveCount(0)
    // The route screen, reached inside the app, is kept by the shell.
    await expect.poll(() => page.evaluate(async (path) => (await caches.match(path)) !== undefined, `/driver/routes/${route.id}`), { timeout: 15_000 }).toBe(true)

    await context.setOffline(true)
    await page.reload()
    await expect(stops).toHaveCount(count)
    await expect(offlineCopy).toContainText("Offline copy: the server's answer at")
    await expect(page.getByRole("status").filter({ hasText: "Can't reach the server" })).toBeVisible()

    // Back to the start screen with no signal: the kept page, the kept answer.
    await page.getByRole("link", { name: "Your routes", exact: true }).click()
    await expect(page).toHaveURL(/\/driver$/)
    await expect(page.getByRole("article", { name: `Route ${route.label}` })).toBeVisible()
    await expect(offlineCopy).toBeVisible()

    await context.setOffline(false)
    await page.getByRole("button", { name: "Refresh" }).click()
    await expect(offlineCopy).toHaveCount(0)
    await expect(page.getByRole("status").filter({ hasText: "Can't reach the server" })).toHaveCount(0)
  } finally {
    await context.close()
  }
})
