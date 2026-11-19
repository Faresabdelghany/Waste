import { expect, test } from "./fixtures"

// #648: the sidebar's Search finds what the store holds for the person and
// opens it where it lives; ⌘K / Ctrl+K opens it from anywhere.
test("Search: Ctrl+K opens it, a seeded provider is found by part of its name and opens on its own page", async ({ page }) => {
  const providersRead = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === "/waste-api/service-providers")
  await page.goto("/tickets")
  expect((await providersRead).status()).toBe(200)

  await page.keyboard.press("Control+k")
  const search = page.getByRole("dialog", { name: "Search" })
  await expect(search).toBeVisible()
  await expect(search.getByRole("option", { name: "Service providers", exact: true })).toBeVisible()
  await search.getByPlaceholder("Search pages and records").fill("nordr")
  const hit = search.getByRole("option", { name: /NordRen ApS/ })
  await expect(hit).toBeVisible()
  await hit.click()

  await expect(search).toBeHidden()
  await expect(page).toHaveURL(/\/service-providers\?.*record=service-provider-/)
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("NordRen ApS")
})

test("Search: a word nothing the person can open holds says so, and the field opens it too", async ({ page }) => {
  await page.goto("/tickets")
  await page.getByRole("button", { name: "Search", exact: true }).click()
  const search = page.getByRole("dialog", { name: "Search" })
  await search.getByPlaceholder("Search pages and records").fill("zzq-nothing-holds-this")
  await expect(search.getByText("Nothing you can open matches “zzq-nothing-holds-this”.")).toBeVisible()
})
