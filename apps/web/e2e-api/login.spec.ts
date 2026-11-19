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

  // The sidebar it lands beside is the API's alone (#248): no fixture route pinned as active, no registry badge.
  const sidebar = page.locator('[data-sidebar="sidebar"]').first()
  await expect(sidebar.getByText("Star a route in Route Studio to pin it here.")).toBeVisible()
  await expect(sidebar.getByText("Central · Residual")).toHaveCount(0)
  await expect(sidebar.getByRole("listitem").filter({ has: page.getByRole("link", { name: "Assets & Inventory" }) })).toHaveText("Assets & Inventory")
  await expect(sidebar.getByRole("listitem").filter({ has: page.getByRole("link", { name: "Price Engine" }) })).toHaveText("Price Engine")
})

// #659: text that reached the fields before the page hydrated is in the DOM
// alone, never in a React event. What the fields hold when Sign in is pressed
// is what is sent.
test("fields filled without an input event, as before hydration or by a password manager, are what is sent", async ({ page }) => {
  await page.goto("/login")
  await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled()
  await page.evaluate(
    ([email, password]) => {
      ;(document.getElementById("login-email") as HTMLInputElement).value = email
      ;(document.getElementById("login-password") as HTMLInputElement).value = password
    },
    [E2E.loginEmail, E2E.loginPassword],
  )
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL(/\/operate/)
})

test("before the page's scripts have run, Sign in cannot reload /login empty; once they have, what was typed signs in", async ({ page }) => {
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  // The scripts alone: the stylesheets share the folder, and holding one would hold the parser before the form.
  await page.route("**/_next/static/chunks/*.js", async (route) => {
    await held
    await route.continue()
  })
  await page.goto("/login", { waitUntil: "domcontentloaded" })
  const email = page.getByLabel("E-mail")
  const password = page.getByLabel("Password")
  const signIn = page.getByRole("button", { name: "Sign in" })
  await email.fill(E2E.loginEmail)
  await password.fill(E2E.loginPassword)
  await expect(signIn).toBeDisabled()
  await password.press("Enter")
  await signIn.click({ force: true })
  // A native submit would navigate; give it the time one takes before reading the page.
  await page.waitForTimeout(1_000)
  await expect(page).toHaveURL(/\/login$/)
  await expect(email).toHaveValue(E2E.loginEmail)

  // Released, the route lets every script through at once; unrouting now would race the held ones.
  release()
  await expect(signIn).toBeEnabled()
  await expect(email).toHaveValue(E2E.loginEmail)
  await signIn.click()
  await expect(page).toHaveURL(/\/operate/)
})

test("without a session every page but /login is the gate's: back to /login, carrying the page", async ({ page }) => {
  await page.goto("/customers")
  await expect(page).toHaveURL(/\/login\?next=%2Fcustomers/)
})
