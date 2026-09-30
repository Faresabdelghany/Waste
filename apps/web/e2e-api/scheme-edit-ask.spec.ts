import type { Page } from "@playwright/test"

import { dayIn } from "./dispatched-route"
import { uniqueName } from "./env"
import { expect, test } from "./fixtures"
import { answerOf, openEdit, openScheme, pick, schemeWithRoutes, toasts, type Scheme } from "./routes-support"

// A running scheme's edit asks "How should this change apply?" on the Pilot
// (Issue #179), ported from the fixture suite's edit-policy.spec.ts, which
// #177 retired: under "Ask each time" a shaping edit of a scheme generation
// has run asks, counting the planned routes after today the API holds for
// it, and "Apply to future collections" is the scheme's PATCH, the routes
// following at the next generation run. "This collection only" is shown and
// not offered, since the API keeps no one-off yet (#209). The stored policy
// decides, and a rename never asks. Each test's scheme is made and
// generated through the API for the run (routes-support.ts).

const question = (page: Page) => page.getByRole("dialog", { name: "How should this change apply?" })

/** The routes of the scheme that can still follow an edit: planned, on a service date after today. */
const following = (routes: { status: string; serviceDate: string }[]) => routes.filter((route) => route.status === "planned" && route.serviceDate > dayIn("Europe/Copenhagen")).length

test("a shaping edit of a running scheme asks how it applies, counting the API's routes; This collection only is not offered, Back to the edit saves nothing, and future is the scheme's PATCH", async ({ api, page }) => {
  const { scheme, routes } = await schemeWithRoutes(api, uniqueName("E2E Ask"))
  const count = following(routes)
  await openScheme(page, scheme.name)
  const dialog = await openEdit(page)
  await expect(dialog.getByRole("combobox", { name: /^Changes to a running scheme/ })).toContainText("Ask each time")
  await dialog.getByRole("textbox", { name: "Planned start time" }).fill("08:15")

  let patched = false
  page.on("request", (request) => {
    if (request.method() === "PATCH" && new URL(request.url()).pathname === `/waste-api/route-schemes/${scheme.id}`) patched = true
  })
  await dialog.getByRole("button", { name: "Save changes" }).click()
  const asked = question(page)
  await expect(asked).toBeVisible()
  await expect(asked).toContainText(`${scheme.name} is running: ${count} future routes are planned and can still follow this edit`)
  await expect(asked).toContainText("the next collection is")
  await expect(asked.getByRole("radio", { name: /Apply to future collections/ })).toBeChecked()
  await expect(asked.getByRole("radio", { name: /This collection only/ })).toBeDisabled()
  await expect(asked).toContainText("Not offered yet: the API keeps no one-off change")

  await asked.getByRole("button", { name: "Back to the edit" }).click()
  await expect(asked).toHaveCount(0)
  await expect(dialog).toBeVisible()
  expect(patched, "Back to the edit sends nothing").toBe(false)

  await dialog.getByRole("button", { name: "Save changes" }).click()
  await expect(asked).toBeVisible()
  const [saved] = await Promise.all([answerOf(page, "PATCH", `/route-schemes/${scheme.id}`), asked.getByRole("button", { name: "Save changes" }).click()])
  expect(saved.status()).toBe(200)
  expect(saved.request().postDataJSON()).toEqual({ plannedStartTime: "08:15" })
  await expect(dialog).toBeHidden()
  await expect(toasts(page)).toContainText(`${scheme.name} updated`)
  await expect(toasts(page)).toContainText(`The next generation of its routes brings ${count} planned routes to it.`)
  const read = (await (await api.get(`/route-schemes/${scheme.id}`)).json()) as Scheme
  expect(read.plannedStartTime).toBe("08:15")
})

test("the stored policy decides: switching a running scheme off Ask each time in the same save still asks, and the new policy lands for the next edit", async ({ api, page }) => {
  const { scheme } = await schemeWithRoutes(api, uniqueName("E2E Policy"))
  await openScheme(page, scheme.name)
  let dialog = await openEdit(page)
  await pick(dialog, page, "Changes to a running scheme", "Apply to future collections")
  await dialog.getByRole("textbox", { name: "Planned start time" }).fill("08:15")
  await dialog.getByRole("button", { name: "Save changes" }).click()
  await expect(question(page)).toBeVisible()
  const [saved] = await Promise.all([answerOf(page, "PATCH", `/route-schemes/${scheme.id}`), question(page).getByRole("button", { name: "Save changes" }).click()])
  expect(saved.request().postDataJSON()).toEqual({ editPolicy: "future", plannedStartTime: "08:15" })
  await expect(dialog).toBeHidden()

  // Read again from the API: the next shaping edit follows the stored policy and asks nothing.
  await openScheme(page, scheme.name)
  dialog = await openEdit(page)
  await expect(dialog.getByRole("combobox", { name: /^Changes to a running scheme/ })).toContainText("Apply to future collections")
  await dialog.getByRole("textbox", { name: "Planned start time" }).fill("09:15")
  const [next] = await Promise.all([answerOf(page, "PATCH", `/route-schemes/${scheme.id}`), dialog.getByRole("button", { name: "Save changes" }).click()])
  expect(next.request().postDataJSON()).toEqual({ plannedStartTime: "09:15" })
  await expect(question(page)).toHaveCount(0)
  await expect(dialog).toBeHidden()
})

test("a rename of a running scheme under Ask each time saves without a question", async ({ api, page }) => {
  const { scheme } = await schemeWithRoutes(api, uniqueName("E2E Rename ask"))
  await openScheme(page, scheme.name)
  const dialog = await openEdit(page)
  await dialog.getByRole("textbox", { name: /^Route scheme name/ }).fill(`${scheme.name} renamed`)
  const [renamed] = await Promise.all([answerOf(page, "PATCH", `/route-schemes/${scheme.id}`), dialog.getByRole("button", { name: "Save changes" }).click()])
  expect(renamed.status()).toBe(200)
  expect(renamed.request().postDataJSON()).toEqual({ name: `${scheme.name} renamed` })
  await expect(question(page)).toHaveCount(0)
  await expect(toasts(page)).toContainText(`${scheme.name} renamed updated`)
})
