import { expect, test } from "../fixtures"
import { startGuided, startQuick, wizard } from "../helpers/route-schemes"

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

test("quick create has no Collection calendar field either", async ({ page }) => {
  const dialog = await startQuick(page)
  await expect(dialog.getByText("Route scheme name")).toBeVisible()
  await expect(dialog.getByText("Collection calendar")).toHaveCount(0)
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
})
