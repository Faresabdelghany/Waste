// "Changes to a running scheme" (issue #38) through the app: an edit of a
// running scheme under "Ask each time" raises the question over the edit
// dialog, "This collection only" pins the next collection and leaves the
// scheme's configuration alone, and an edit that shapes no collection — a
// rename — saves without a question.
import { expect, test } from "../fixtures"
import {
  buildBaselineScheme,
  createButton,
  nextStep,
  pickOption,
  toasts,
  wizard,
} from "../helpers/route-schemes"

/** An Effective scheme — created with its initial window, so it is running. */
async function createRunningScheme(page: Parameters<typeof buildBaselineScheme>[0], name: string) {
  await buildBaselineScheme(page, name)
  await nextStep(page)
  await nextStep(page)
  const root = wizard(page)
  await pickOption(page, root, "Create as", "Effective — routes publish from the first collection")
  await createButton(page).click()
  await expect(root).toBeHidden()
  await expect(toasts(page)).toContainText(`Route scheme created — ${name}`)
}

async function openEditDialog(page: Parameters<typeof buildBaselineScheme>[0], name: string) {
  await page.getByRole("button", { name: `Actions for ${name}` }).click()
  await page.getByRole("menuitem", { name: "Edit route scheme" }).click()
  const dialog = page.getByRole("dialog", { name: "Edit route scheme" })
  await expect(dialog).toBeVisible()
  return dialog
}

test("ask each time: a shaping edit raises the question, and 'This collection only' pins the next collection", async ({
  page,
}) => {
  const name = `Ask flow ${Date.now().toString(36)}`
  await createRunningScheme(page, name)

  const dialog = await openEditDialog(page, name)
  await expect(dialog.getByLabel("Changes to a running scheme")).toContainText("Ask each time")
  await dialog.getByLabel("Planned start time").fill("08:15")
  await dialog.getByRole("button", { name: "Save changes" }).click()

  // The question, over the still-open edit dialog.
  const question = page.getByRole("dialog", { name: "How should this change apply?" })
  await expect(question).toBeVisible()
  await expect(question).toContainText("is running")
  await expect(question).toContainText("the next collection is")
  await expect(question.getByText("Apply to future collections")).toBeVisible()
  await question.getByText("This collection only").click()
  await question.getByRole("button", { name: "Save changes" }).click()
  await expect(question).toBeHidden()
  await expect(dialog).toBeHidden()
  await expect(toasts(page)).toContainText(`${name} — this collection only`)
  await expect(toasts(page)).toContainText("Saved for this collection only")
  await expect(toasts(page)).toContainText("The scheme itself is unchanged")

  // The scheme keeps its start time and its policy; the next collection's
  // route — and only that one — carries the deviation.
  await page.getByRole("button", { name: `Open ${name}` }).click()
  const recurrenceCard = page
    .getByText("Recurrence", { exact: true })
    .locator("xpath=ancestor::*[contains(@class,'rounded')][1]")
  await expect(recurrenceCard).toContainText("06:30")
  await expect(recurrenceCard).not.toContainText("08:15")
  await expect(page.getByText("Ask each time", { exact: true })).toBeVisible()
  await page.getByRole("tab", { name: /Routes/ }).click()
  await expect(page.getByText("Edited for this collection only")).toHaveCount(1)
})

test("a rename of a running scheme under ask saves without a question", async ({ page }) => {
  const name = `Ask rename ${Date.now().toString(36)}`
  await createRunningScheme(page, name)
  const dialog = await openEditDialog(page, name)
  await dialog.getByLabel("Route scheme name").fill(`${name} renamed`)
  await dialog.getByRole("button", { name: "Save changes" }).click()
  await expect(page.getByRole("dialog", { name: "How should this change apply?" })).toHaveCount(0)
  await expect(dialog).toBeHidden()
  await expect(toasts(page)).toContainText(`${name} renamed updated`)
})
