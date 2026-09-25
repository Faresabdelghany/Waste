import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { BillableEvent, OVERRIDE_WITH_A_REASON } from "@waste/contracts/billable-events"
import { BillingRunDetail } from "@waste/contracts/billing"
import { Page } from "@waste/contracts/pagination"
import { DAY_WINDOW_ORDERED } from "@waste/contracts/queries"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { product } from "@waste/db/schema/catalogue"
import { priceList, priceListRow } from "@waste/db/schema/finance"
import { withCompany } from "@waste/db/tenant"
import type { BillableEventStatus } from "@waste/domain/finance/vocabulary"
import { and, eq } from "drizzle-orm"

import { createApp } from "../app"
import { uniqueConstraintOf } from "../problem"
import { DRAFT_AGREEMENT_BY_HAND, NO_VAT_RATE_BY_HAND, notCancelled, notRepriced, ONLY_A_TICKETS_EVENT_TAKES_A_PRODUCT, REVERSAL_NOT_CANCELLED } from "../routes/billable-events"
import { NOT_AN_AGREEMENT } from "../routes/references"
import { consumerEvent, pickupEvent, reversalEvent, seedBilling, ticketEvent, type BillingFixtures } from "./billing-fixtures"
import { callingAs, type Call } from "./calls"
import { nextMillisecond } from "./clock"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { seedExecution, type ExecutionFixtures } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning } from "./scheme-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the proofs the fixtures append and the invoice lines the runs here write, which `wms_api` may not delete. */
const owner = ownerUnderTest()
const EventPage = Page(BillableEvent)

const MODULE = "commercial.events"

/** The request's clock, pinned: noon on the fixtures' Monday, so a stamp is known. */
const NOON = new Date("2026-10-05T12:00:00Z")

describe("the billable event endpoints", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  /** The company under test. */
  let a: Tenant
  /** The other company: to prove a's events are invisible to it. */
  let b: Tenant
  let ex: ExecutionFixtures
  let fx: BillingFixtures
  let app: ReturnType<typeof createApp>
  let olivia: Call
  /** The custom role, granted view, edit and create, with Project Access to Copenhagen Central only. */
  let viewer: Call
  /** The Service Provider Manager, granted the module here: a role that reaches no project of the company. */
  let lars: Call
  let other: Call
  /** A role with `configure.access` and nothing else: the 403s. */
  let ungranted: Call
  let copenhagen: string
  let harbor: string

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    copenhagen = a.projects.copenhagen.id
    harbor = a.projects.harbor.id
    const fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
    ex = await seedExecution(pool, a, fleet)
    fx = await seedBilling(pool, a, ex)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: MODULE, actions: ["view", "edit", "create"] }])
    await grantRole(pool, a.companyId, a.roles.providerManager.id, [{ moduleKey: MODULE, actions: ["view", "create"] }])
    app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOON })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    lars = callingAs(app, keys, a.users.lars, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    ungranted = callingAs(app, keys, b.users.viewer, b.companyId)
  })

  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    if (b) await dropTenant(pool, b.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }

  /** A manual event's body: AGR-100, residual collection, one, on the Monday, unless said. */
  const manual = (overrides: Record<string, unknown> = {}) => ({ projectId: copenhagen, agreementId: fx.agreements.housingDkk.id, productId: fx.products.residual.id, quantity: 1, serviceDate: fx.day, ...overrides })

  const entered = async (body: Record<string, unknown>, call: Call = olivia): Promise<BillableEvent> => created(call, "/billable-events", await call("/billable-events", { method: "POST", body }), BillableEvent)

  const read = async (id: string, call: Call = olivia): Promise<BillableEvent> => {
    const response = await call(`/billable-events/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return BillableEvent.parse(await response.json())
  }

  const command = async (id: string, verb: "reprice" | "cancel", body: Record<string, unknown> = {}, call: Call = olivia): Promise<Response> => call(`/billable-events/${id}/${verb}`, { method: "POST", body })

  const commanded = async (id: string, verb: "reprice" | "cancel", body: Record<string, unknown> = {}, call: Call = olivia): Promise<BillableEvent> => {
    const response = await command(id, verb, body, call)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return BillableEvent.parse(await response.json())
  }

  /** Runs billing over one day as Olivia, so the events of that day read `invoiced`. */
  const invoiced = async (day: string): Promise<BillingRunDetail> => {
    const response = await olivia("/billing-runs", { method: "POST", body: { projectId: copenhagen, periodFrom: day, periodTo: day } })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    return BillingRunDetail.parse(await response.json())
  }

  const NO_PRICE = { unitPriceMinor: null, netMinor: null, vatPercent: null, vatMinor: null, currency: null, priceListRowId: null }

  describe("the manual create", () => {
    test("prices the event by the resolver against the seeded list — the negotiated row winning for its customer, the default row for another — and answers it ready with Location", async () => {
      const housing = await entered(manual({ note: "Extra emptying agreed by phone" }))
      assert.deepEqual(
        [housing.kind, housing.status, housing.projectId, housing.agreementId, housing.productId, housing.quantity, housing.serviceDate],
        ["manual", "ready", copenhagen, fx.agreements.housingDkk.id, fx.products.residual.id, 1, fx.day],
      )
      assert.deepEqual(
        [housing.unitPriceMinor, housing.netMinor, housing.vatPercent, housing.vatMinor, housing.currency, housing.priceListRowId],
        [10_000, 10_000, 25, 2_500, "DKK", fx.rows.residualHousing.id],
        "the negotiated row always wins for the housing association",
      )
      assert.deepEqual([housing.blockReason, housing.createdBy, housing.sourceEventId, housing.overrideReason, housing.note, housing.subscriptionId], [null, a.users.olivia.id, null, null, "Extra emptying agreed by phone", null])
      assert.deepEqual(housing.links, { routeId: null, pickupId: null, ticketId: null, reversesEventId: null })
      assert.deepEqual([housing.cancelledAt, housing.cancelledBy, housing.cancelReason, housing.invoiceLineId], [null, null, null, null])

      const anna = await entered(manual({ agreementId: fx.agreements.anna.id, quantity: 2 }))
      assert.deepEqual([anna.status, anna.unitPriceMinor, anna.netMinor, anna.vatMinor, anna.priceListRowId], ["ready", 12_000, 24_000, 6_000, fx.rows.residual.id], "the default row, twice")
    })

    test("blocks the event with the reason that stood in the way — a draft agreement, no list in force, no row for the product, no VAT rate — and keeps it as a fact", async () => {
      const draft = await entered(manual({ agreementId: fx.agreements.draft.id }))
      assert.deepEqual([draft.status, draft.blockReason, ...Object.values(NO_PRICE).map(() => null)], ["blocked", "agreement-draft", null, null, null, null, null, null])
      assert.deepEqual({ unitPriceMinor: draft.unitPriceMinor, netMinor: draft.netMinor, vatPercent: draft.vatPercent, vatMinor: draft.vatMinor, currency: draft.currency, priceListRowId: draft.priceListRowId }, NO_PRICE)
      assert.deepEqual([draft.agreementId, draft.productId], [fx.agreements.draft.id, fx.products.residual.id], "what it was under is kept beside the block")

      const noList = await entered(manual({ projectId: harbor, agreementId: fx.agreements.harbor.id, productId: fx.products.harborBulky.id }))
      assert.deepEqual([noList.status, noList.blockReason], ["blocked", "no-price-list"], "Harbor Commercial has no default list")

      const noRow = await entered(manual({ agreementId: fx.agreements.housingEur.id, productId: fx.products.bulky.id }))
      assert.deepEqual([noRow.status, noRow.blockReason], ["blocked", "no-price-row"], "the EUR list prices no bulky pickup")

      const noRate = await entered(manual({ productId: fx.products.bulky.id }))
      assert.deepEqual([noRate.status, noRate.blockReason], ["blocked", "no-vat-rate"], "a row at 350.00 kr, and a product with no rate")
    })

    test("takes a price of the person's own with its reason and stands it with no row, in the agreement's currency at the product's rate; refuses the pair half given, and refuses it under a draft agreement or a product with no rate", async () => {
      const byHand = await entered(manual({ unitPriceMinor: 9_900, overrideReason: "Goodwill after the missed collection", quantity: 3 }))
      assert.deepEqual(
        [byHand.status, byHand.unitPriceMinor, byHand.netMinor, byHand.vatPercent, byHand.vatMinor, byHand.currency, byHand.priceListRowId, byHand.overrideReason],
        ["ready", 9_900, 29_700, 25, 7_425, "DKK", null, "Goodwill after the missed collection"],
      )

      const noReason = await refused(await olivia("/billable-events", { method: "POST", body: manual({ unitPriceMinor: 9_900 }) }), 400)
      assert.deepEqual(noReason.errors, [{ path: "overrideReason", message: OVERRIDE_WITH_A_REASON }])
      const noPrice = await refused(await olivia("/billable-events", { method: "POST", body: manual({ overrideReason: "A reason without a price" }) }), 400)
      assert.deepEqual(noPrice.errors, [{ path: "overrideReason", message: OVERRIDE_WITH_A_REASON }])

      const draft = await refused(await olivia("/billable-events", { method: "POST", body: manual({ agreementId: fx.agreements.draft.id, unitPriceMinor: 9_900, overrideReason: "By hand" }) }), 409)
      assert.equal(draft.detail, DRAFT_AGREEMENT_BY_HAND)
      const noRate = await refused(await olivia("/billable-events", { method: "POST", body: manual({ productId: fx.products.bulky.id, unitPriceMinor: 9_900, overrideReason: "By hand" }) }), 409)
      assert.equal(noRate.detail, NO_VAT_RATE_BY_HAND)
    })

    test("refuses a project the caller does not work in, an agreement or a product of another project, a member the server owns, and an unoffered product after every 400", async () => {
      const outside = await refused(await viewer("/billable-events", { method: "POST", body: manual({ projectId: harbor, agreementId: fx.agreements.harbor.id, productId: fx.products.harborBulky.id }) }), 400)
      assert.deepEqual(outside.errors?.map((error) => error.path), ["projectId"])
      const none = await refused(await lars("/billable-events", { method: "POST", body: manual() }), 400)
      assert.deepEqual(none.errors?.map((error) => error.path), ["projectId"], "an account that works in no project names no project it may enter an event in")

      const foreignAgreement = await refused(await olivia("/billable-events", { method: "POST", body: manual({ agreementId: fx.agreements.harbor.id }) }), 400)
      assert.deepEqual(foreignAgreement.errors, [{ path: "agreementId", message: NOT_AN_AGREEMENT }])
      const foreignProduct = await refused(await olivia("/billable-events", { method: "POST", body: manual({ productId: fx.products.harborBulky.id }) }), 400)
      assert.deepEqual(foreignProduct.errors, [{ path: "productId", message: "Not a product of this project" }])

      const owned = await refused(await olivia("/billable-events", { method: "POST", body: manual({ status: "ready" }) }), 400)
      assert.deepEqual(owned.errors?.map((error) => error.path), ["status"])

      const unoffered = await refused(await olivia("/billable-events", { method: "POST", body: manual({ productId: fx.products.inactive.id }) }), 409)
      assert.equal(unoffered.detail, "The product is inactive; only an active product can be subscribed to")

      await refused(await ungranted("/billable-events", { method: "POST", body: manual() }), 403)
    })
  })

  describe("reprice", () => {
    test("mends each block in turn as the office adds the list, the row and the rate, and refuses the priced event afterwards", async () => {
      const event = await entered(manual({ projectId: harbor, agreementId: fx.agreements.harbor.id, productId: fx.products.harborBulky.id }))
      assert.equal(event.blockReason, "no-price-list")
      const same = await commanded(event.id, "reprice")
      assert.deepEqual([same.status, same.blockReason], ["blocked", "no-price-list"], "nothing mended, the same block")

      const listId = testId()
      const rowId = testId()
      await withCompany(pool.db, a.companyId, async (tx: Tx) => {
        await tx.insert(priceList).values({ id: listId, companyId: a.companyId, projectId: harbor, code: "PL-HBR-2026", name: "Harbor tariff 2026", currency: "DKK", isDefault: true, validFrom: "2026-01-01" })
      })
      const noRow = await commanded(event.id, "reprice")
      assert.deepEqual([noRow.status, noRow.blockReason], ["blocked", "no-price-row"], "the next block: a list and no row")

      await withCompany(pool.db, a.companyId, async (tx: Tx) => {
        await tx.insert(priceListRow).values({ id: rowId, companyId: a.companyId, projectId: harbor, priceListId: listId, productId: fx.products.harborBulky.id, unitPriceMinor: 20_000, validFrom: "2026-01-01" })
      })
      const noRate = await commanded(event.id, "reprice")
      assert.deepEqual([noRate.status, noRate.blockReason], ["blocked", "no-vat-rate"], "the next block: a row and no rate")

      await withCompany(pool.db, a.companyId, async (tx: Tx) => {
        await tx.update(product).set({ vatPercent: 25 }).where(and(eq(product.companyId, a.companyId), eq(product.id, fx.products.harborBulky.id)))
      })
      await nextMillisecond()
      const priced = await commanded(event.id, "reprice")
      assert.deepEqual(
        [priced.status, priced.blockReason, priced.unitPriceMinor, priced.netMinor, priced.vatPercent, priced.vatMinor, priced.currency, priced.priceListRowId],
        ["ready", null, 20_000, 20_000, 25, 5_000, "DKK", rowId],
        "priced by the mended list, the row traceable",
      )
      assert.ok(priced.updatedAt > event.updatedAt, "a reprice is the row's history: the stamp moves")

      const again = await refused(await command(event.id, "reprice"), 409)
      assert.equal(again.detail, notRepriced(event.id, "ready"))
    })

    test("takes the office's product on a ticket's event and refuses one on any other kind; the product is held to the project and to being offered", async () => {
      const ticket = await ticketEvent(pool, a, fx)
      assert.deepEqual([ticket.kind, ticket.status, ticket.blockReason, ticket.productId], ["ticket", "blocked", "no-product", null])
      assert.notEqual(ticket.links.ticketId, null)

      const still = await commanded(ticket.id, "reprice")
      assert.deepEqual([still.status, still.blockReason, still.productId], ["blocked", "no-product", null], "no product picked yet: the same block")

      const foreign = await refused(await command(ticket.id, "reprice", { productId: fx.products.harborBulky.id }), 400)
      assert.deepEqual(foreign.errors, [{ path: "productId", message: "Not a product of this project" }])
      const unoffered = await refused(await command(ticket.id, "reprice", { productId: fx.products.inactive.id }), 409)
      assert.equal(unoffered.detail, "The product is inactive; only an active product can be subscribed to")

      const priced = await commanded(ticket.id, "reprice", { productId: fx.products.residual.id })
      assert.deepEqual([priced.status, priced.productId, priced.unitPriceMinor, priced.netMinor, priced.vatMinor, priced.priceListRowId, priced.kind], ["ready", fx.products.residual.id, 10_000, 10_000, 2_500, fx.rows.residualHousing.id, "ticket"])

      const blockedManual = await entered(manual({ agreementId: fx.agreements.draft.id }))
      const notATicket = await refused(await command(blockedManual.id, "reprice", { productId: fx.products.residual.id }), 400)
      assert.deepEqual(notATicket.errors, [{ path: "productId", message: ONLY_A_TICKETS_EVENT_TAKES_A_PRODUCT }])
    })

    test("answers an event blocked with no subscription as it stands: there is no agreement to price under", async () => {
      const orphan = await consumerEvent(pool, a, {
        projectId: copenhagen,
        draft: { kind: "pickup", serviceDate: fx.day, agreementId: null, subscriptionId: null, productId: null, quantity: 1, price: null, blockReason: "no-subscription", links: { routeId: ex.routes.completed.id, pickupId: ex.routes.completed.pickupIds[1], ticketId: null, reversesEventId: null } },
      })
      const same = await commanded(orphan.id, "reprice")
      assert.deepEqual([same.status, same.blockReason, same.updatedAt], ["blocked", "no-subscription", orphan.updatedAt])
    })

    test("refuses a cancelled, an invoiced and a reversed event in the status's words", async () => {
      const day = "2026-10-06"
      const cancelled = await entered(manual({ serviceDate: day }))
      await commanded(cancelled.id, "cancel", { reason: "duplicate" })
      assert.equal((await refused(await command(cancelled.id, "reprice"), 409)).detail, notRepriced(cancelled.id, "cancelled"))

      const charged = await entered(manual({ serviceDate: day, agreementId: fx.agreements.anna.id }))
      const reversedLater = await entered(manual({ serviceDate: day, agreementId: fx.agreements.anna.id, quantity: 2 }))
      await invoiced(day)
      const charging = await read(charged.id)
      assert.equal(charging.status, "invoiced")
      assert.notEqual(charging.invoiceLineId, null, "the line that charges for it")
      assert.equal((await refused(await command(charged.id, "reprice"), 409)).detail, notRepriced(charged.id, "invoiced"))

      await reversalEvent(pool, a, await read(reversedLater.id))
      assert.equal((await read(reversedLater.id)).status, "reversed")
      assert.equal((await refused(await command(reversedLater.id, "reprice"), 409)).detail, notRepriced(reversedLater.id, "reversed"))
    })

    test("is the family's 404 across tenants and projects, and 403 without the grant", async () => {
      const event = await entered(manual({ projectId: harbor, agreementId: fx.agreements.harbor.id, productId: fx.products.harborBulky.id }))
      await refused(await command(event.id, "reprice", {}, other), 404)
      await refused(await command(event.id, "reprice", {}, viewer), 404)
      await refused(await viewer(`/billable-events/${event.id}`), 404)
      await refused(await other(`/billable-events/${event.id}`), 404)
      await refused(await ungranted(`/billable-events/${event.id}`), 403)
      await refused(await command(event.id, "cancel", { reason: "other" }, ungranted), 403)
    })
  })

  describe("cancel", () => {
    test("stamps a ready event and a blocked one with the caller, the clock and the reason, replaces the note when one is given, and answers a cancelled one as it stands", async () => {
      const ready = await entered(manual({ note: "The entry" }))
      const cancelled = await commanded(ready.id, "cancel", { reason: "duplicate", note: "Entered twice" })
      assert.deepEqual([cancelled.status, cancelled.cancelledAt, cancelled.cancelledBy, cancelled.cancelReason, cancelled.note], ["cancelled", NOON.toISOString(), a.users.olivia.id, "duplicate", "Entered twice"])
      assert.deepEqual([cancelled.netMinor, cancelled.priceListRowId], [10_000, fx.rows.residualHousing.id], "the frozen price stands on the row")

      await nextMillisecond()
      const again = await commanded(ready.id, "cancel", { reason: "other" })
      assert.deepEqual([again.status, again.cancelReason, again.cancelledAt, again.updatedAt], ["cancelled", "duplicate", cancelled.cancelledAt, cancelled.updatedAt], "idempotent: the first cancellation stands, nothing written")

      const blocked = await entered(manual({ agreementId: fx.agreements.draft.id, note: "Kept" }))
      const gone = await commanded(blocked.id, "cancel", { reason: "not-delivered" }, viewer)
      assert.deepEqual([gone.status, gone.blockReason, gone.cancelReason, gone.cancelledBy, gone.note], ["cancelled", "agreement-draft", "not-delivered", a.users.viewer.id, "Kept"], "a blocked event is cancelled too, its block and its note kept")
    })

    test("refuses an invoiced event, a reversed one, a reversal, and the consumer's reason", async () => {
      const day = "2026-10-07"
      const charged = await entered(manual({ serviceDate: day, agreementId: fx.agreements.anna.id }))
      const undone = await entered(manual({ serviceDate: day, agreementId: fx.agreements.anna.id, quantity: 2 }))
      await invoiced(day)
      assert.equal((await refused(await command(charged.id, "cancel", { reason: "duplicate" }), 409)).detail, notCancelled(charged.id, "invoiced"))

      const reversal = await reversalEvent(pool, a, await read(undone.id))
      assert.deepEqual([reversal.kind, reversal.status, reversal.netMinor, reversal.vatMinor, reversal.links.reversesEventId], ["reversal", "ready", -24_000, -6_000, undone.id])
      assert.equal((await refused(await command(undone.id, "cancel", { reason: "duplicate" }), 409)).detail, notCancelled(undone.id, "reversed"))
      assert.equal((await refused(await command(reversal.id, "cancel", { reason: "duplicate" }), 409)).detail, REVERSAL_NOT_CANCELLED)

      const consumers = await refused(await command(charged.id, "cancel", { reason: "pickup-corrected" }), 400)
      assert.deepEqual(consumers.errors?.map((error) => error.path), ["reason"])
    })
  })

  describe("the list", () => {
    /** A page as Olivia reads it, every item parsed. */
    const page = async (query: string, call: Call = olivia) => {
      const response = await call(`/billable-events?${query}`)
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
      return EventPage.parse(await response.json())
    }

    test("answers each reading through the status filter, and every row with its status and the line that invoiced it", async () => {
      const day = "2026-10-08"
      const ready = await entered(manual({ serviceDate: day, agreementId: fx.agreements.anna.id, quantity: 3 }))
      const blocked = await entered(manual({ serviceDate: day, agreementId: fx.agreements.draft.id }))
      const cancelled = await entered(manual({ serviceDate: day }))
      await commanded(cancelled.id, "cancel", { reason: "other" })
      const charged = await entered(manual({ serviceDate: day, agreementId: fx.agreements.housingEur.id }))
      const undone = await pickupEvent(pool, a, fx, ex, { serviceDate: day })
      assert.deepEqual([undone.kind, undone.status, undone.unitPriceMinor, undone.subscriptionId, undone.links.routeId, undone.links.pickupId], ["pickup", "ready", 10_000, fx.subscriptions.housingResidual.id, ex.routes.completed.id, ex.routes.completed.pickupIds[0]])
      const run = await invoiced(day)
      assert.equal(run.invoiceCount, 3, "the housing association twice, DKK and EUR, and Anna")
      const reversal = await reversalEvent(pool, a, await read(undone.id))

      const expected: Record<BillableEventStatus, string> = { ready: reversal.id, blocked: blocked.id, cancelled: cancelled.id, invoiced: charged.id, reversed: undone.id }
      for (const [status, id] of Object.entries(expected) as [BillableEventStatus, string][]) {
        const listed = await page(`status=${status}&from=${day}&to=${day}&limit=200`)
        assert.ok(listed.items.every((item) => item.status === status), `every item of ?status=${status} reads ${status}`)
        assert.ok(listed.items.some((item) => item.id === id), `?status=${status} lists the ${status} event`)
        for (const otherId of Object.values(expected).filter((candidate) => candidate !== id)) {
          assert.ok(!listed.items.some((item) => item.id === otherId), `?status=${status} leaves the other readings out`)
        }
      }
      assert.ok((await page(`status=ready&from=${day}&to=${day}`)).items.every((item) => item.id !== ready.id), "the run invoiced what was ready")
      const charging = (await page(`status=invoiced&from=${day}&to=${day}&limit=200`)).items.find((item) => item.id === ready.id)
      assert.notEqual(charging?.invoiceLineId, null)
    })

    test("filters by the payer through the agreement, by kind, block reason, agreement, product, route, pickup and ticket, and by a window of service dates", async () => {
      const day = "2026-10-09"
      const housing = await entered(manual({ serviceDate: day }))
      const housingEur = await entered(manual({ serviceDate: day, agreementId: fx.agreements.housingEur.id }))
      const anna = await entered(manual({ serviceDate: day, agreementId: fx.agreements.anna.id }))
      const ticket = await ticketEvent(pool, a, fx, { serviceDate: day })
      const pickedUp = await pickupEvent(pool, a, fx, ex, { serviceDate: day, pickupIndex: 2 })

      const byPayer = await page(`customerId=${fx.customers.housing.id}&from=${day}&to=${day}&limit=200`)
      assert.ok(byPayer.items.every((item) => item.agreementId === fx.agreements.housingDkk.id || item.agreementId === fx.agreements.housingEur.id), "the payer's agreements only")
      assert.deepEqual([byPayer.items.some((item) => item.id === housing.id), byPayer.items.some((item) => item.id === housingEur.id), byPayer.items.some((item) => item.id === anna.id)], [true, true, false])

      assert.deepEqual((await page(`kind=ticket&from=${day}&to=${day}`)).items.map((item) => item.id), [ticket.id])
      assert.deepEqual((await page(`blockReason=no-product&from=${day}&to=${day}`)).items.map((item) => item.id), [ticket.id])
      assert.deepEqual((await page(`agreementId=${fx.agreements.anna.id}&from=${day}&to=${day}`)).items.map((item) => item.id), [anna.id])
      assert.ok((await page(`productId=${fx.products.residual.id}&from=${day}&to=${day}`)).items.every((item) => item.productId === fx.products.residual.id))
      assert.deepEqual((await page(`routeId=${ex.routes.completed.id}&from=${day}&to=${day}`)).items.map((item) => item.id), [pickedUp.id])
      assert.deepEqual((await page(`pickupId=${ex.routes.completed.pickupIds[2]}&from=${day}&to=${day}`)).items.map((item) => item.id), [pickedUp.id])
      assert.deepEqual((await page(`ticketId=${ticket.links.ticketId}`)).items.map((item) => item.id), [ticket.id])
      assert.deepEqual((await page(`projectId=${copenhagen}&from=${day}&to=${day}&kind=manual&limit=200`)).items.map((item) => item.id).sort(), [housing.id, housingEur.id, anna.id].sort())
      assert.deepEqual((await page(`from=2026-10-10&to=2026-10-10&kind=manual`)).items, [], "a window with nothing in it")

      const backwards = await refused(await olivia(`/billable-events?from=${day}&to=2026-10-01`), 400)
      assert.deepEqual(backwards.errors, [{ path: "to", message: DAY_WINDOW_ORDERED }])
      const foreignPayer = await refused(await olivia(`/billable-events?customerId=${testId()}`), 400)
      assert.deepEqual(foreignPayer.errors?.map((error) => error.path), ["customerId"])
      const foreignProject = await refused(await viewer(`/billable-events?projectId=${harbor}`), 400)
      assert.deepEqual(foreignProject.errors?.map((error) => error.path), ["projectId"])
    })

    test("is bounded by the caller's projects and the tenant: the viewer sees no Harbor event, an account with no project an empty page, another company nothing", async () => {
      const harbors = await entered(manual({ projectId: harbor, agreementId: fx.agreements.harbor.id, productId: fx.products.harborBulky.id }))
      const viewers = await page("limit=200", viewer)
      assert.ok(viewers.items.length > 0)
      assert.ok(viewers.items.every((item) => item.projectId === copenhagen), "Copenhagen Central only")
      assert.ok(!viewers.items.some((item) => item.id === harbors.id))
      assert.deepEqual(await page("limit=5", lars), { items: [], nextCursor: null })
      assert.ok(!(await page("limit=200", other)).items.some((item) => item.projectId === copenhagen || item.projectId === harbor))
      await refused(await ungranted("/billable-events"), 403)
    })
  })

  describe("the consumer's door", () => {
    test("records an event with no person and the outbox event's id, and the database refuses the same event twice: the idempotency key", async () => {
      const sourceEventId = testId()
      const first = await consumerEvent(pool, a, { projectId: copenhagen, draft: { kind: "ticket", serviceDate: fx.day, agreementId: fx.agreements.anna.id, subscriptionId: null, productId: null, quantity: 1, price: null, blockReason: "no-product", links: { routeId: null, pickupId: null, ticketId: (await ticketEvent(pool, a, fx)).links.ticketId, reversesEventId: null } }, sourceEventId })
      assert.deepEqual([first.createdBy, first.sourceEventId, first.status], [null, sourceEventId, "blocked"])
      assert.deepEqual(await read(first.id), first, "the row as recorded is the row as read")
      await assert.rejects(
        consumerEvent(pool, a, { projectId: copenhagen, draft: { ...first, price: null, links: first.links }, sourceEventId }),
        (error: unknown) => uniqueConstraintOf(error) === "billable_event_source_event_id_idx",
        "one row per outbox event, whatever the row is",
      )
    })
  })
})
