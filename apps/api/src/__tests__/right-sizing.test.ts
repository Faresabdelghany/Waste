// Right-sizing through the API (M23b of #293): a run reads each
// subscription's containers' latest fill estimates and proposes a size down
// or up — the catalogue's next size — or a frequency where none is sold;
// approve applies a size as the subscription's change in the same
// transaction, refused on stale evidence; a frequency's approval records the
// decision alone; dismiss says why, and holds until newer estimates; and
// approve asks the agreements' grant besides the module's.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Agreement, Subscription } from "@waste/contracts/agreements"
import { ContainerType, Product, WasteFraction } from "@waste/contracts/catalogue"
import { Container, ContainerServicePlacement } from "@waste/contracts/containers"
import { Customer, Property } from "@waste/contracts/customers"
import { Page } from "@waste/contracts/pagination"
import { RightSizingProposal, RightSizingRun } from "@waste/contracts/right-sizing"
import { createDb, type Database } from "@waste/db/client"
import { pickup, route } from "@waste/db/schema/execution"
import { withCompany } from "@waste/db/tenant"
import type { FillLevel } from "@waste/domain/execution/vocabulary"

import { createApp } from "../app"
import { A_DAY_FOR_THE_CHANGE, A_FREQUENCY_CHANGES_NO_PRODUCT, alreadyDecided, STALE_EVIDENCE } from "../routes/right-sizing"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { stocked, warehouseIn } from "./stock-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys } from "./tokens"

const database = databaseUnderTest()
const owner = ownerUnderTest()

const NOW = new Date("2026-10-29T12:00:00Z")
const JANUARY = "2026-01-01"
const NOVEMBER = "2026-11-01"
const ProposalPage = Page(RightSizingProposal)

describe("right-sizing", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let a: Tenant
  let olivia: Call
  let viewer: Call
  let fraction: WasteFraction
  let customer: Customer
  let warehouse: string
  const products: Record<"p140" | "p240" | "p660", Product> = {} as never
  const bins: Record<"p140" | "p240" | "p660", ContainerType> = {} as never
  let number = 9000

  type Schema<T> = { parse: (value: unknown) => T }
  const create = async <T>(call: Call, path: string, values: unknown, schema: Schema<T>): Promise<T> => {
    const response = await call(path, { method: "POST", body: values })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    return schema.parse(await response.json())
  }

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    const keys = await signingKeys()
    a = await seedTenant(pool)
    // The viewer may decide proposals but not change a subscription: approve asks both.
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: "customers.right-sizing", actions: ["view", "edit", "create"] }])
    const app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOW })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    warehouse = await warehouseIn(pool, a.companyId, a.projects.copenhagen.id, "WH-RS")
    fraction = await create(olivia, "/waste-fractions", { key: "residual", name: "Residual waste" }, WasteFraction)
    customer = await create(olivia, "/customers", { kind: "organisation", name: "Fjord Housing" }, Customer)
    for (const [key, litres] of [
      ["p140", 140],
      ["p240", 240],
      ["p660", 660],
    ] as const) {
      bins[key] = await create(olivia, "/container-types", { name: `${litres} L bin`, volumeLitres: litres }, ContainerType)
      products[key] = await create(
        olivia,
        "/products",
        { projectId: a.projects.copenhagen.id, name: `Residual ${litres} L`, kind: "container-collection", unit: "pickup", containerTypeId: bins[key].id, wasteFractionId: fraction.id, status: "active" },
        Product,
      )
    }
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  /** A subscription of `product` at a property of its own, its container placed under it, and one completed stop per estimate, newest first, a day apart before the clock. */
  async function subscribedWith(name: string, product: "p140" | "p240" | "p660", fills: readonly FillLevel[]): Promise<{ subscription: Subscription; container: Container; property: Property }> {
    const property = await create(olivia, "/properties", { projectId: a.projects.copenhagen.id, name, address: `${name} 1, 2100 København Ø`, kind: "residential" }, Property)
    const agreement = await create(
      olivia,
      "/agreements",
      { projectId: a.projects.copenhagen.id, number: `AGR-${name.replace(/\W/g, "")}`, customerId: customer.id, payerCustomerId: customer.id, billingCadence: "monthly", currency: "DKK", validFrom: JANUARY },
      Agreement,
    )
    const subscription = await create(olivia, `/agreements/${agreement.id}/subscriptions`, { productId: products[product].id, propertyId: property.id, validFrom: JANUARY }, Subscription)
    const container = await stocked(olivia, { projectId: a.projects.copenhagen.id, label: `BIN-${name.replace(/\W/g, "")}`, containerTypeId: bins[product].id }, warehouse)
    await create(olivia, `/containers/${container.id}/placements`, { subscriptionId: subscription.id, wasteFractionId: fraction.id, validFrom: JANUARY }, ContainerServicePlacement)
    await estimated(container.id, property.id, fills, 1)
    return { subscription, container, property }
  }

  /** One completed stop per estimate at the container (on a route left planned: the stamps a run carries are not what this reads), newest first, the first `startDaysAgo` days before the clock. */
  async function estimated(containerId: string, propertyId: string, fills: readonly FillLevel[], startDaysAgo: number) {
    await withCompany(pool.db, a.companyId, async (tx) => {
      for (const [index, fill] of fills.entries()) {
        const day = new Date(NOW.getTime() - (startDaysAgo + index) * 86_400_000).toISOString().slice(0, 10)
        const routeId = testId()
        await tx.insert(route).values({ id: routeId, companyId: a.companyId, projectId: a.projects.copenhagen.id, serviceDate: day, operatingDate: day, status: "planned", number: (number += 1) })
        await tx.insert(pickup).values({
          id: testId(),
          companyId: a.companyId,
          projectId: a.projects.copenhagen.id,
          routeId,
          containerId,
          position: 1,
          status: "completed",
          propertyId,
          wasteFractionId: fraction.id,
          outcomeAt: new Date(`${day}T08:00:00Z`),
          fillLevel: fill,
        })
      }
    })
  }

  const run = async (call: Call = olivia): Promise<number> => {
    const response = await call("/right-sizing-proposals/run", { method: "POST" })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return RightSizingRun.parse(await response.json()).proposed
  }
  const proposalsOf = async (subscriptionId: string) => ProposalPage.parse(await (await olivia(`/right-sizing-proposals?subscriptionId=${subscriptionId}`)).json()).items
  const decide = async (id: string, verb: "approve" | "dismiss", body: unknown, call: Call = olivia) => call(`/right-sizing-proposals/${id}/${verb}`, { method: "POST", body })

  test("a half-empty bin is proposed a size down, and approved into the subscription's change from the day, in one go", async () => {
    const { subscription } = await subscribedWith("Lindevej 3", "p240", ["quarter", "half", "empty", "quarter"])
    assert.ok((await run()) >= 1)
    const [proposal] = await proposalsOf(subscription.id)
    assert.deepEqual([proposal.direction, proposal.suggestedProductId, proposal.status, proposal.evidence], ["smaller", products.p140.id, "open", ["quarter", "half", "empty", "quarter"]])
    assert.equal(await run(), 0, "one open proposal per subscription")

    const refused = await readProblem(await decide(proposal.id, "approve", {}))
    assert.deepEqual(refused.errors, [{ path: "on", message: A_DAY_FOR_THE_CHANGE }])
    const response = await decide(proposal.id, "approve", { on: NOVEMBER })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    const approved = RightSizingProposal.parse(await response.json())
    assert.deepEqual([approved.status, approved.changedOn, approved.decidedBy], ["approved", NOVEMBER, a.users.olivia.id])
    const replacement = Subscription.parse(await (await olivia(`/subscriptions/${approved.replacementSubscriptionId}`)).json())
    assert.deepEqual([replacement.productId, replacement.validFrom], [products.p140.id, NOVEMBER])
    const ended = Subscription.parse(await (await olivia(`/subscriptions/${subscription.id}`)).json())
    assert.equal(ended.validTo, NOVEMBER)
    const again = await readProblem(await decide(proposal.id, "approve", { on: NOVEMBER }))
    assert.deepEqual([again.status, again.detail], [409, alreadyDecided("approved")])
  })

  test("a subscription changed since the proposal was made refuses its approve: the evidence is stale", async () => {
    const { subscription } = await subscribedWith("Lindevej 5", "p240", ["empty", "empty", "quarter", "empty"])
    await run()
    const [proposal] = await proposalsOf(subscription.id)
    const patched = await olivia(`/subscriptions/${subscription.id}`, { method: "PATCH", body: { quantity: 2 } })
    assert.equal(patched.status, 200, JSON.stringify(await patched.clone().json()))
    const stale = await readProblem(await decide(proposal.id, "approve", { on: NOVEMBER }))
    assert.deepEqual([stale.status, stale.detail], [409, STALE_EVIDENCE])
    assert.equal(Subscription.parse(await (await olivia(`/subscriptions/${subscription.id}`)).json()).validTo, null, "nothing changed")
  })

  test("an overflowing bin of the largest size is proposed more collections, approved as a decision alone", async () => {
    const { subscription } = await subscribedWith("Lindevej 7", "p660", ["overflowing", "full", "overflowing", "full"])
    await run()
    const [proposal] = await proposalsOf(subscription.id)
    assert.deepEqual([proposal.direction, proposal.suggestedProductId], ["more-frequent", null])
    const withADay = await readProblem(await decide(proposal.id, "approve", { on: NOVEMBER }))
    assert.deepEqual(withADay.errors, [{ path: "on", message: A_FREQUENCY_CHANGES_NO_PRODUCT }])
    const approved = RightSizingProposal.parse(await (await decide(proposal.id, "approve", {})).json())
    assert.deepEqual([approved.status, approved.changedOn, approved.replacementSubscriptionId], ["approved", null, null])
    assert.equal(Subscription.parse(await (await olivia(`/subscriptions/${subscription.id}`)).json()).validTo, null)
  })

  test("a dismissal says why and holds until the drivers say something new", async () => {
    const { subscription, container, property } = await subscribedWith("Lindevej 9", "p240", ["overflowing", "overflowing", "full", "full"])
    await run()
    const [proposal] = await proposalsOf(subscription.id)
    assert.deepEqual([proposal.direction, proposal.suggestedProductId], ["bigger", products.p660.id])
    assert.equal((await decide(proposal.id, "dismiss", {})).status, 400)
    const dismissed = RightSizingProposal.parse(await (await decide(proposal.id, "dismiss", { note: "A party weekend; the customer keeps the size" })).json())
    assert.deepEqual([dismissed.status, dismissed.dismissNote], ["dismissed", "A party weekend; the customer keeps the size"])
    await run()
    assert.equal((await proposalsOf(subscription.id)).length, 1, "no newer estimate, no new proposal")
    // A newer overflow, today: the evidence moved.
    await estimated(container.id, property.id, ["overflowing"], 0)
    await run()
    const now = await proposalsOf(subscription.id)
    assert.deepEqual(
      now.map((row) => row.status),
      ["dismissed", "open"],
    )
  })

  test("approve asks the agreements' grant besides the module's; another company's proposal is not there", async () => {
    const { subscription } = await subscribedWith("Lindevej 11", "p240", ["half", "half", "quarter", "half"])
    assert.ok((await run(viewer)) >= 1, "the viewer runs it over Copenhagen, the project it works in")
    const [proposal] = await proposalsOf(subscription.id)
    assert.equal((await decide(proposal.id, "approve", { on: NOVEMBER }, viewer)).status, 403)
    assert.equal((await decide(proposal.id, "dismiss", { note: "Not now" }, viewer)).status, 200, "a dismissal changes nothing the agreements' grant guards")
  })
})
