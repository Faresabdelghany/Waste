// Integrations on the web (#487): on the Pilot the pane is the API's — the
// services the deployment calls, from `GET /integrations`, each in a
// sentence beside what `GET /routing/quota` and the latest import say — and a
// link to the browser's pane opens it. The fixtures' vendor connectors are
// not shown to a signed-in API user.
import type { Integrations } from "@waste/contracts/integrations"

import { expect, test } from "./fixtures"
import { answerOf } from "./routes-support"

test.describe("integrations (#487)", () => {
  test("a link to the browser's pane opens the API's: the routing provider, the address register and Storage as the deployment answers them, and no fixture vendor", async ({ api, page }) => {
    const read = await api.get("/integrations")
    expect(read.status(), await read.text()).toBe(200)
    const integrations = (await read.json()) as Integrations

    const [shown] = await Promise.all([answerOf(page, "GET", "/integrations"), page.goto("/settings?pane=integrations")])
    expect(shown.status()).toBe(200)
    await expect(page.getByRole("heading", { name: "Integrations" }).first()).toBeVisible()
    const connections = page.getByRole("list", { name: "Connections" })
    const routing = connections.getByRole("listitem").filter({ hasText: "Routing" })
    await expect(routing).toContainText(integrations.routing.provider === "openrouteservice" ? "Routing · openrouteservice" : "No provider · straight-line estimates")
    const register = connections.getByRole("listitem").filter({ hasText: "Looks up a property's address" })
    await expect(register).toContainText(integrations.addressRegister === null ? "Not set up · addresses are typed" : "Connected")
    const storage = connections.getByRole("listitem").filter({ hasText: "Proof storage" })
    await expect(storage).toContainText(integrations.proofStorage.configured ? "Connected" : "Not set up")
    await expect(connections.getByRole("listitem").filter({ hasText: "CSV import" })).toBeVisible()

    for (const vendor of ["Webfleet", "Navision", "Digital Post"]) await expect(page.getByText(vendor)).toHaveCount(0)

    // Refresh asks again.
    const [again] = await Promise.all([answerOf(page, "GET", "/integrations"), page.getByRole("button", { name: "Refresh" }).click()])
    expect(again.status()).toBe(200)
  })
})
