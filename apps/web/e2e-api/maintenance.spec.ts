import type { APIRequestContext, Page } from "@playwright/test"
import { addDays } from "@waste/domain/route-schemes/recurrence"

import { chainLanded, expect, test } from "./fixtures"
import { toasts } from "./routes-support"
import { listAll } from "./tester"

// Vehicle maintenance (O20 of #290): in WH-31's details in Fleet the office
// adds a maintenance plan — an annual service last done 360 days ago, so due
// within the fortnight — opens the plan's Maintenance Order, completes it
// today, which is the plan's service done and puts it back on track, and
// retires the plan. WH-31 (DK 88 441) is a glass crane no other flow plans
// maintenance on; a plan is retired, never deleted, so a run first retires and
// cancels what a run that died left of its own, by the plan's name.

type Vehicle = { id: string; callsign: string | null }
type Due = { state: string; nextDueOn: string | null }
type Plan = { id: string; name: string; status: string; lastDoneOn: string; due: Due }
type Order = { id: string; planId: string | null; title: string; status: string; dueOn: string | null; completedOn: string | null; closingNote: string | null }

const PLAN_NAME = "Annual service (e2e)"

/** The browser's API call the page makes: the answer of `method` on a path under `path`. */
const answerOf = (page: Page, method: string, path: RegExp) =>
  page.waitForResponse((response) => response.request().method() === method && path.test(new URL(response.url()).pathname.replace(/^\/waste-api/, "")))

/** Today on Copenhagen's clock, the seeded project's. */
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Copenhagen" })

/** Retires the suite's plans still active on the vehicle and cancels their open orders: what a run that died left. */
async function mend(api: APIRequestContext, vehicleId: string) {
  for (const order of await listAll<Order>(api, "/maintenance-orders", { vehicleId, status: "open" })) {
    if (order.title === PLAN_NAME) expect((await api.post(`/maintenance-orders/${order.id}/cancel`, { data: { note: "Mended by the e2e suite" } })).status()).toBe(200)
  }
  for (const plan of await listAll<Plan>(api, "/maintenance-plans", { vehicleId, status: "active" })) {
    if (plan.name === PLAN_NAME) expect((await api.patch(`/maintenance-plans/${plan.id}`, { data: { status: "retired" } })).status()).toBe(200)
  }
}

test("Fleet: a maintenance plan added in a vehicle's details reads due soon, its order completed today puts it back on track, and it is retired", async ({ page, api }) => {
  const wh31 = (await listAll<Vehicle>(api, "/vehicles")).find((vehicle) => vehicle.callsign === "WH-31")
  if (wh31 === undefined) throw new Error("the seed holds no vehicle WH-31")
  await mend(api, wh31.id)
  const day = today()
  const lastDone = addDays(day, -360)
  const nextDue = addDays(lastDone, 365)

  try {
    const loaded = answerOf(page, "GET", /^\/vehicles$/)
    await page.goto("/fleet?module=vehicles")
    expect((await loaded).status()).toBe(200)
    await chainLanded(page)
    await page.getByRole("main").getByRole("textbox", { name: /^Search .+/ }).fill("WH-31")
    await page.getByRole("button", { name: "Open WH-31 · DK 88 441" }).click()
    const details = page.getByRole("dialog").filter({ has: page.getByTestId("vehicle-maintenance") })
    const plans = details.getByTestId("vehicle-maintenance-plans")
    const orders = details.getByTestId("vehicle-maintenance-orders")

    // The plan: every 365 days from 360 days ago.
    await details.getByRole("button", { name: "Add plan" }).click()
    const planForm = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Add maintenance plan" }) })
    await planForm.getByLabel("Service").fill(PLAN_NAME)
    await planForm.getByLabel("Every (days)").fill("365")
    await planForm.getByLabel("Last done on").fill(lastDone)
    const [added] = await Promise.all([answerOf(page, "POST", /^\/maintenance-plans$/), planForm.getByRole("button", { name: "Add plan" }).click()])
    expect(added.status(), await added.text()).toBe(201)
    expect(added.request().postDataJSON()).toEqual({ name: PLAN_NAME, lastDoneOn: lastDone, intervalDays: 365, vehicleId: wh31.id })
    const plan = (await added.json()) as Plan
    expect(plan.due).toMatchObject({ state: "due-soon", nextDueOn: nextDue })
    await expect(toasts(page)).toContainText("Maintenance plan added")
    const planLine = plans.getByRole("listitem").filter({ hasText: `${PLAN_NAME} · every 365 days · next ${nextDue}` })
    await expect(planLine.getByText("Due soon")).toBeVisible()

    // Its order, planned for today, under the plan's name.
    await details.getByRole("button", { name: "Open order" }).click()
    const orderForm = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Open maintenance order" }) })
    await orderForm.getByRole("combobox", { name: /^Plan/ }).click()
    await page.getByRole("option", { name: PLAN_NAME, exact: true }).click()
    await orderForm.getByLabel("Planned for").fill(day)
    const [opened] = await Promise.all([answerOf(page, "POST", /^\/maintenance-orders$/), orderForm.getByRole("button", { name: "Open order" }).click()])
    expect(opened.status(), await opened.text()).toBe(201)
    const order = (await opened.json()) as Order
    expect(order).toMatchObject({ planId: plan.id, title: PLAN_NAME, status: "open", dueOn: day })

    // Completed today: the plan's service done, back on track.
    await orders.getByRole("listitem").filter({ hasText: `${PLAN_NAME} · due ${day}` }).getByRole("button", { name: "Complete" }).click()
    const completeForm = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: `Complete ${PLAN_NAME}` }) })
    await completeForm.getByLabel("Done on").fill(day)
    await completeForm.getByLabel("What was done").fill("Full service")
    const [completed] = await Promise.all([answerOf(page, "POST", new RegExp(`^/maintenance-orders/${order.id}/complete$`)), completeForm.getByRole("button", { name: "Complete order" }).click()])
    expect(completed.status(), await completed.text()).toBe(200)
    expect(completed.request().postDataJSON()).toEqual({ completedOn: day, note: "Full service" })
    // An earlier run's order of today may read the same: this run's is the first, the newest.
    await expect(orders.getByText(`${PLAN_NAME} · completed ${day} · Full service`).first()).toBeVisible()
    const serviced = (await (await api.get(`/maintenance-plans/${plan.id}`)).json()) as Plan
    expect(serviced).toMatchObject({ lastDoneOn: day, due: { state: "ok", nextDueOn: addDays(day, 365) } })
    await expect(plans.getByRole("listitem").filter({ hasText: `next ${addDays(day, 365)}` }).getByText("On track")).toBeVisible()

    // Retired: kept, and offered no more.
    const [retired] = await Promise.all([answerOf(page, "PATCH", new RegExp(`^/maintenance-plans/${plan.id}$`)), plans.getByRole("listitem").filter({ hasText: PLAN_NAME }).getByRole("button", { name: "Retire" }).click()])
    expect(retired.status(), await retired.text()).toBe(200)
    expect(((await retired.json()) as Plan).status).toBe("retired")
    await expect(plans.getByRole("listitem").filter({ hasText: PLAN_NAME }).getByRole("button", { name: "Retire" })).toHaveCount(0)
  } finally {
    await mend(api, wh31.id)
  }
})
