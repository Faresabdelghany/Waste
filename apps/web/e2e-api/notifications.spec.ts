import type { Alert } from "@waste/contracts/alerts"
import type { Message } from "@waste/contracts/messaging"
import type { NotificationPreferences } from "@waste/contracts/notifications"
import type { Ticket } from "@waste/contracts/tickets"

import { uniqueName } from "./env"
import { expect, test } from "./fixtures"
import { answerOf, pick, toasts } from "./routes-support"
import { listAll, projectNamed, TESTER_PROJECT } from "./tester"

// The staff notices on the Pilot (O16 of #290). The administrator asks in
// Settings › Notifications for critical alerts and for the tickets assigned
// to them — nothing until then — and the PUT carries the whole set. A
// critical alert about WH-24 is raised and a ticket is opened assigned to
// them, both through the API; the worker's notifications consumer queues an
// e-mail for each, the send takes it through the log-only sender, and the
// pane's Sent to you lists both, sent. The choice is put back to nothing at
// the end, so the other scenarios' alerts and tickets e-mail nobody. Records
// are uniquely named and never cleaned up.

test("a person asks for critical alerts and their assignments in Settings › Notifications, and is e-mailed both through the log-only sender", async ({ api, page }) => {
  test.setTimeout(180_000)
  const me = (await (await api.get("/me")).json()) as { user: { id: string } }
  const none: NotificationPreferences = { alertRaisedMinSeverity: null, ticketAssigned: false }
  expect((await api.put("/me/notification-preferences", { data: none })).status()).toBe(200)

  // Settings › Notifications: critical alerts, and a ticket assigned to me.
  const read = answerOf(page, "GET", "/me/notification-preferences")
  await page.goto("/settings?pane=notifications-on-api")
  expect((await read).status()).toBe(200)
  const pane = page.locator("#settings-content")
  await pick(pane, page, "When an alert is raised", "Critical alerts")
  await pane.getByRole("switch", { name: "When a ticket is assigned to me" }).click()
  const [saved] = await Promise.all([answerOf(page, "PUT", "/me/notification-preferences"), pane.getByRole("button", { name: "Save" }).click()])
  expect(saved.status(), await saved.text()).toBe(200)
  expect(saved.request().postDataJSON()).toEqual({ alertRaisedMinSeverity: "critical", ticketAssigned: true })
  await expect(toasts(page)).toContainText("Notifications saved")

  try {
    // A critical alert and a ticket assigned to me, through the API.
    const project = await projectNamed(api, TESTER_PROJECT)
    const vehicle = (await listAll<{ id: string; callsign: string | null }>(api, "/vehicles")).find((row) => row.callsign === "WH-24")
    expect(vehicle, "the seed holds WH-24").toBeTruthy()
    const title = uniqueName("E2E Hydraulics leaking")
    const raised = await api.post("/alerts", { data: { projectId: project.id, title, details: "WH-24 left a trail of oil", kind: "resource", severity: "critical", vehicleId: vehicle?.id } })
    expect(raised.status(), await raised.text()).toBe(201)
    expect(((await raised.json()) as Alert).severity).toBe("critical")
    const subject = uniqueName("E2E Lid broken")
    const opened = await api.post("/tickets", { data: { projectId: project.id, kind: "container-defect", subject, description: "The lid hangs by one hinge", assigneeUserAccountId: me.user.id } })
    expect(opened.status(), await opened.text()).toBe(201)
    const ticket = (await opened.json()) as Ticket

    // The worker queues and sends both; the API lists them as mine, sent by the log-only sender.
    const expected = [`Critical alert · ${title}`, `Ticket ${ticket.label} assigned to you · ${subject}`]
    await expect
      .poll(
        async () => {
          const notices = ((await (await api.get("/me/notices", { params: { limit: "50" } })).json()) as { items: Message[] }).items
          return expected.map((wanted) => notices.find((notice) => notice.subject === wanted)?.status ?? "missing")
        },
        { timeout: 90_000, intervals: [1_000, 2_000, 3_000] },
      )
      .toEqual(["sent", "sent"])

    // Sent to you shows them.
    await pane.getByRole("button", { name: "Refresh" }).click()
    const sent = pane.getByRole("list", { name: "Notices sent to you" })
    for (const wanted of expected) await expect(sent.getByText(wanted)).toBeVisible()
  } finally {
    expect((await api.put("/me/notification-preferences", { data: none })).status()).toBe(200)
  }
})
