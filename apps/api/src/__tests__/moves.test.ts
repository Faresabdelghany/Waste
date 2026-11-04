// A move (#374, #291 C11): `POST /properties/:id/moves` changes a property's
// occupant on a day. The outgoing customer's parties there end on the day and
// the incoming customer takes the same roles from it; the outgoing customer's
// subscriptions at the property end with their placements, and one agreement
// for the incoming customer begins there with the same products and the
// containers carried over, never leaving service. The outgoing agreement ends
// too where nothing of it runs past the day elsewhere. `chargesToCredit` lists
// the outgoing subscriptions' recurring charges whose period crosses or
// follows the day, invoiced or not, and nothing is repriced (the owner's
// decision on #374). `dryRun` answers the same and writes nothing.
//
// The charges are a billing run's own: October's run invoices a month-sold
// subscription's October and, in advance, its November, so a move on 20
// October, told on 20 November, crosses the one and precedes the other.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Agreement, Subscription } from "@waste/contracts/agreements"
import { BillingRunDetail } from "@waste/contracts/billing"
import { ContainerType, Product, WasteFraction } from "@waste/contracts/catalogue"
import { ContainerServicePlacement } from "@waste/contracts/containers"
import { Customer, Property } from "@waste/contracts/customers"
import { MoveOutcome } from "@waste/contracts/moves"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { containerServicePlacement } from "@waste/db/schema/containers"
import { agreement as agreementTable, subscription as subscriptionTable } from "@waste/db/schema/agreements"
import { propertyParty } from "@waste/db/schema/customers"
import { priceListRow } from "@waste/db/schema/finance"
import { withCompany } from "@waste/db/tenant"
import { and, asc, eq } from "drizzle-orm"

import { createApp } from "../app"
import { seedBilling, type BillingFixtures } from "./billing-fixtures"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { seedExecution } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning } from "./scheme-fixtures"
import { stocked, warehouseIn } from "./stock-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the invoices the run writes and the ledger rows the stocked containers do, which `wms_api` may not delete. */
const owner = ownerUnderTest()

/** The request's clock: 20 November 2026, past October, so October's run is for a closed period. */
const NOON = new Date("2026-11-20T12:00:00Z")
/** The move's day: inside October, whose charge the run invoices, before November, whose charge it minted in advance. */
const ON = "2026-10-20"

describe("POST /properties/:id/moves (#374)", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let fx: BillingFixtures
  let olivia: Call
  /** A role that edits properties and nothing of agreements: the move changes both, so it is refused. */
  let viewer: Call
  let copenhagen: string
  let residual: WasteFraction
  let bin: ContainerType
  let collection: Product
  /** Sold by the month, so a billing run charges it (#291 C2). */
  let rental: Product
  let warehouse: string
  let owner_: Customer
  let leaving: Customer
  let arriving: Customer
  let administrator: Customer

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    copenhagen = a.projects.copenhagen.id
    fx = await seedBilling(pool, a, await seedExecution(pool, a, await seedFleet(pool, a, await seedPlanning(pool, a))))
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: "customers.properties", actions: ["view", "edit"] }])
    const app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOON })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    residual = await make(olivia, "/waste-fractions", { key: "residual-moves", name: "Residual waste (moves)" }, WasteFraction)
    bin = await make(olivia, "/container-types", { name: "240 L bin (moves)", volumeLitres: 240 }, ContainerType)
    collection = await make(olivia, "/products", { projectId: copenhagen, name: "Residual collection (moves)", kind: "container-collection", unit: "pickup", status: "active" }, Product)
    rental = await make(olivia, "/products", { projectId: copenhagen, name: "Bin rental (moves)", kind: "recurring-service", unit: "month", status: "active", vatPercent: 25 }, Product)
    await withCompany(pool.db, a.companyId, (tx: Tx) =>
      tx.insert(priceListRow).values({ id: testId(), companyId: a.companyId, projectId: copenhagen, priceListId: fx.priceLists.default.id, productId: rental.id, unitPriceMinor: 31_000, validFrom: "2026-01-01" }),
    )
    warehouse = await warehouseIn(pool, a.companyId, copenhagen, "WH-MOVE")
    owner_ = await make(olivia, "/customers", { kind: "organisation", name: "Landlord ApS" }, Customer)
    leaving = await make(olivia, "/customers", { kind: "person", name: "Ida Leaving" }, Customer)
    arriving = await make(olivia, "/customers", { kind: "person", name: "Bo Arriving" }, Customer)
    administrator = await make(olivia, "/customers", { kind: "organisation", name: "Housing administrator" }, Customer)
  })
  type Schema<T> = { parse: (value: unknown) => T }
  /** A create through the API, 201 and its body parsed. */
  async function make<T extends { id: string }>(call: Call, path: string, values: unknown, schema: Schema<T>): Promise<T> {
    return created(call, path, await call(path, { method: "POST", body: values }), schema)
  }

  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  /** A property the landlord owns and `tenant` rents and pays for from January. */
  const rented = async (name: string, tenant = leaving): Promise<Property> => {
    const property = await make(olivia, "/properties", { projectId: copenhagen, name, address: `${name}, 2100 København Ø`, kind: "residential" }, Property)
    await withCompany(pool.db, a.companyId, (tx: Tx) =>
      tx.insert(propertyParty).values(
        [
          { customerId: owner_.id, role: "owner" },
          { customerId: tenant.id, role: "tenant" },
          { customerId: tenant.id, role: "payer" },
        ].map((party) => ({ id: testId(), companyId: a.companyId, projectId: copenhagen, propertyId: property.id, validFrom: "2026-01-01", ...party })),
      ),
    )
    return property
  }

  /** The tenant's agreement from January, priced under the project's list. */
  const agreementOf = (number: string, customer = leaving) =>
    make(
      olivia,
      "/agreements",
      { projectId: copenhagen, number, customerId: customer.id, payerCustomerId: customer.id, status: "active", billingCadence: "monthly", currency: "DKK", priceListId: fx.priceLists.default.id, validFrom: "2026-01-01" },
      Agreement,
    )

  /** A subscription of `product` at `property` from January, a bin issued under it where `bin` says so. */
  const subscribed = async (of: Agreement, property: Property, product: Product, withBin = false) => {
    const subscription = await make(olivia, `/agreements/${of.id}/subscriptions`, { productId: product.id, propertyId: property.id, validFrom: "2026-01-01" }, Subscription)
    if (!withBin) return { subscription, container: undefined }
    const container = await stocked(olivia, { projectId: copenhagen, label: `BIN-${testId().slice(-8)}`, containerTypeId: bin.id }, warehouse)
    await make(olivia, `/containers/${container.id}/placements`, { subscriptionId: subscription.id, wasteFractionId: residual.id, validFrom: "2026-01-01" }, ContainerServicePlacement)
    return { subscription, container }
  }

  const move = (call: Call, propertyId: string, body: Record<string, unknown>) => call(`/properties/${propertyId}/moves`, { method: "POST", body: { on: ON, outgoingCustomerId: leaving.id, incomingCustomerId: arriving.id, ...body } })
  const moved = async (call: Call, propertyId: string, body: Record<string, unknown>): Promise<MoveOutcome> => {
    const response = await move(call, propertyId, body)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return MoveOutcome.parse(await response.json())
  }
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }

  type PartyRow = { customerId: string; role: string; validFrom: string; validTo: string | null }
  /** Rows in one order whatever ids the test minted: who, as what, from when. */
  const inKeyOrder = (rows: readonly PartyRow[]) => [...rows].sort((x, y) => `${x.customerId} ${x.role} ${x.validFrom}`.localeCompare(`${y.customerId} ${y.role} ${y.validFrom}`))

  /** Every party row of a property, as the table holds them: who, as what, from when until when. */
  const partyRows = (propertyId: string) =>
    withCompany(pool.db, a.companyId, (tx: Tx) =>
      tx
        .select({ customerId: propertyParty.customerId, role: propertyParty.role, validFrom: propertyParty.validFrom, validTo: propertyParty.validTo })
        .from(propertyParty)
        .where(eq(propertyParty.propertyId, propertyId))
        .orderBy(asc(propertyParty.validFrom), asc(propertyParty.customerId), asc(propertyParty.role)),
    )

  test("ends the outgoing tenant's roles and subscriptions on the day, gives the incoming one the same roles and a new agreement with the same products, and carries the bins over", async () => {
    const property = await rented("Østerbrogade 120")
    const elsewhere = await rented("Østerbrogade 122")
    const outgoing = await agreementOf("AGR-M1")
    const emptied = await subscribed(outgoing, property, collection, true)
    const rentedBin = await subscribed(outgoing, property, rental)
    const kept = await subscribed(outgoing, elsewhere, collection)
    const run = await make(olivia, "/billing-runs", { projectId: copenhagen, periodFrom: "2026-10-01", periodTo: "2026-10-31" }, BillingRunDetail)
    assert.ok(run.id)

    const outcome = await moved(olivia, property.id, { agreementNumber: "AGR-M1N", payerCustomerId: administrator.id })
    assert.equal(outcome.dryRun, false)
    assert.equal(outcome.on, ON)

    assert.deepEqual(
      inKeyOrder(await partyRows(property.id)),
      inKeyOrder([
        { customerId: owner_.id, role: "owner", validFrom: "2026-01-01", validTo: null },
        { customerId: leaving.id, role: "payer", validFrom: "2026-01-01", validTo: ON },
        { customerId: leaving.id, role: "tenant", validFrom: "2026-01-01", validTo: ON },
        { customerId: arriving.id, role: "payer", validFrom: ON, validTo: null },
        { customerId: arriving.id, role: "tenant", validFrom: ON, validTo: null },
      ]),
      "the landlord's ownership is untouched; the tenant's two roles end on the day and the incoming one's begin there",
    )
    assert.deepEqual(outcome.property.parties.map((party) => `${party.customerId === arriving.id ? "arriving" : party.customerId === owner_.id ? "owner" : "leaving"} ${party.role}`).sort(), ["arriving payer", "arriving tenant", "owner owner"], "the property as the move leaves it, read on the request's clock: the departed tenant is no party now")

    assert.equal(outcome.outgoing.agreement?.id, outgoing.id)
    assert.equal(outcome.outgoing.agreement?.validTo, null, "the outgoing agreement goes on at the other property it serves")
    assert.deepEqual(outcome.outgoing.subscriptions.map((ended) => [ended.id, ended.validTo]).sort(), [[emptied.subscription.id, ON], [rentedBin.subscription.id, ON]].sort())

    const incoming = outcome.incoming.agreement
    assert.ok(incoming)
    assert.deepEqual(
      { number: incoming.number, customerId: incoming.customerId, payerCustomerId: incoming.payerCustomerId, status: incoming.status, billingCadence: incoming.billingCadence, currency: incoming.currency, priceListId: incoming.priceListId, validFrom: incoming.validFrom, validTo: incoming.validTo },
      { number: "AGR-M1N", customerId: arriving.id, payerCustomerId: administrator.id, status: "active", billingCadence: "monthly", currency: "DKK", priceListId: fx.priceLists.default.id, validFrom: ON, validTo: null },
      "active, under the outgoing agreement's cadence, currency and list, invoicing the payer the body named",
    )
    assert.deepEqual(outcome.incoming.subscriptions.map((started) => [started.productId, started.propertyId, started.quantity, started.validFrom, started.validTo]).sort(), [
      [collection.id, property.id, 1, ON, null],
      [rental.id, property.id, 1, ON, null],
    ].sort())

    assert.deepEqual(outcome.containersCarried, [emptied.container?.id])
    const placements = await withCompany(pool.db, a.companyId, (tx: Tx) =>
      tx
        .select({ subscriptionId: containerServicePlacement.subscriptionId, validFrom: containerServicePlacement.validFrom, validTo: containerServicePlacement.validTo })
        .from(containerServicePlacement)
        .where(eq(containerServicePlacement.containerId, emptied.container?.id ?? ""))
        .orderBy(asc(containerServicePlacement.validFrom)),
    )
    const carriedUnder = outcome.incoming.subscriptions.find((started) => started.productId === collection.id)?.id
    assert.deepEqual(placements, [
      { subscriptionId: emptied.subscription.id, validFrom: "2026-01-01", validTo: ON },
      { subscriptionId: carriedUnder, validFrom: ON, validTo: null },
    ], "the bin never left service: its placement went on under the incoming subscription from the day")

    assert.deepEqual(
      outcome.chargesToCredit.map((charge) => [charge.subscriptionId, charge.charge?.periodFrom, charge.status]),
      [
        [rentedBin.subscription.id, "2026-10-01", "invoiced"],
        [rentedBin.subscription.id, "2026-11-01", "invoiced"],
      ],
      "October's charge crosses the day and November's, charged in advance by October's own run, follows it: both invoiced, neither repriced",
    )

    const [stillKept] = await withCompany(pool.db, a.companyId, (tx: Tx) => tx.select({ validTo: subscriptionTable.validTo }).from(subscriptionTable).where(eq(subscriptionTable.id, kept.subscription.id)))
    assert.equal(stillKept.validTo, null, "a subscription of the agreement at another property is not the move's")
  })

  test("ends the outgoing agreement on the day where nothing of it runs elsewhere", async () => {
    const property = await rented("Østerbrogade 124")
    const outgoing = await agreementOf("AGR-M2")
    await subscribed(outgoing, property, collection, true)
    const outcome = await moved(olivia, property.id, { agreementNumber: "AGR-M2N" })
    assert.equal(outcome.outgoing.agreement?.validTo, ON)
    assert.equal(outcome.incoming.agreement?.payerCustomerId, arriving.id, "the incoming customer pays where the body names no payer")
  })

  test("a dry run answers what the move would do and writes nothing", async () => {
    const property = await rented("Østerbrogade 126")
    const outgoing = await agreementOf("AGR-M3")
    const { container } = await subscribed(outgoing, property, collection, true)
    const before = await partyRows(property.id)
    const rehearsed = await moved(olivia, property.id, { agreementNumber: "AGR-M3N", dryRun: true })
    assert.equal(rehearsed.dryRun, true)
    assert.equal(rehearsed.incoming.agreement?.number, "AGR-M3N")
    assert.deepEqual(rehearsed.containersCarried, [container?.id])
    assert.equal(rehearsed.outgoing.agreement?.validTo, ON)
    assert.deepEqual(await partyRows(property.id), before, "no party moved")
    const agreements = await withCompany(pool.db, a.companyId, (tx: Tx) => tx.select({ number: agreementTable.number, validTo: agreementTable.validTo }).from(agreementTable).where(and(eq(agreementTable.companyId, a.companyId))))
    assert.equal(agreements.some((row) => row.number === "AGR-M3N"), false, "no agreement was written")
    assert.equal(agreements.find((row) => row.number === "AGR-M3")?.validTo, null, "and the outgoing one still runs")
    const moving = await moved(olivia, property.id, { agreementNumber: "AGR-M3N" })
    assert.equal(moving.incoming.agreement?.number, "AGR-M3N", "the number a dry run named is free for the move itself")
  })

  test("moves the parties alone where the outgoing customer subscribes at the property nowhere, and needs no number for it", async () => {
    const property = await rented("Østerbrogade 128")
    const outcome = await moved(olivia, property.id, {})
    assert.deepEqual(outcome.outgoing, { agreement: null, subscriptions: [] })
    assert.deepEqual(outcome.incoming, { agreement: null, subscriptions: [] })
    assert.deepEqual(outcome.containersCarried, [])
    assert.ok(outcome.property.parties.some((party) => party.customerId === arriving.id && party.role === "tenant"))
  })

  test("a sale is a move: the owner's role goes to the buyer and the tenant stays", async () => {
    const property = await rented("Østerbrogade 130")
    const outcome = await moved(olivia, property.id, { outgoingCustomerId: owner_.id, incomingCustomerId: administrator.id })
    assert.deepEqual(outcome.property.parties.map((party) => `${party.customerId === administrator.id ? "buyer" : party.customerId === leaving.id ? "tenant" : "seller"} ${party.role}`).sort(), ["buyer owner", "tenant payer", "tenant tenant"])
  })

  test("refuses a property out of reach (404), a body that will not do (400), and a move the property's state refuses (409), in that order", async () => {
    await refused(await move(olivia, testId(), { agreementNumber: "AGR-X" }), 404)

    const property = await rented("Østerbrogade 132")
    const outgoing = await agreementOf("AGR-M5")
    await subscribed(outgoing, property, collection)

    const stranger = await refused(await move(olivia, property.id, { incomingCustomerId: testId(), agreementNumber: "AGR-M5N" }), 400)
    assert.deepEqual(stranger.errors?.map((error) => error.path), ["incomingCustomerId"])
    const unnumbered = await refused(await move(olivia, property.id, {}), 400)
    assert.deepEqual(unnumbered.errors?.map((error) => error.path), ["agreementNumber"], "the outgoing customer subscribes here, so the incoming agreement needs a number")

    const nobody = await refused(await move(olivia, property.id, { outgoingCustomerId: administrator.id, agreementNumber: "AGR-M5N" }), 409)
    assert.match(nobody.detail ?? "", /no party of this property on 2026-10-20/)

    const second = await agreementOf("AGR-M5B")
    await subscribed(second, property, rental)
    const two = await refused(await move(olivia, property.id, { agreementNumber: "AGR-M5N" }), 409)
    assert.match(two.detail ?? "", /AGR-M5.*AGR-M5B|AGR-M5B.*AGR-M5/, "the office ends one of them first, by name")
  })

  test("refuses a subscription that begins on or after the day, and an inactive incoming customer, as 409s", async () => {
    const property = await rented("Østerbrogade 134")
    const outgoing = await agreementOf("AGR-M6")
    await make(olivia, `/agreements/${outgoing.id}/subscriptions`, { productId: collection.id, propertyId: property.id, validFrom: ON }, Subscription)
    const later = await refused(await move(olivia, property.id, { agreementNumber: "AGR-M6N" }), 409)
    assert.match(later.detail ?? "", /begins on or after/)

    const quiet = await rented("Østerbrogade 136")
    const inactive = await make(olivia, "/customers", { kind: "person", name: "Not here any more", status: "inactive" }, Customer)
    const gone = await refused(await move(olivia, quiet.id, { incomingCustomerId: inactive.id }), 409)
    assert.match(gone.detail ?? "", /inactive/)
  })

  test("asks edit on the agreements as well as on the properties, since it writes both", async () => {
    const property = await rented("Østerbrogade 138")
    const problem = await refused(await move(viewer, property.id, {}), 403)
    assert.match(problem.detail ?? "", /customers\.agreements/)
  })
})
