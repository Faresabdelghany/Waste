import type { APIRequestContext, Page } from "@playwright/test"

import { E2E, uniqueName } from "./env"
import { expect, freshContext, signIn, test } from "./fixtures"
import { answerOf, schemeWithRoutes, type ApiRoute } from "./routes-support"
import { listAll, projectNamed } from "./tester"

// The service-provider workspace on the Pilot (#291 C24): Lars Mikkelsen,
// NordRen's Service Provider Manager, signs in and lands on his own
// workspace, scoped by `/me` — NordRen's name, his own, his role's grants —
// rather than the fixture provider. The office awards NordRen the planning
// area a scheme made for the run serves, on the day of one of its routes;
// Lars then reads that route among the API's, with the two commands a
// provider sends, his own fleet, raises a ticket about the route in its
// project and comments on the provider's thread, and invites a foreman into
// his team through `POST /users`, then switches the account off.

type ServiceProvider = { id: string; legalName: string }
type Named = { id: string; name: string }
type ServiceArea = { id: string; planningAreaIds: string[]; validFrom: string; validTo: string | null }
type Assignment = { serviceAreaId: string; serviceProviderId: string; validFrom: string; validTo: string | null }

const LARS = { name: "Lars Mikkelsen", email: "lars.mikkelsen@nordren.example" } as const

const plus = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
const holdsOn = (period: { validFrom: string; validTo: string | null }, day: string) => period.validFrom <= day && (period.validTo === null || day < period.validTo)

/**
 * NordRen holds the planning area on the day, awarded by the office through
 * the API. A developer's stack keeps an earlier run's award of the area over
 * the day, the 409 of the one-award rule: then it must be NordRen's.
 */
async function awardToNordRen(api: APIRequestContext, provider: ServiceProvider, planningAreaId: string, day: string): Promise<void> {
  const project = await projectNamed(api, "Copenhagen Central")
  const code = `E2E-SP-${Date.now().toString(36)}`.toUpperCase()
  const response = await api.post("/service-areas", {
    data: { projectId: project.id, code, name: uniqueName("E2E provider award"), boundaryText: "As the e2e contract draws it", planningAreaIds: [planningAreaId], wasteFractionIds: [], validFrom: day, validTo: plus(day, 1), assignment: { serviceProviderId: provider.id } },
  })
  if (response.status() === 201) return
  expect(response.status(), `POST /service-areas: ${await response.text()}`).toBe(409)
  const [areas, assignments] = await Promise.all([listAll<ServiceArea>(api, "/service-areas"), listAll<Assignment>(api, "/service-area-assignments")])
  const held = areas.filter((area) => area.planningAreaIds.includes(planningAreaId) && holdsOn(area, day))
  expect(
    assignments.some((assignment) => held.some((area) => area.id === assignment.serviceAreaId) && assignment.serviceProviderId === provider.id && holdsOn(assignment, day)),
    `the planning area is awarded to another provider on ${day}`,
  ).toBe(true)
}

/** The office's setup: a scheme of the run's in Indre By Operations, its first route's day awarded to NordRen. */
async function nordrenRunsARoute(api: APIRequestContext): Promise<{ route: ApiRoute; provider: ServiceProvider }> {
  const { routes } = await schemeWithRoutes(api, uniqueName("E2E Provider"))
  const [route] = routes
  const [providers, areas] = await Promise.all([listAll<ServiceProvider>(api, "/service-providers"), listAll<Named>(api, "/planning-areas")])
  const provider = providers.find((candidate) => candidate.legalName === "NordRen ApS")
  const area = areas.find((candidate) => candidate.name === "Indre By Operations")
  if (provider === undefined || area === undefined) throw new Error("the seed holds NordRen ApS and Indre By Operations")
  await awardToNordRen(api, provider, area.id, route.operatingDate)
  return { route, provider }
}

/** A dialog by its heading: the details sheet and a form dialog may both be open. */
const dialogTitled = (page: Page, title: string) => page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: title, exact: true }) })

async function pick(page: Page, within: ReturnType<typeof dialogTitled>, field: RegExp, option: RegExp) {
  await within.getByRole("combobox", { name: field }).click()
  await page.getByRole("option", { name: option }).first().click()
}

test("NordRen's manager works his own workspace on the API: the routes NordRen runs, its fleet, a ticket raised about a route and a foreman invited into the team", async ({ api, browser }) => {
  const { route, provider } = await nordrenRunsARoute(api)

  const context = await freshContext(browser)
  try {
    const page = await context.newPage()
    const routesRead = answerOf(page, "GET", "/routes")
    await signIn(page, LARS.email, E2E.loginPassword)

    // The landing is the provider's workspace, its routes on the Pilot, under NordRen's name and Lars's: no fixture dashboard.
    await expect(page).toHaveURL(/\/service-provider-workspace$/)
    expect((await routesRead).status()).toBe(200)
    await expect(page.getByRole("link", { name: "Dashboard" })).toHaveCount(0)
    await expect(page.getByText(provider.legalName).first()).toBeVisible()

    // The route NordRen runs that day is among the API's, and its details offer the provider's crew commands alone.
    await page.goto(`/service-provider-workspace/routes?module=routes&record=route-${route.id}`)
    const details = page.getByRole("dialog", { name: route.label })
    const commands = details.getByTestId("route-commands")
    await expect(commands.getByRole("button", { name: "Dispatch" })).toBeEnabled({ timeout: 30_000 })
    await expect(commands.getByRole("button", { name: "Assign" })).toBeVisible()
    for (const office of ["Reschedule", "Reorder stops", "Optimise", "Cancel route", "Add stop"]) await expect(commands.getByRole("button", { name: office })).toHaveCount(0)
    await page.keyboard.press("Escape")

    // The fleet is NordRen's own, read from the API; its forms name master data a provider does not read, so it offers no create.
    const fleetRead = answerOf(page, "GET", "/vehicles")
    await page.goto("/service-provider-workspace/fleet")
    expect((await fleetRead).status()).toBe(200)
    await expect(page.getByRole("main").getByText(/^NR-08/).first()).toBeVisible()
    await expect(page.getByRole("main").getByText(/^WH-24/)).toHaveCount(0)

    // A ticket about the route, in its project, from the provider's workspace: no project, source or assignee asked.
    const ticketsRead = answerOf(page, "GET", "/tickets")
    await page.goto("/service-provider-workspace/tickets")
    expect((await ticketsRead).status()).toBe(200)
    await page.getByRole("button", { name: "New ticket" }).click()
    const form = dialogTitled(page, "New ticket")
    await expect(form.getByRole("combobox", { name: /^Project/ })).toHaveCount(0)
    await expect(form.getByRole("combobox", { name: /^Assignee/ })).toHaveCount(0)
    const subject = uniqueName("E2E gate locked")
    await form.getByLabel("Subject").fill(subject)
    await form.getByLabel("Description").fill("The yard gate was locked on arrival.")
    await pick(page, form, /^Kind/, /^Access issue/)
    await pick(page, form, /^Route/, new RegExp(`^${route.label}(?!\\d)`))
    const [opened] = await Promise.all([answerOf(page, "POST", "/tickets"), form.getByRole("button", { name: "Raise ticket" }).click()])
    expect(opened.status(), await opened.text()).toBe(201)
    const sent = opened.request().postDataJSON() as Record<string, unknown>
    expect(sent).toMatchObject({ projectId: route.projectId, subject, kind: "access-issue", links: { routeId: route.id } })
    expect(sent).not.toHaveProperty("source")
    expect(sent).not.toHaveProperty("assigneeUserAccountId")
    expect(((await opened.json()) as { source: string }).source).toBe("service-provider")

    // Its details are the provider's: a comment to the office on the provider's thread, and none of the office's commands.
    const ticket = page.getByRole("dialog", { name: subject })
    await expect(ticket.getByRole("radio", { name: "Comment to the office" })).toBeVisible()
    await expect(ticket.getByRole("radio", { name: "Internal note" })).toHaveCount(0)
    await expect(ticket.getByTestId("ticket-commands").getByRole("button")).toHaveCount(0)
    await ticket.getByRole("textbox", { name: "Comment to the office" }).fill("We wait at the gate until 07:00.")
    const [commented] = await Promise.all([answerOf(page, "POST", `/tickets/${(await opened.json() as { id: string }).id}/comments`), ticket.getByRole("button", { name: "Add comment" }).click()])
    expect(commented.status(), await commented.text()).toBe(201)
    expect(commented.request().postDataJSON()).toEqual({ body: "We wait at the gate until 07:00.", visibility: "service-provider" })
    await page.keyboard.press("Escape")

    // The team: NordRen's accounts alone, a foreman invited on a provider's role under NordRen, then switched off.
    const teamRead = answerOf(page, "GET", "/users")
    await page.goto("/service-provider-workspace/team")
    expect((await teamRead).status()).toBe(200)
    await expect(page.getByRole("main").getByText(LARS.name).first()).toBeVisible()
    await page.getByRole("button", { name: "Add user" }).click()
    const invite = dialogTitled(page, "Add user")
    await expect(invite.getByRole("combobox", { name: /^Service provider/ })).toHaveCount(0)
    const name = uniqueName("E2E Foreman")
    const email = `e2e-foreman-${Date.now().toString(36)}@nordren.example`
    await invite.getByLabel("Full name").fill(name)
    await invite.getByLabel("Email").fill(email)
    await pick(page, invite, /^Role/, /^Service Provider Foreman$/)
    const [invited] = await Promise.all([answerOf(page, "POST", "/users"), invite.getByRole("button", { name: "Add user" }).click()])
    expect(invited.status(), await invited.text()).toBe(201)
    expect(invited.request().postDataJSON()).toMatchObject({ email, fullName: name, serviceProviderId: provider.id })
    const member = (await invited.json()) as { id: string; status: string; serviceProviderId: string }
    expect(member).toMatchObject({ status: "invited", serviceProviderId: provider.id })

    const memberDetails = page.getByRole("dialog").filter({ has: page.getByTestId("team-member-commands") })
    const [deactivated] = await Promise.all([answerOf(page, "POST", `/users/${member.id}/deactivate`), memberDetails.getByRole("button", { name: "Deactivate" }).click()])
    expect(deactivated.status(), await deactivated.text()).toBe(200)
    await expect(memberDetails.getByRole("button", { name: "Reactivate" })).toBeVisible()
  } finally {
    await context.close()
  }
})
