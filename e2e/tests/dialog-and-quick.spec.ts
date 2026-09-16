import { expect, test } from "../fixtures"
import { pickOption, startGuided, startQuick, wizard } from "../helpers/route-schemes"

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

test("quick create applies the same driver licence rule as the wizard", async ({ page }) => {
  const dialog = await startQuick(page)
  await pickOption(page, dialog, "Planned vehicle", "WH-31 · DK 88 441")
  await dialog.getByLabel("Planned driver", { exact: true }).click()
  const unlicensed = page.getByRole("option", { name: "Jonas Lind · No licence on record" })
  await expect(unlicensed).toBeVisible()
  await expect(unlicensed).toHaveAttribute("aria-disabled", "true")
  const eligible = page.getByRole("option", { name: "Freja Nielsen · C, CE" })
  await expect(eligible).not.toHaveAttribute("aria-disabled", "true")
  await eligible.click()
  await expect(dialog.getByLabel("Planned driver", { exact: true })).toContainText("Freja Nielsen")
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
})
