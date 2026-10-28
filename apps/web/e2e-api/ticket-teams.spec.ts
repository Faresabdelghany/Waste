import { uniqueName } from "./env"
import { chainLanded, expect, test } from "./fixtures"
import { answerOf, pick, toasts } from "./routes-support"
import { projectNamed } from "./tester"

// Ticket teams on the API (O30 of #290, row 7.20): the office adds a team in
// Settings › Ticket teams and names it Copenhagen Central's default for
// complaints, and the bodies are the contracts'. A complaint opened there
// without a team then waits with it, the list's Team category finds it, and
// its details hand it to no team. Copenhagen Central is the project the
// workspace is pinned to, so the list reads its tickets; its defaults are put
// back as they were and the team is retired, since the stack is shared and a
// team is never deleted.

type Defaults = { projectId: string; defaults: { kind: string; teamId: string }[] }
type ApiTeam = { id: string; name: string; status: string }
type ApiTicket = { id: string; subject: string; teamId: string | null }

test("the office adds a team, makes it a project's default for a kind, and a ticket of that kind waits with it", async ({ api, page }) => {
  test.setTimeout(120_000)
  const project = await projectNamed(api, "Copenhagen Central")
  const before = (await (await api.get(`/projects/${project.id}/ticket-team-defaults`)).json()) as Defaults
  const name = uniqueName("E2E team")
  let team: ApiTeam | undefined
  try {
    await page.goto("/settings?pane=ticket-teams")
    // The pane renders inside Settings, outside the workspace's main landmark.
    const pane = page.locator("body")
    await pane.getByRole("button", { name: "New team" }).click()
    const form = page.getByRole("dialog", { name: "New team" })
    await form.getByRole("textbox", { name: /^Name/ }).fill(name)
    const [created] = await Promise.all([answerOf(page, "POST", "/teams"), form.getByRole("button", { name: "Add team" }).click()])
    expect(created.status(), await created.text()).toBe(201)
    expect(created.request().postDataJSON()).toEqual({ name, status: "active", memberUserAccountIds: [] })
    team = (await created.json()) as ApiTeam
    await expect(toasts(page)).toContainText("Team added")
    await expect(pane.getByRole("cell", { name })).toBeVisible()

    // Copenhagen Central's complaints go to the new team.
    const read = answerOf(page, "GET", `/projects/${project.id}/ticket-team-defaults`)
    await pick(pane, page, "Project", project.name)
    expect((await read).status()).toBe(200)
    await pick(pane.getByRole("row", { name: "Complaint" }), page, "Team for Complaint", name)
    const [saved] = await Promise.all([answerOf(page, "PUT", `/projects/${project.id}/ticket-team-defaults`), pane.getByRole("button", { name: "Save defaults" }).click()])
    expect(saved.status(), await saved.text()).toBe(200)
    expect((saved.request().postDataJSON() as Pick<Defaults, "defaults">).defaults).toContainEqual({ kind: "complaint", teamId: team.id })
    await expect(toasts(page)).toContainText("Default teams saved")

    // A complaint opened without a team waits with the project's default for the kind.
    const subject = uniqueName("E2E team complaint")
    const opened = await api.post("/tickets", { data: { projectId: project.id, subject, description: "Bin left on the pavement", kind: "complaint" } })
    expect(opened.status(), await opened.text()).toBe(201)
    const ticket = (await opened.json()) as ApiTicket
    expect(ticket.teamId).toBe(team.id)

    // The list's Team category finds it.
    const listed = answerOf(page, "GET", "/tickets")
    await page.goto("/tickets")
    expect((await listed).status()).toBe(200)
    await chainLanded(page)
    const main = page.getByRole("main")
    await main.getByRole("button", { name: /^Filter/ }).click()
    await page.getByRole("button", { name: /^Assigned team/ }).click()
    await page.locator("label").filter({ hasText: name }).getByRole("checkbox").click()
    await page.getByRole("button", { name: "Apply filters" }).click()
    await main.getByText(subject).first().click()

    // Its details hand it to no team, through the patch.
    const details = page.getByRole("dialog", { name: subject })
    await expect(details.getByRole("button", { name: "Change Team" })).toHaveText(name)
    await details.getByRole("button", { name: "Change Team" }).click()
    const [patched] = await Promise.all([answerOf(page, "PATCH", `/tickets/${ticket.id}`), page.getByRole("option", { name: "No team" }).click()])
    expect(patched.status(), await patched.text()).toBe(200)
    expect(patched.request().postDataJSON()).toEqual({ teamId: null })
    await expect(details.getByRole("button", { name: "Change Team" })).toHaveText("No team")
  } finally {
    const restored = await api.put(`/projects/${project.id}/ticket-team-defaults`, { data: { defaults: before.defaults } })
    expect(restored.status(), await restored.text()).toBe(200)
    if (team !== undefined) {
      const retired = await api.patch(`/teams/${team.id}`, { data: { status: "inactive" } })
      expect(retired.status(), await retired.text()).toBe(200)
    }
  }
})
