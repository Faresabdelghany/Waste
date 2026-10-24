import { ID_RANDOM_BYTES, mintId } from "@waste/domain/ids"

import { dispatchedRouteFor, SEEDED_DRIVER } from "./dispatched-route"
import { E2E, uniqueName } from "./env"
import { accessTokenOf, apiAs, expect, freshContext, signIn, test } from "./fixtures"
import { answerOf, pick, toasts } from "./routes-support"
import { listAll } from "./tester"

// Pickup Exceptions on the Pilot (#293 M5). A route generated on a seeded
// scheme and dispatched (dispatched-route.ts) is run by the seeded driver:
// a stop at a property failed for contamination, the day ended. The office
// adds a charge rule in Settings › Commercial › Exception charges — a
// failure for contamination coded with a code of this run's, none free, a
// ladder of two products — tags the stop with the code through Correct
// outcome, and the property's details list the exception, charged the
// ladder's first product as the first in the window. The rule is then ended
// on the stop's service date through its edit, which the judgement survives:
// the rule was in force that day. Every body is the one the contracts take,
// read off the browser's own request. The code is this run's, so the rule
// never overlaps an earlier run's on a long-lived stack; it is retired
// at the end.

type Product = { id: string; name: string }
type Code = { id: string; code: string; name: string }

/** One command as the Driver App queues it: an id the device mints, the route, the instant, the device. */
const commandOf = (kind: string, routeId: string, body: Record<string, unknown>, at: Date) => ({
  id: mintId(at.getTime(), crypto.getRandomValues(new Uint8Array(ID_RANDOM_BYTES))),
  kind,
  routeId,
  occurredAt: at.toISOString(),
  deviceId: "e2e-pickup-exceptions",
  body,
})

const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)

test("the office charges a coded contamination by a rule in Settings, tags the stop with the code, and the property lists the exception charged the ladder's first product", async ({ api, page, browser }) => {
  test.setTimeout(180_000)
  const { route } = await dispatchedRouteFor(api)
  if (route.planned.vehicleId === null) throw new Error(`${route.label} was dispatched with no vehicle`)
  const stop = route.pickups.find((pickup) => pickup.propertyId !== null)
  if (stop === undefined || stop.propertyId === null) throw new Error(`${route.label} has no stop at a property`)
  const propertyId = stop.propertyId

  const products = await listAll<Product>(api, "/products", { projectId: route.projectId })
  const productNamed = (name: string) => {
    const found = products.find((product) => product.name === name)
    if (found === undefined) throw new Error(`the seed holds no product named ${name}`)
    return found
  }
  const [bulky, bagTag] = [productNamed("Bulky waste pickup"), productNamed("Extra bag tag")]
  const slug = `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const madeCode = await api.post("/contaminant-codes", { data: { code: slug, name: uniqueName("E2E Paint tins") } })
  expect(madeCode.status(), await madeCode.text()).toBe(201)
  const code = (await madeCode.json()) as Code

  try {
    // The driver runs the route: fails the property's stop for contamination, ends the day.
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
          commandOf("fail-pickup", route.id, { pickupId: stop.id, reason: "contamination" }, new Date(start + 1_000)),
          commandOf("end-route", route.id, {}, new Date(start + 2_000)),
        ]
        const sent = await asDriver.post("/driver/commands", { data: { commands } })
        expect(sent.status(), await sent.text()).toBe(200)
        expect(((await sent.json()) as { outcomes: { outcome: string }[] }).outcomes.map((outcome) => outcome.outcome)).toEqual(["applied", "applied", "applied"])
      } finally {
        await asDriver.dispose()
      }
    } finally {
      await context.close()
    }

    // The office adds the rule: a failure for contamination coded with this run's code, none free over 30 days, then the ladder.
    const project = (await (await api.get(`/projects/${route.projectId}`)).json()) as { id: string; name: string }
    const read = answerOf(page, "GET", "/pickup-exception-rules")
    await page.goto("/settings?pane=pickup-exception-charges")
    // The pane renders inside Settings, outside the workspace's main landmark.
    const pane = page.locator("body")
    await pick(pane, page, "Project", project.name)
    expect((await read).status()).toBe(200)
    await pane.getByRole("button", { name: "Add rule" }).click()
    const add = page.getByRole("dialog", { name: "Add rule" })
    await pick(add, page, "Outcome", "Failed")
    await pick(add, page, "Reason", "Contamination")
    await pick(add, page, "Contaminant code", code.name)
    await add.getByLabel("Free in the window").fill("0")
    await add.getByLabel("Window (days)").fill("30")
    await pick(add, page, "Step 1", bulky.name)
    await add.getByRole("button", { name: "Add step" }).click()
    await pick(add, page, "Step 2", bagTag.name)
    await add.getByLabel("First day in force").fill(route.serviceDate)
    const [created] = await Promise.all([answerOf(page, "POST", "/pickup-exception-rules"), add.getByRole("button", { name: "Add rule" }).click()])
    expect(created.status(), await created.text()).toBe(201)
    expect(created.request().postDataJSON()).toEqual({ projectId: project.id, outcome: "failed", reason: "contamination", contaminantCodeId: code.id, freeCount: 0, windowDays: 30, ladder: [bulky.id, bagTag.id], validFrom: route.serviceDate })
    const rule = (await created.json()) as { id: string }
    const matches = `Failed for contamination, coded ${code.name}`
    await expect(toasts(page)).toContainText(`${matches}: 1st ${bulky.name} · then ${bagTag.name} each time.`)
    const row = pane.getByRole("row", { name: matches })
    await expect(row).toContainText("None free · counted over 30 days")
    await expect(row).toContainText(`From ${route.serviceDate}`)

    // The office tags the failed stop with the code through its correction.
    await page.goto(`/route-studio?module=pickups&record=pickup-${stop.id}`)
    const stopDetails = page.getByRole("dialog").filter({ has: page.getByTestId("pickup-commands") })
    const correctButton = stopDetails.getByTestId("pickup-commands").getByRole("button", { name: "Correct outcome" })
    await expect(correctButton).toBeEnabled({ timeout: 30_000 })
    await correctButton.click()
    const correct = page.getByRole("dialog", { name: "Correct outcome" })
    await pick(correct, page, "Outcome", "Failed")
    await pick(correct, page, "Reason", "Contamination")
    await correct.getByRole("textbox", { name: /^Why it is corrected/ }).fill("Paint tins in the residual bin")
    await pick(correct, page, "Contaminant code", code.name)
    const [corrected] = await Promise.all([answerOf(page, "POST", `/pickups/${stop.id}/correct-outcome`), correct.getByRole("button", { name: "Correct outcome" }).click()])
    expect(corrected.status(), await corrected.text()).toBe(200)
    expect(corrected.request().postDataJSON()).toEqual({ outcome: "failed", reason: "contamination", note: "Paint tins in the residual bin", contaminantCodeId: code.id })
    await expect(stopDetails).toContainText(code.name)

    // The property's details list the exception, charged the ladder's first product.
    const history = answerOf(page, "GET", `/properties/${propertyId}/pickup-exceptions`)
    await page.goto(`/customers?module=properties&record=property-${propertyId}`)
    const sheet = page.getByRole("dialog").filter({ has: page.getByTestId("place-commands") })
    expect((await history).status()).toBe(200)
    const exception = sheet.getByTestId("pickup-exceptions").getByRole("listitem").filter({ hasText: code.name })
    await expect(exception).toContainText(`${route.serviceDate} · Failed: contamination, coded ${code.name}`, { timeout: 30_000 })
    await expect(exception).toContainText(`${bulky.name} · 1st in the window`)
    await expect(exception.getByRole("link", { name: "Open stop" })).toHaveAttribute("href", new RegExp(`record=pickup-${stop.id}`))

    // The rule ends on the stop's service date through its edit; the stop was judged under it that day, so its charge stands.
    await page.goto("/settings?pane=pickup-exception-charges")
    await pick(pane, page, "Project", project.name)
    await pane.getByRole("button", { name: `Edit ${matches}` }).click()
    const edit = page.getByRole("dialog", { name: "Edit rule" })
    await edit.getByLabel("Last day in force").fill(route.serviceDate)
    const [ended] = await Promise.all([answerOf(page, "PATCH", `/pickup-exception-rules/${rule.id}`), edit.getByRole("button", { name: "Save rule" }).click()])
    expect(ended.status(), await ended.text()).toBe(200)
    expect(ended.request().postDataJSON()).toEqual({ validTo: nextDay(route.serviceDate) })
    await expect(pane.getByRole("row", { name: matches })).toContainText(`${route.serviceDate} to ${route.serviceDate}`)
    const judged = (await (await api.get(`/properties/${propertyId}/pickup-exceptions`)).json()) as { items: { pickupId: string; judgement: { productId: string | null } | null }[] }
    expect(judged.items.find((item) => item.pickupId === stop.id)?.judgement?.productId).toBe(bulky.id)
  } finally {
    // Retired, so the next run's pickers never offer it; the stop keeps its tag.
    expect((await api.patch(`/contaminant-codes/${code.id}`, { data: { status: "inactive" } })).status()).toBe(200)
  }
})
