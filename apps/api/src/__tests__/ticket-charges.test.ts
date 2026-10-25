import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { CHARGE_WITH_A_BILLABLE_RESOLUTION, KIND_CHARGED_ONCE, Ticket, TicketCharges } from "@waste/contracts/tickets"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { product } from "@waste/db/schema/catalogue"
import { outboxEvent } from "@waste/db/schema/execution"
import { withCompany } from "@waste/db/tenant"
import { and, desc, eq } from "drizzle-orm"

import { createApp } from "../app"
import { NOT_A_PRODUCT } from "../routes/references"
import { unofferedProduct } from "../routes/statuses"
import { MONTH_PRODUCT_IS_NOT_TICKET_WORK } from "../routes/ticket-charges"
import { seedBilling, ticketEvent, type BillingFixtures } from "./billing-fixtures"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { seedExecution } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning } from "./scheme-fixtures"
import { dropTenant, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const owner = ownerUnderTest()

describe("ticket work priced (#291 C3)", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let fx: BillingFixtures
  let olivia: Call
  let copenhagen: string
  /** A product sold by the month: a recurring charge, never a ticket's work. */
  const rental = testId()

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    copenhagen = a.projects.copenhagen.id
    const ex = await seedExecution(pool, a, await seedFleet(pool, a, await seedPlanning(pool, a)))
    fx = await seedBilling(pool, a, ex)
    await withCompany(pool.db, a.companyId, (tx: Tx) => tx.insert(product).values({ id: rental, companyId: a.companyId, projectId: copenhagen, name: "Container rental", kind: "recurring-service", status: "active", unit: "month", vatPercent: 25 }))
    const app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
  })

  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    if (b) await dropTenant(pool, b.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  const charges = async (): Promise<TicketCharges> => {
    const response = await olivia(`/ticket-charges?projectId=${copenhagen}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return TicketCharges.parse(await response.json())
  }
  const put = (set: { kind: string; productId: string }[], projectId = copenhagen) => olivia("/ticket-charges", { method: "PUT", body: { projectId, charges: set } })
  const replaced = async (set: { kind: string; productId: string }[]): Promise<TicketCharges> => {
    const response = await put(set)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return TicketCharges.parse(await response.json())
  }
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const retire = (id: string, status: "active" | "inactive") => withCompany(pool.db, a.companyId, (tx: Tx) => tx.update(product).set({ status }).where(and(eq(product.companyId, a.companyId), eq(product.id, id))))

  const opened = async (): Promise<Ticket> =>
    created(olivia, "/tickets", await olivia("/tickets", { method: "POST", body: { projectId: copenhagen, kind: "overflow", subject: "Overflowing bin", description: "Bags beside the bin at Parkvej 18", links: { agreementId: fx.agreements.housingDkk.id } } }), Ticket)
  const complete = (id: string, body: Record<string, unknown>) => olivia(`/tickets/${id}/complete`, { method: "POST", body: { note: "Emptied again on Friday", ...body } })

  test("a project's charges are read and replaced whole: a kind once, each product the project's, never one sold by the month, offered when it is new or changed — a charge restated as it stands is no new reference", async () => {
    assert.deepEqual(await charges(), { projectId: copenhagen, charges: [] })
    const set = await replaced([
      { kind: "overflow", productId: fx.products.bulky.id },
      { kind: "missed-collection", productId: fx.products.residual.id },
    ])
    assert.deepEqual(set.charges, [{ kind: "missed-collection", productId: fx.products.residual.id }, { kind: "overflow", productId: fx.products.bulky.id }], "in the kinds' order")
    assert.deepEqual(await charges(), set)

    assert.deepEqual((await refused(await put([{ kind: "overflow", productId: rental }]), 400)).errors, [{ path: "charges.0.productId", message: MONTH_PRODUCT_IS_NOT_TICKET_WORK }])
    assert.deepEqual((await refused(await put([{ kind: "complaint", productId: fx.products.residual.id }, { kind: "overflow", productId: fx.products.harborBulky.id }]), 400)).errors, [{ path: "charges.1.productId", message: NOT_A_PRODUCT }], "Harbor's product")
    assert.deepEqual((await refused(await put([{ kind: "overflow", productId: fx.products.bulky.id }, { kind: "overflow", productId: fx.products.residual.id }]), 400)).errors, [{ path: "charges", message: KIND_CHARGED_ONCE }])
    assert.equal((await refused(await put([{ kind: "complaint", productId: fx.products.inactive.id }]), 409)).detail, unofferedProduct("inactive"), "a new charge at a retired product")
    assert.deepEqual((await refused(await put([], b.projects.copenhagen.id), 400)).errors, [{ path: "projectId", message: "Not a project this account works in" }])
    assert.deepEqual(await charges(), set, "every refusal wrote nothing")

    // The bulky pickup retired since: restated as it stands it is no new reference, and a change to it would be.
    await retire(fx.products.bulky.id, "inactive")
    try {
      const restated = await replaced([
        { kind: "overflow", productId: fx.products.bulky.id },
        { kind: "container-request", productId: fx.products.residual.id },
      ])
      assert.deepEqual(restated.charges, [{ kind: "overflow", productId: fx.products.bulky.id }, { kind: "container-request", productId: fx.products.residual.id }], "missed-collection left out, container-request added")
      assert.equal((await refused(await put([{ kind: "container-request", productId: fx.products.bulky.id }]), 409)).detail, unofferedProduct("inactive"), "moved onto the retired product")
    } finally {
      await retire(fx.products.bulky.id, "active")
    }
    assert.deepEqual((await replaced([])).charges, [], "an empty set charges no kind")
  })

  test("complete names the product the work is charged at — with a re-collection or a service alone, the project's, never one sold by the month, offered — and reopen clears it", async () => {
    const ticket = await opened()
    assert.deepEqual((await refused(await complete(ticket.id, { resolution: "answered", productId: fx.products.residual.id }), 400)).errors, [{ path: "productId", message: CHARGE_WITH_A_BILLABLE_RESOLUTION }])
    assert.deepEqual((await refused(await complete(ticket.id, { resolution: "serviced", productId: rental }), 400)).errors, [{ path: "productId", message: MONTH_PRODUCT_IS_NOT_TICKET_WORK }])
    assert.deepEqual((await refused(await complete(ticket.id, { resolution: "serviced", productId: fx.products.harborBulky.id }), 400)).errors, [{ path: "productId", message: NOT_A_PRODUCT }])
    assert.equal((await refused(await complete(ticket.id, { resolution: "serviced", productId: fx.products.inactive.id }), 409)).detail, unofferedProduct("inactive"))

    const response = await complete(ticket.id, { resolution: "serviced", productId: fx.products.residual.id })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    const done = Ticket.parse(await response.json())
    assert.deepEqual([done.status, done.resolution, done.chargeProductId], ["completed", "serviced", fx.products.residual.id])
    // The completion's event carries it to Finance.
    const [published] = await withCompany(pool.db, a.companyId, (tx: Tx) =>
      tx
        .select({ payload: outboxEvent.payload })
        .from(outboxEvent)
        .where(and(eq(outboxEvent.companyId, a.companyId), eq(outboxEvent.aggregateId, ticket.id), eq(outboxEvent.kind, "ticket-completed")))
        .orderBy(desc(outboxEvent.id))
        .limit(1),
    )
    assert.equal(Ticket.parse(published.payload).chargeProductId, fx.products.residual.id)

    const reopened = await olivia(`/tickets/${ticket.id}/reopen`, { method: "POST", body: { note: "The bags are back" } })
    assert.equal(reopened.status, 200)
    assert.deepEqual([Ticket.parse(await reopened.json()).chargeProductId], [null], "a reopened ticket charges nothing until it is completed again")
    const plain = await complete(ticket.id, { resolution: "recollected" })
    assert.equal(Ticket.parse(await plain.json()).chargeProductId, null, "a completion naming none leaves the kind's charge to stand in")
  })

  test("reprice gives a ticket's event no product sold by the month: a recurring charge is never a ticket's work", async () => {
    const event = await ticketEvent(pool, a, fx)
    const response = await olivia(`/billable-events/${event.id}/reprice`, { method: "POST", body: { productId: rental } })
    assert.deepEqual((await refused(response, 400)).errors, [{ path: "productId", message: MONTH_PRODUCT_IS_NOT_TICKET_WORK }])
  })
})
