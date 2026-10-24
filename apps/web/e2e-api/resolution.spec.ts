import { uniqueName } from "./env"
import { chainLanded, expect, test } from "./fixtures"
import { answerOf, pick, schemeWithRoutes, toasts } from "./routes-support"
import { listAll, projectNamed } from "./tester"

// Resolution on the API (Issue #182, slice 8 of #81; #147's acceptance as
// far as the office's side goes): Operate's tickets and alerts are the API's
// rows. The office opens a ticket about a route through New ticket, works it
// in its details — assigns it to themselves, starts it, notes it internally,
// completes it as recollected on a route picked from Route Studio — and the
// history shows every step; the list's columns hold what they are headed
// (#253); a command on a ticket another hand closed is the API's own
// sentence; an alert about a vehicle is raised, acknowledged and handed to a
// ticket that answers it. Every body is the one the contracts
// take, read off the browser's own request. Nothing is seeded for
// Resolution (#143): each test makes what it works on, uniquely named.

type ApiTicket = { id: string; label: string; status: string; subject: string; resolution: string | null; recollectionRouteId: string | null; assigneeUserAccountId: string | null }
type ApiEvent = { kind: string; body: string | null; visibility: string }
type ApiAlert = { id: string; status: string; ticketId: string | null }
type Me = { user: { id: string; fullName: string } }
type Named = { id: string; name: string }

test("the office opens a ticket about a route, assigns it to themselves, starts it, notes it and completes it as recollected on a route picked from Route Studio; the history shows every step", async ({ api, page }) => {
  test.setTimeout(120_000)
  const { routes } = await schemeWithRoutes(api, uniqueName("E2E Resolution"), 7)
  const [about] = routes
  const recollection = routes[1] ?? about
  const [project, me] = await Promise.all([projectNamed(api, "Copenhagen Central"), api.get("/me").then(async (response) => (await response.json()) as Me)])
  const subject = uniqueName("E2E overflow")

  const listed = answerOf(page, "GET", "/tickets")
  await page.goto("/tickets")
  expect((await listed).status()).toBe(200)
  await chainLanded(page)
  // The list opens on the open tickets: a chip the person can take off.
  await expect(page.getByRole("main").getByText("Open or closed: Open")).toBeVisible()

  await page.getByRole("button", { name: "New ticket" }).click()
  const form = page.getByRole("dialog", { name: "New ticket" })
  await pick(form, page, "Project", project.name)
  await form.getByRole("textbox", { name: /^Subject/ }).fill(subject)
  await form.getByRole("textbox", { name: /^Description/ }).fill("Glass above the rim of the bank")
  await pick(form, page, "Kind", "Overflow")
  await pick(form, page, "Priority", "High")
  await pick(form, page, "Route", `${about.label} · ${about.operatingDate} · Planned`)
  const [opened] = await Promise.all([answerOf(page, "POST", "/tickets"), form.getByRole("button", { name: "Open ticket" }).click()])
  expect(opened.status(), await opened.text()).toBe(201)
  expect(opened.request().postDataJSON()).toEqual({ projectId: project.id, subject, description: "Glass above the rim of the bank", kind: "overflow", priority: "high", source: "office", links: { routeId: about.id } })
  const ticket = (await opened.json()) as ApiTicket

  // The ticket made opens in its details, the case as the API holds it.
  const details = page.getByRole("dialog", { name: subject })
  await expect(details).toContainText(ticket.label)
  await expect(details.getByTestId("ticket-links")).toContainText(about.label)
  const history = details.getByTestId("ticket-history")
  await expect(history).toContainText("Opened")

  await details.getByRole("button", { name: "Change Assignee" }).click()
  const assign = page.getByRole("dialog", { name: "Assign" })
  await pick(assign, page, "Assignee", me.user.fullName)
  const [assigned] = await Promise.all([answerOf(page, "POST", `/tickets/${ticket.id}/assign`), assign.getByRole("button", { name: "Assign" }).click()])
  expect(assigned.status()).toBe(200)
  expect(assigned.request().postDataJSON()).toEqual({ assigneeUserAccountId: me.user.id })
  await expect(history).toContainText(`Assigned to ${me.user.fullName}`)

  // A command is offered where it moves the ticket: an open ticket offers no Reopen.
  const commands = details.getByTestId("ticket-commands")
  await expect(commands.getByRole("button")).toHaveText(["Start", "Waiting for customer", "Put on hold", "Complete", "Reject"])
  const [started] = await Promise.all([answerOf(page, "POST", `/tickets/${ticket.id}/start`), commands.getByRole("button", { name: "Start" }).click()])
  expect(started.status()).toBe(200)
  expect(started.request().postDataJSON()).toEqual({})
  await expect(details.getByText("In progress", { exact: true }).first()).toBeVisible()

  await details.getByRole("textbox", { name: "Internal note" }).fill("Called the caretaker about the gate")
  const [noted] = await Promise.all([answerOf(page, "POST", `/tickets/${ticket.id}/comments`), details.getByRole("button", { name: "Add note" }).click()])
  expect(noted.status()).toBe(201)
  expect(noted.request().postDataJSON()).toEqual({ body: "Called the caretaker about the gate", visibility: "internal" })
  await expect(history).toContainText("Called the caretaker about the gate")

  await commands.getByRole("button", { name: "Complete" }).click()
  const complete = page.getByRole("dialog", { name: "Complete" })
  await pick(complete, page, "Resolution", "Recollected")
  // A re-collection rides on a route that has not ended, picked from Route Studio, never typed.
  await pick(complete, page, "Re-collection route", `${recollection.label} · ${recollection.operatingDate} · Planned`)
  await complete.getByRole("textbox", { name: /^How it was resolved/ }).fill(`On ${recollection.label}`)
  const [completed] = await Promise.all([answerOf(page, "POST", `/tickets/${ticket.id}/complete`), complete.getByRole("button", { name: "Complete" }).click()])
  expect(completed.status(), await completed.text()).toBe(200)
  expect(completed.request().postDataJSON()).toEqual({ resolution: "recollected", note: `On ${recollection.label}`, recollectionRouteId: recollection.id })
  await expect(details).toContainText("Recollected")
  await expect(history).toContainText("Completed · Recollected")
  // Closed, it takes Reopen alone, and its own fields wait for it to be reopened.
  await expect(commands.getByRole("button")).toHaveText(["Reopen"])
  await expect(details.getByRole("button", { name: "Change Priority" })).toBeDisabled()
  await expect(details.getByRole("button", { name: "Edit case" })).toBeDisabled()

  // The history as the API holds it, in recording order.
  const read = await api.get(`/tickets/${ticket.id}`)
  const stored = (await read.json()) as ApiTicket & { events: ApiEvent[] }
  expect(stored).toMatchObject({ status: "completed", resolution: "recollected", recollectionRouteId: recollection.id, assigneeUserAccountId: me.user.id })
  expect(stored.events.map((event) => event.kind)).toEqual(["created", "assigned", "status-changed", "comment", "status-changed"])

  // Closed, the ticket leaves the open list; taking the chip off shows it again.
  await details.getByRole("button", { name: "Back to tickets" }).click()
  const search = page.getByRole("main").getByRole("textbox", { name: /^Search .+/ })
  await search.fill(subject)
  await expect(page.getByRole("main").getByText("No matching records").first()).toBeVisible()
  await page.getByRole("button", { name: "Remove Open or closed: Open" }).click()
  await expect(page.getByRole("main").getByText(subject).first()).toBeVisible()
})

test("the list heads one column Ticket and the number its own, and Customer · property holds whom and where a ticket is about, each once (#253)", async ({ api, page }) => {
  const project = await projectNamed(api, "Copenhagen Central")
  const made = await api.post("/customers", { data: { kind: "organisation", name: uniqueName("E2E Ticket customer") } })
  expect(made.status(), await made.text()).toBe(201)
  const customer = (await made.json()) as Named
  const placed = await api.post("/properties", { data: { projectId: project.id, name: uniqueName("E2E Ticket property"), address: "Parkvej 18, 2100 København Ø", kind: "residential" } })
  expect(placed.status(), await placed.text()).toBe(201)
  const property = (await placed.json()) as Named
  const subject = uniqueName("E2E blocked gate")
  const created = await api.post("/tickets", { data: { projectId: project.id, subject, description: "The gate code changed", kind: "access-issue", links: { customerId: customer.id, propertyId: property.id } } })
  expect(created.status(), await created.text()).toBe(201)
  const ticket = (await created.json()) as ApiTicket

  const listed = answerOf(page, "GET", "/tickets")
  await page.goto("/tickets")
  expect((await listed).status()).toBe(200)
  await chainLanded(page)
  const main = page.getByRole("main")
  await expect(main.getByRole("columnheader", { name: "Ticket", exact: true })).toHaveCount(1)
  await expect(main.getByRole("columnheader", { name: "Number", exact: true })).toBeVisible()
  await main.getByRole("textbox", { name: /^Search .+/ }).fill(subject)
  // A row is the button that opens it, its cells in the headers' order.
  const headers = await main.getByRole("columnheader").allTextContents()
  const column = (heading: string) => {
    expect(headers, `a column headed ${heading}`).toContain(heading)
    return headers.indexOf(heading)
  }
  const cells = main.getByRole("button", { name: `Open ${subject}` }).getByRole("cell")
  await expect(cells.nth(column("Customer · property"))).toHaveText(`${customer.name} · ${property.name}`)
  await expect(cells.nth(column("Number"))).toHaveText(ticket.label)
})

test("a command on a ticket another hand closed is refused in the API's own sentence", async ({ api, page }) => {
  const project = await projectNamed(api, "Copenhagen Central")
  const subject = uniqueName("E2E complaint")
  const created = await api.post("/tickets", { data: { projectId: project.id, subject, description: "Bins left on the pavement", kind: "complaint" } })
  expect(created.status(), await created.text()).toBe(201)
  const ticket = (await created.json()) as ApiTicket

  await page.goto(`/tickets?module=tickets&record=ticket-${ticket.id}`)
  const details = page.getByRole("dialog", { name: subject })
  const start = details.getByTestId("ticket-commands").getByRole("button", { name: "Start" })
  await expect(start).toBeEnabled({ timeout: 30_000 })

  // Behind the page, another desk closes the case.
  const closed = await api.post(`/tickets/${ticket.id}/complete`, { data: { resolution: "no-action", note: "Closed from another desk" } })
  expect(closed.status(), await closed.text()).toBe(200)

  const [refused] = await Promise.all([answerOf(page, "POST", `/tickets/${ticket.id}/start`), start.click()])
  expect(refused.status()).toBe(409)
  await expect(toasts(page)).toContainText(`${subject} was not started`)
  await expect(toasts(page)).toContainText(`Ticket ${ticket.label} is completed; reopen it first`)
})

test("an alert about a vehicle is raised by hand, acknowledged and handed to a ticket that answers it", async ({ api, page }) => {
  const project = await projectNamed(api, "Copenhagen Central")
  const vehicle = (await listAll<{ id: string; callsign: string | null }>(api, "/vehicles")).find((row) => row.callsign === "WH-24")
  expect(vehicle, "the seed holds WH-24").toBeTruthy()
  const title = uniqueName("E2E stale position")

  const listed = answerOf(page, "GET", "/alerts")
  await page.goto("/tickets?module=exceptions")
  expect((await listed).status()).toBe(200)
  await chainLanded(page)
  // The queue opens on what still needs attention.
  await expect(page.getByRole("main").getByText("Status: New")).toBeVisible()
  await expect(page.getByRole("main").getByText("Status: Acknowledged")).toBeVisible()

  await page.getByRole("button", { name: "Create alert" }).click()
  const form = page.getByRole("dialog", { name: "Raise alert" })
  await pick(form, page, "Project", project.name)
  await form.getByRole("textbox", { name: /^Title/ }).fill(title)
  await form.getByRole("textbox", { name: /^Details/ }).fill("No position from WH-24 for 14 minutes")
  await pick(form, page, "Kind", "Resource")
  await pick(form, page, "Severity", "High")
  await pick(form, page, "Vehicle", "WH-24 · CN 42 018 · Active")
  const [raised] = await Promise.all([answerOf(page, "POST", "/alerts"), form.getByRole("button", { name: "Raise alert" }).click()])
  expect(raised.status(), await raised.text()).toBe(201)
  expect(raised.request().postDataJSON()).toEqual({ projectId: project.id, title, details: "No position from WH-24 for 14 minutes", kind: "resource", severity: "high", vehicleId: vehicle?.id })
  const alert = (await raised.json()) as ApiAlert

  const commands = page.getByTestId("alert-commands")
  const [acknowledged] = await Promise.all([answerOf(page, "POST", `/alerts/${alert.id}/acknowledge`), commands.getByRole("button", { name: "Acknowledge" }).click()])
  expect(acknowledged.status()).toBe(200)
  expect(acknowledged.request().postDataJSON()).toEqual({})
  await expect(commands.getByRole("button", { name: "Acknowledge" })).toHaveCount(0)

  // Open ticket: New ticket on the alert's words, the alert's severity its priority, answering the alert.
  await commands.getByRole("button", { name: "Open ticket" }).click()
  const handOver = page.getByRole("dialog", { name: "New ticket" })
  await expect(handOver.getByRole("textbox", { name: /^Subject/ })).toHaveValue(title)
  const [opened] = await Promise.all([answerOf(page, "POST", "/tickets"), handOver.getByRole("button", { name: "Open ticket" }).click()])
  expect(opened.status(), await opened.text()).toBe(201)
  expect(opened.request().postDataJSON()).toEqual({ projectId: project.id, subject: title, description: "No position from WH-24 for 14 minutes", kind: "other", priority: "high", source: "office", alertId: alert.id })
  const ticket = (await opened.json()) as ApiTicket

  // The ticket made opens in its details and names the alert it answers; the API linked the two.
  await expect(page).toHaveURL(/module=tickets/)
  await expect(page.getByTestId("ticket-alerts")).toContainText(title)
  const read = await api.get(`/alerts/${alert.id}`)
  expect(((await read.json()) as ApiAlert).ticketId).toBe(ticket.id)
})
