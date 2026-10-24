import { expect, test } from "./fixtures"

// Settings › Account & appearance on the Pilot (#282): the profile is the
// person signed in, as `/me` answers, read and never set here — never the
// prototype's fixture persona.

type MeBody = { user: { fullName: string; email: string; allProjects: boolean; primaryAdministrator: boolean }; role: { name: string }; projects: { name: string }[] }

test("Settings › Account & appearance shows the person signed in as /me answers: name, e-mail, role and projects, never the fixture persona", async ({ page, api }) => {
  const me = (await (await api.get("/me")).json()) as MeBody
  await page.goto("/settings?pane=account")
  const pane = page.locator("#settings-content")
  await expect(pane.getByRole("heading", { name: "Account and appearance" })).toBeVisible()

  await expect(pane.locator("#account-name")).toHaveText(me.user.fullName)
  await expect(pane.locator("#account-email")).toHaveText(me.user.email)
  await expect(pane.getByText(me.role.name, { exact: false }).first()).toBeVisible()
  const names = me.projects.map((project) => project.name).join(", ")
  await expect(pane.locator("#account-projects")).toHaveText(me.user.allProjects ? `All projects: ${names}` : names)
  // Read, not set: no field to type a name or an address into.
  await expect(pane.getByRole("textbox", { name: "Full name" })).toHaveCount(0)
  await expect(pane.getByRole("textbox", { name: "Email address" })).toHaveCount(0)
  await expect(pane).not.toContainText("Olivia Larsen")
  await expect(pane).not.toContainText("Operations Manager")
})
