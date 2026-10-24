import { uniqueName } from "./env"
import { chainLanded, expect, test } from "./fixtures"
import { answerOf, pick, toasts } from "./routes-support"
import { projectNamed } from "./tester"

// A project's ticket SLA on the API (O4 of #290): the office sets Copenhagen
// Central's targets in Settings › Ticket SLA — every kind at High within a
// day, Overflow at High within four hours — and the body is the whole set the
// contracts take. A ticket the office opens there without a due date is then
// due four hours after it opens, which its details read as on track; one
// already past its due date is what the list's SLA filter finds as overdue.
// Copenhagen Central is the project the workspace is pinned to, so the list
// reads its tickets; its targets are put back as they were, since the stack
// is shared.

type Sla = { projectId: string; targets: { id: string; kind: string | null; priority: string; hours: number }[] }
type ApiTicket = { id: string; label: string; subject: string; dueAt: string | null; occurredAt: string }

const HOUR = 60 * 60 * 1000

test("the office sets a project's SLA in Settings, a ticket opened without a due date is due by it, and the list's SLA filter finds the overdue ones", async ({ api, page }) => {
  test.setTimeout(120_000)
  const project = await projectNamed(api, "Copenhagen Central")
  const before = (await (await api.get(`/projects/${project.id}/ticket-sla`)).json()) as Sla
  try {
    const read = answerOf(page, "GET", `/projects/${project.id}/ticket-sla`)
    await page.goto("/settings?pane=ticket-sla")
    // The pane renders inside Settings, outside the workspace's main landmark.
    const pane = page.locator("body")
    await pick(pane, page, "Project", project.name)
    expect((await read).status()).toBe(200)

    // Start from an empty set, then add the two targets the contract promises.
    for (let count = before.targets.length; count > 0; count -= 1) await pane.getByRole("button", { name: "Remove target 1" }).click()
    await pane.getByRole("button", { name: "Add target" }).click()
    const everyKind = pane.getByRole("row", { name: "Target 1" })
    await pick(everyKind, page, "Priority", "High")
    await everyKind.getByRole("textbox", { name: "Hours" }).fill("24")
    await pane.getByRole("button", { name: "Add target" }).click()
    const overflow = pane.getByRole("row", { name: "Target 2" })
    await pick(overflow, page, "Kind", "Overflow")
    await pick(overflow, page, "Priority", "High")
    await overflow.getByRole("textbox", { name: "Hours" }).fill("4")
    const [saved] = await Promise.all([answerOf(page, "PUT", `/projects/${project.id}/ticket-sla`), pane.getByRole("button", { name: "Save SLA" }).click()])
    expect(saved.status(), await saved.text()).toBe(200)
    expect(saved.request().postDataJSON()).toEqual({ targets: [{ kind: null, priority: "high", hours: 24 }, { kind: "overflow", priority: "high", hours: 4 }] })
    await expect(toasts(page)).toContainText(`${project.name} has 2 targets.`)

    // The office opens an overflow at High with no due date: the API gives it the kind's four hours.
    const subject = uniqueName("E2E SLA overflow")
    await page.goto("/tickets")
    await chainLanded(page)
    await page.getByRole("button", { name: "New ticket" }).click()
    const form = page.getByRole("dialog", { name: "New ticket" })
    await pick(form, page, "Project", project.name)
    await form.getByRole("textbox", { name: /^Subject/ }).fill(subject)
    await form.getByRole("textbox", { name: /^Description/ }).fill("Bins overflowing at the station gate")
    await pick(form, page, "Kind", "Overflow")
    await pick(form, page, "Priority", "High")
    const [opened] = await Promise.all([answerOf(page, "POST", "/tickets"), form.getByRole("button", { name: "Open ticket" }).click()])
    expect(opened.status(), await opened.text()).toBe(201)
    expect(opened.request().postDataJSON()).not.toHaveProperty("dueAt")
    const ticket = (await opened.json()) as ApiTicket
    expect(ticket.dueAt).not.toBeNull()
    expect(Date.parse(ticket.dueAt ?? "") - Date.parse(ticket.occurredAt)).toBe(4 * HOUR)
    const details = page.getByRole("dialog", { name: subject })
    await expect(details).toContainText("On track")

    // A ticket an hour past its due date is what the list's SLA filter finds as overdue.
    const lateSubject = uniqueName("E2E SLA late")
    const late = await api.post("/tickets", { data: { projectId: project.id, subject: lateSubject, description: "Promised by this morning", kind: "complaint", priority: "high", dueAt: new Date(Date.now() - HOUR).toISOString() } })
    expect(late.status(), await late.text()).toBe(201)
    const listed = answerOf(page, "GET", "/tickets")
    await page.goto("/tickets")
    expect((await listed).status()).toBe(200)
    await chainLanded(page)
    const main = page.getByRole("main")
    await main.getByRole("button", { name: /^Filter/ }).click()
    await page.getByRole("button", { name: /^SLA/ }).click()
    await page.locator("label").filter({ hasText: /^Overdue/ }).getByRole("checkbox").click()
    await page.getByRole("button", { name: "Apply filters" }).click()
    await expect(main.getByText("SLA: Overdue")).toBeVisible()
    await expect(main.getByText(lateSubject).first()).toBeVisible()
    await expect(main.getByText(subject)).toHaveCount(0)
  } finally {
    const restored = await api.put(`/projects/${project.id}/ticket-sla`, { data: { targets: before.targets.map(({ kind, priority, hours }) => ({ kind, priority, hours })) } })
    expect(restored.status(), await restored.text()).toBe(200)
  }
})
