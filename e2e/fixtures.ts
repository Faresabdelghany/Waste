import { test as baseTest } from "@playwright/test"

export { expect } from "@playwright/test"

/** Where every Route Scheme creation scenario starts: the Route Schemes list. */
export const ROUTE_SCHEMES_URL = "/route-studio?module=schemes"

export const test = baseTest.extend({
  page: async ({ page }, use) => {
    await page.goto(ROUTE_SCHEMES_URL)
    // SSR renders the Live Operations module first; the client effect switches
    // to Route Schemes, so wait for the selected tab and the toolbar action.
    await page.getByRole("tab", { name: "Route Schemes", selected: true }).waitFor()
    await page.getByRole("button", { name: "Create route scheme" }).waitFor()
    await use(page)
  },
})
