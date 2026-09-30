import { expect, test } from "../fixtures"
import { fillScope, nextButton, optionTexts, startGuided, wizard } from "../helpers/route-schemes"

// The wizard's own accessibility, moved here from dialog-and-quick.spec.ts
// when quick create moved to the API suite (#177): it travels with the wizard
// to slice 4's guided-setup spec.
test("the wizard is a labelled dialog that traps focus and closes on Escape", async ({ page }) => {
  await startGuided(page)
  const root = wizard(page)
  await expect(root).toHaveAttribute("role", "dialog")
  await expect(root).toHaveAccessibleName("New route scheme")
  const focusInside = await page.evaluate(() =>
    Boolean(document.activeElement?.closest('[role="dialog"]')),
  )
  expect(focusInside).toBe(true)
  await page.keyboard.press("Tab")
  expect(
    await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))),
  ).toBe(true)
  await page.keyboard.press("Escape")
  await expect(root).toBeHidden()
})

test("step 1 asks for the real scope and has no Collection calendar", async ({ page }) => {
  await startGuided(page)
  const root = wizard(page)
  for (const label of [
    "Route scheme name",
    "Project",
    "Operational planning area",
    "Waste fraction",
    "Service type",
    "Departure depot",
    "Unloading station",
  ]) {
    await expect(root.getByLabel(label, { exact: true }), label).toBeVisible()
  }
  await expect(root.getByText("Operational defaults (optional)")).toBeVisible()
  await expect(root.getByText("Collection calendar")).toHaveCount(0)
})

test("step 1 gates on name, project, planning area, waste fraction, and service type", async ({
  page,
}) => {
  await startGuided(page)
  await expect(nextButton(page)).toBeDisabled()
  await fillScope(page, { name: "Gate check" })
  await expect(nextButton(page)).toBeDisabled()
  await fillScope(page, { project: "Copenhagen Central" })
  await expect(nextButton(page)).toBeDisabled()
  await fillScope(page, { area: "Indre By Operations" })
  await expect(nextButton(page)).toBeDisabled()
  await fillScope(page, { fraction: "Residual" })
  await expect(nextButton(page)).toBeDisabled()
  await fillScope(page, { serviceType: "Container collection" })
  await expect(nextButton(page)).toBeEnabled()
})

test("the service type offers the five kinds of collection work, nothing else", async ({ page }) => {
  await startGuided(page)
  expect(await optionTexts(page, wizard(page), "Service type")).toEqual([
    "Container collection",
    "Underground collection",
    "Kerbside collection",
    "Crane collection",
    "Tank emptying",
  ])
})
