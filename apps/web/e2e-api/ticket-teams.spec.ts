import { uniqueName } from "./env"
import { chainLanded, expect, test } from "./fixtures"
import { answerOf, pick, toasts } from "./routes-support"
import { listAll, projectNamed } from "./tester"

// Ticket teams on the API (O30 of #290, row 7.20): the office adds a team on
// Settings › Users & roles' Teams tab, which the teams' old pane id opens, and
// names it Copenhagen Central's default for complaints on Settings › Tickets'
// Default teams tab, a row edited on its own (#606), and the bodies are the
// contracts'. A complaint opened there without a team then waits with it, the
// list's Team category finds it, and its details hand it to no team. The
// Complaint type's own page then names the team its default in the project,
// and a new type's form names it as the type is made. Copenhagen Central is
// the project the workspace is pinned to, so the list reads its tickets; its
// defaults are put back as they were and the team and the new type are
// retired, since the stack is shared and neither is ever deleted.

type Defaults = { projectId: string; defaults: { kind: string; teamId: string }[] }
type ApiTeam = { id: string; name: string; status: string }
type ApiTicket = { id: string; subject: string; teamId: string | null }
type ApiType = { id: string; kind: string; isDefault: boolean }

test("the office adds a team, makes it a project's default for a kind, and a ticket of that kind waits with it", async ({ api, page }) => {
  test.setTimeout(120_000)
  const project = await projectNamed(api, "Copenhagen Central")
  const before = (await (await api.get(`/projects/${project.id}/ticket-team-defaults`)).json()) as Defaults
  const name = uniqueName("E2E team")
  let team: ApiTeam | undefined
  let madeType: ApiType | undefined
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
    await expect(pane.getByRole("cell", { name, exact: true })).toBeVisible()

    await page.goto("/settings?pane=tickets")
    await pane.getByRole("tab", { name: "Default teams" }).click()
    const read = answerOf(page, "GET", `/projects/${project.id}/ticket-team-defaults`)
    await pick(pane, page, "Project", project.name)
    expect((await read).status()).toBe(200)
    // A row reads its team and is edited on its own (#606): its pencil opens the picker, and the save puts the set back with that row moved.
    const complaints = pane.getByRole("row", { name: "Complaint", exact: true })
    await complaints.getByRole("button", { name: "Edit team for Complaint" }).click()
    const edit = page.getByRole("dialog", { name: "Default team for Complaint" })
    await pick(edit, page, "Team", name)
    const [saved] = await Promise.all([answerOf(page, "PUT", `/projects/${project.id}/ticket-team-defaults`), edit.getByRole("button", { name: "Save team" }).click()])
    expect(saved.status(), await saved.text()).toBe(200)
    expect((saved.request().postDataJSON() as Pick<Defaults, "defaults">).defaults).toContainEqual({ kind: "complaint", ticketTypeId: null, teamId: team.id })
    await expect(toasts(page)).toContainText("Default team saved")
    await expect(edit).toBeHidden()
    await expect(complaints.getByRole("cell", { name, exact: true })).toBeVisible()

    const subject = uniqueName("E2E team complaint")
    const opened = await api.post("/tickets", { data: { projectId: project.id, subject, description: "Bin left on the pavement", kind: "complaint" } })
    expect(opened.status(), await opened.text()).toBe(201)
    const ticket = (await opened.json()) as ApiTicket
    expect(ticket.teamId).toBe(team.id)

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

    const details = page.getByRole("dialog", { name: subject })
    await expect(details.getByRole("button", { name: "Change Team" })).toHaveText(name)
    await details.getByRole("button", { name: "Change Team" }).click()
    const [patched] = await Promise.all([answerOf(page, "PATCH", `/tickets/${ticket.id}`), page.getByRole("option", { name: "No team" }).click()])
    expect(patched.status(), await patched.text()).toBe(200)
    expect(patched.request().postDataJSON()).toEqual({ teamId: null })
    await expect(details.getByRole("button", { name: "Change Team" })).toHaveText("No team")
    await page.keyboard.press("Escape")

    // A type's own form sets its default team in the project the page shows (#606): the Complaint type's page reads none of its own, and Save type names it the team, which the Default teams tab then lists as the type's row.
    const complaintType = (await listAll<ApiType>(api, "/ticket-types")).find((type) => type.kind === "complaint" && type.isDefault)
    if (complaintType === undefined) throw new Error("the company holds no default type of complaints")
    const typeRead = answerOf(page, "GET", `/projects/${project.id}/ticket-team-defaults`)
    await page.goto(`/settings?pane=tickets&type=${complaintType.id}`)
    await pick(pane, page, "Project", project.name)
    expect((await typeRead).status()).toBe(200)
    await expect(pane.getByRole("combobox", { name: /^Default team/ })).toHaveText("As its kind")
    await pick(pane, page, "Default team", name)
    const [typeSaved] = await Promise.all([answerOf(page, "PUT", `/projects/${project.id}/ticket-team-defaults`), pane.getByRole("button", { name: "Save type" }).click()])
    expect(typeSaved.status(), await typeSaved.text()).toBe(200)
    expect((typeSaved.request().postDataJSON() as Pick<Defaults, "defaults">).defaults).toContainEqual({ kind: null, ticketTypeId: complaintType.id, teamId: team.id })
    await expect(toasts(page)).toContainText("Default team saved")
    await pane.getByRole("button", { name: "Back to ticket types" }).click()
    await pane.getByRole("tab", { name: "Default teams" }).click()
    await expect(pane.getByRole("row", { name: "Complaint (Complaint)", exact: true }).getByRole("cell", { name, exact: true })).toBeVisible()

    // A new type's form asks its default team in the project the page shows: the type is made, then the project's set names it the team, and its own page opens reading it.
    const typeName = uniqueName("E2E team type")
    await pane.getByRole("tab", { name: "Types" }).click()
    await pane.getByRole("button", { name: "New type" }).click()
    const typeForm = page.getByRole("dialog", { name: "New ticket type" })
    await typeForm.getByRole("textbox", { name: /^Name/ }).fill(typeName)
    await pick(typeForm, page, "Kind", "Complaint")
    await pick(typeForm, page, `Default team in ${project.name}`, name)
    const [typeMade, typeNamed] = await Promise.all([answerOf(page, "POST", "/ticket-types"), answerOf(page, "PUT", `/projects/${project.id}/ticket-team-defaults`), typeForm.getByRole("button", { name: "Add type" }).click()])
    expect(typeMade.status(), await typeMade.text()).toBe(201)
    madeType = (await typeMade.json()) as ApiType
    expect(typeNamed.status(), await typeNamed.text()).toBe(200)
    expect((typeNamed.request().postDataJSON() as Pick<Defaults, "defaults">).defaults).toContainEqual({ kind: null, ticketTypeId: madeType.id, teamId: team.id })
    await expect(page).toHaveURL(new RegExp(`[?&]type=${madeType.id}(&|$)`))
    await expect(pane.getByRole("combobox", { name: /^Default team/ })).toHaveText(name)
  } finally {
    const restored = await api.put(`/projects/${project.id}/ticket-team-defaults`, { data: { defaults: before.defaults } })
    expect(restored.status(), await restored.text()).toBe(200)
    // A type is never deleted: the one made here is retired, once the set names it no more.
    if (madeType !== undefined) {
      const retired = await api.patch(`/ticket-types/${madeType.id}`, { data: { status: "inactive" } })
      expect(retired.status(), await retired.text()).toBe(200)
    }
    if (team !== undefined) {
      const retired = await api.patch(`/teams/${team.id}`, { data: { status: "inactive" } })
      expect(retired.status(), await retired.text()).toBe(200)
    }
  }
})
