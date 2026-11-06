import { expect, test } from "./fixtures"

// Settings › Tickets › Types: a row opens the type's own page in the list's
// place, under an address of its own that names the type by the API's id, so
// a reload lands on it again; its tabs are the type's, and its back arrow
// returns to the list. Nothing is written, since the stack is shared.

test("a ticket type opens as a page of its own, which a reload lands on again", async ({ page }) => {
  await page.goto("/settings?pane=tickets")
  // The pane renders inside Settings, outside the workspace's main landmark.
  const pane = page.locator("body")
  await pane.getByRole("button", { name: "Open Complaint" }).click()
  await expect(pane.getByRole("heading", { name: "Complaint" })).toBeVisible()
  await expect(page).toHaveURL(/[?&]type=[0-9a-f-]{36}(&|$)/)

  await page.reload()
  await expect(pane.getByRole("heading", { name: "Complaint" })).toBeVisible()
  await pane.getByRole("tab", { name: /^Fields/ }).click()
  await expect(pane.getByRole("button", { name: "Add field" })).toBeVisible()

  await pane.getByRole("button", { name: "Back to ticket types" }).click()
  await expect(pane.getByRole("button", { name: "Open Complaint" })).toBeVisible()
  await expect(page).not.toHaveURL(/[?&]type=/)
})
