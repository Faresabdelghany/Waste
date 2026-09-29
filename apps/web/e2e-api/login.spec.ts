import { expect, test } from "./fixtures"
import { E2E } from "./env"

// Scenario 1: the real login. Auth's password grant refuses a wrong password
// in its own words, and a right one lands the person where `/me` says — the
// administrator has no driver profile, so on operations (lib/api/landing.ts).
// A context of its own: the setup project's session must not be here.
test.use({ storageState: { cookies: [], origins: [] } })

test("a wrong password is refused in Auth's words, on the form", async ({ page }) => {
  await page.goto("/login")
  await expect(page.getByRole("heading", { name: "Sign in to Waste" })).toBeVisible()
  await page.getByLabel("E-mail").fill(E2E.loginEmail)
  await page.getByLabel("Password").fill("not-the-password")
  await page.getByRole("button", { name: "Sign in" }).click()
  // The form's own alert; Next's route announcer is a `role=alert` too.
  await expect(page.locator("form").getByRole("alert")).toHaveText("Invalid login credentials")
  await expect(page).toHaveURL(/\/login/)
})

test("the right password lands by /me: the administrator on operations", async ({ page }) => {
  await page.goto("/login")
  await page.getByLabel("E-mail").fill(E2E.loginEmail)
  await page.getByLabel("Password").fill(E2E.loginPassword)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL(/\/operate/)
})

test("without a session every page but /login is the gate's: back to /login, carrying the page", async ({ page }) => {
  await page.goto("/customers")
  await expect(page).toHaveURL(/\/login\?next=%2Fcustomers/)
})
