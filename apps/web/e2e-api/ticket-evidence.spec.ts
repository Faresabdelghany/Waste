import { ID_RANDOM_BYTES, mintId } from "@waste/domain/ids"

import { dispatchedRouteFor, SEEDED_DRIVER } from "./dispatched-route"
import { E2E, uniqueName } from "./env"
import { accessTokenOf, apiAs, chainLanded, expect, freshContext, signIn, test } from "./fixtures"
import { answerOf, pick, toasts } from "./routes-support"
import { projectNamed } from "./tester"

// Tickets answered with evidence (#293 M6). A route generated on a seeded
// scheme and dispatched (dispatched-route.ts) is run by the seeded driver
// through the driver door: its first stop collected, its second failed
// `not-presented`, the day ended. The office's New ticket names the failed
// stop under its route, and the missed collection is answered by the record
// as it opens: completed `answered`, the reply quoting the record on the
// customer's thread. A ticket about the collected stop opens, shows the
// stop's evidence in its details, and Reply with the record writes the reply
// with the office's note and completes the case in one step. Every body is
// the one the contracts take, read off the browser's own request.

type ApiTicket = { id: string; label: string; status: string; resolution: string | null }
type ApiEvent = { kind: string; status: string; body: string | null; visibility: string; resolution: string | null }
type Evidence = { stop: { outcome: string; reason: string | null; reply: string; answeredByRecord: boolean } | null }

/** One command as the Driver App queues it: an id the device mints, the route, the instant, the device. */
const commandOf = (kind: string, routeId: string, body: Record<string, unknown>, at: Date) => ({
  id: mintId(at.getTime(), crypto.getRandomValues(new Uint8Array(ID_RANDOM_BYTES))),
  kind,
  routeId,
  occurredAt: at.toISOString(),
  deviceId: "e2e-ticket-evidence",
  body,
})

test("a missed collection against a stop recorded not-presented is answered by the record as it opens, and a ticket about another stop is replied to with its record and completed in one step", async ({ api, page, browser }) => {
  test.setTimeout(180_000)
  const { route } = await dispatchedRouteFor(api)
  if (route.planned.vehicleId === null) throw new Error(`${route.label} was dispatched with no vehicle`)
  const stops = [...route.pickups].sort((a, b) => (a.sequence ?? a.position) - (b.sequence ?? b.position))
  expect(stops.length, `${route.label} needs two stops`).toBeGreaterThanOrEqual(2)
  const [collected, missed] = stops

  // The driver runs the route: collects the first stop, fails the second because the bin was not out, ends the day.
  const context = await freshContext(browser)
  try {
    const driverPage = await context.newPage()
    await signIn(driverPage, SEEDED_DRIVER.email, E2E.loginPassword)
    const token = await accessTokenOf(context)
    if (token === null) throw new Error("the driver's browser holds no API session")
    const asDriver = await apiAs(token)
    try {
      const start = Date.now() - 60_000
      const commands = [
        commandOf("start-route", route.id, { vehicleId: route.planned.vehicleId }, new Date(start)),
        commandOf("complete-pickup", route.id, { pickupId: collected.id }, new Date(start + 1_000)),
        commandOf("fail-pickup", route.id, { pickupId: missed.id, reason: "not-presented" }, new Date(start + 2_000)),
        commandOf("end-route", route.id, {}, new Date(start + 3_000)),
      ]
      const sent = await asDriver.post("/driver/commands", { data: { commands } })
      expect(sent.status(), await sent.text()).toBe(200)
      expect(((await sent.json()) as { outcomes: { outcome: string }[] }).outcomes.map((outcome) => outcome.outcome)).toEqual(["applied", "applied", "applied", "applied"])
    } finally {
      await asDriver.dispose()
    }
  } finally {
    await context.close()
  }

  const project = await projectNamed(api, "Copenhagen Central")
  const listed = answerOf(page, "GET", "/tickets")
  await page.goto("/tickets")
  expect((await listed).status()).toBe(200)
  await chainLanded(page)

  // The office records the resident's call against the failed stop, named under its route.
  const subject = uniqueName("E2E bin not emptied")
  await page.getByRole("button", { name: "New ticket" }).click()
  const form = page.getByRole("dialog", { name: "New ticket" })
  await pick(form, page, "Project", project.name)
  await form.getByRole("textbox", { name: /^Subject/ }).fill(subject)
  await form.getByRole("textbox", { name: /^Description/ }).fill("The resident says the bin was not emptied")
  await pick(form, page, "Kind", "Missed collection")
  await pick(form, page, "Route", `${route.label} · ${route.operatingDate} · Completed`)
  await form.getByRole("combobox", { name: /^Stop/ }).click()
  // The route's one failed stop: the rest were collected or closed by the day's end.
  await page.getByRole("option", { name: / · Failed$/ }).click()
  const [opened] = await Promise.all([answerOf(page, "POST", "/tickets"), form.getByRole("button", { name: "Open ticket" }).click()])
  expect(opened.status(), await opened.text()).toBe(201)
  expect(opened.request().postDataJSON()).toEqual({ projectId: project.id, subject, description: "The resident says the bin was not emptied", kind: "missed-collection", priority: "none", source: "office", links: { routeId: route.id, pickupId: missed.id } })
  const answered = (await opened.json()) as ApiTicket
  expect([answered.status, answered.resolution]).toEqual(["completed", "answered"])
  await expect(toasts(page)).toContainText(`${answered.label} was answered with the stop's record`)

  // Its details show the record and the reply the customer was sent, on the thread.
  const evidence = (await (await api.get(`/tickets/${answered.id}/evidence`)).json()) as Evidence
  expect([evidence.stop?.outcome, evidence.stop?.reason, evidence.stop?.answeredByRecord]).toEqual(["failed", "not-presented", true])
  const reply = evidence.stop?.reply ?? ""
  expect(reply).toMatch(/^Our driver was at the address at \d{2}:\d{2} on .+ and recorded that the bin was not put out for collection\.$/)
  const details = page.getByRole("dialog", { name: subject })
  await expect(details.getByTestId("ticket-evidence")).toContainText("Failed · Not presented")
  await expect(details.getByTestId("ticket-evidence-reply")).toHaveText(reply)
  const history = details.getByTestId("ticket-history")
  await expect(history.locator('[data-kind="comment"]')).toContainText(reply)
  await expect(history).toContainText("Completed · Answered")
  await details.getByRole("button", { name: "Back to tickets" }).click()

  // A ticket about the collected stop opens as a case: the record does not answer it by itself.
  const about = await api.post("/tickets", { data: { projectId: project.id, subject: uniqueName("E2E bin emptied late"), description: "The resident asks when the bin was emptied", kind: "missed-collection", links: { routeId: route.id, pickupId: collected.id } } })
  expect(about.status(), await about.text()).toBe(201)
  const asked = (await about.json()) as ApiTicket & { subject: string }
  expect(asked.status).toBe("open")
  await page.goto(`/tickets?module=tickets&record=ticket-${asked.id}`)
  const second = page.getByRole("dialog", { name: asked.subject })
  const record = second.getByTestId("ticket-evidence")
  // The details open once the tickets module has read its rows, which a long-lived stack holds many of.
  await expect(record).toContainText("Completed", { timeout: 30_000 })
  await expect(second.getByTestId("ticket-evidence-reply")).toContainText("Our driver collected the bin at")
  const collectedReply = (await second.getByTestId("ticket-evidence-reply").textContent()) ?? ""

  // One step: the reply with the office's note, and the case completed as answered.
  const replyButton = record.getByRole("button", { name: "Reply with the record" })
  await expect(replyButton).toBeEnabled({ timeout: 30_000 })
  await replyButton.click()
  const dialog = page.getByRole("dialog", { name: "Reply with the record" })
  await dialog.getByRole("textbox", { name: /^Note after the record/ }).fill("Thank you for calling us.")
  await dialog.getByRole("checkbox", { name: /^Complete the case as answered/ }).check()
  const [replied] = await Promise.all([answerOf(page, "POST", `/tickets/${asked.id}/reply-with-evidence`), dialog.getByRole("button", { name: "Record reply" }).click()])
  expect(replied.status(), await replied.text()).toBe(201)
  expect(replied.request().postDataJSON()).toEqual({ note: "Thank you for calling us.", complete: true })
  await expect(toasts(page)).toContainText("Reply recorded and ticket completed")
  await expect(second.getByTestId("ticket-history")).toContainText("Completed · Answered")
  const events = ((await replied.json()) as { events: ApiEvent[] }).events
  expect(events.slice(-2).map((event) => [event.kind, event.visibility, event.body])).toEqual([
    ["comment", "customer", `${collectedReply}\n\nThank you for calling us.`],
    ["status-changed", "internal", "Answered with the stop's record."],
  ])
})
