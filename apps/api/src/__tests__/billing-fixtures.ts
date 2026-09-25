// What the billing suites need of Finance beyond their own routes (Issue
// #112, slice 4): the rows slice 3's routes write — a project's default price
// list with its rows, a named list in another currency, the products the
// rows price with their invoicing fields, the customers and the agreements
// the events run under — written directly through `tx` as `wms_api` inside
// `withCompany`, the way tenant.ts seeds its company and execution-fixtures.ts
// seeds the routes a pickup event names, and dropped with the rest of the
// company by `dropTenant`. The consumer's door is here too: `consumerEvent`
// records a domain draft the way part B's handler will, through
// `recordBillableEvent` with no person and an outbox event's id, so the
// suites can put a `pickup` event, a `ticket` event and a `reversal` on the
// table — rows no route of part A writes — and prove the readings, the run
// and the credit note over them.
//
// The ground: two customers with signed agreements in Copenhagen Central —
// Østerbro Housing Association, an organisation with an agreement priced
// under the default list in DKK and a second under the EUR list, and Anna
// Andersen, a person — a third whose only agreement is a draft (every event
// of his blocks), and one agreement in Harbor Commercial, a project with no
// default list (`no-price-list` until a suite adds one). Three products:
// residual collection per pickup at 25 % VAT, invoiced as "Restaffald 240 L";
// a bulky pickup per job with no VAT rate (`no-vat-rate` until a suite sets
// one); and a retired service, inactive, for the #79 gate. The default list
// prices residual collection at 120.00 kr, at 100.00 kr for the housing
// association by a negotiated row, and the bulky pickup at 350.00 kr; the
// EUR list prices residual collection at 16.00 EUR and nothing else.
import type { BillableEvent } from "@waste/contracts/billable-events"
import type { Database, Tx } from "@waste/db/client"
import { agreement, subscription } from "@waste/db/schema/agreements"
import { product } from "@waste/db/schema/catalogue"
import { customer } from "@waste/db/schema/customers"
import { priceList, priceListRow } from "@waste/db/schema/finance"
import { ticket } from "@waste/db/schema/resolution"
import { withCompany } from "@waste/db/tenant"
import { reversalOf, type BillableEventDraft } from "@waste/domain/finance/from-event"
import type { PricedAmounts } from "@waste/domain/finance/pricing"

import { newId } from "../ids"
import { priceDraft, recordBillableEvent } from "../routes/billable-writes"
import { nextTicketNumber } from "../routes/ticket-writes"
import type { ExecutionFixtures } from "./execution-fixtures"
import { testId, type Tenant } from "./tenant"

export type BillingFixtures = {
  /** The day the seeded routes ran and every event here falls on unless a suite says otherwise: the execution fixtures' Monday. */
  day: string
  customers: {
    /** An organisation, the payer of two agreements: one in DKK under the default list, one in EUR under the named list. */
    housing: { id: string; name: string }
    /** A person with an agreement of her own. */
    anna: { id: string; name: string }
    /** A person whose only agreement is a draft: every event of his blocks, and a run excludes him. */
    bo: { id: string; name: string }
  }
  products: {
    /** Copenhagen Central: a container collection per pickup at 25 % VAT, invoiced as "Restaffald 240 L". */
    residual: { id: string; name: string; invoiceName: string; vatPercent: number }
    /** Copenhagen Central: an additional service per job with no VAT rate. */
    bulky: { id: string; name: string }
    /** Copenhagen Central: inactive, the #79 gate's product. */
    inactive: { id: string; name: string }
    /** Harbor Commercial's bulky pickup, with no VAT rate: what a suite prices once it has given Harbor a list, a row and a rate. */
    harborBulky: { id: string; name: string }
  }
  priceLists: {
    /** Copenhagen Central's default list, in DKK, in force from 2026-01-01. */
    default: { id: string; code: string; currency: "DKK" }
    /** A named list in EUR, which the housing association's second agreement is priced under. */
    euro: { id: string; code: string; currency: "EUR" }
  }
  rows: {
    /** The default row for residual collection: 120.00 kr per pickup, no conditions. */
    residual: { id: string; unitPriceMinor: number }
    /** The negotiated row for the housing association: 100.00 kr, which always wins for them. */
    residualHousing: { id: string; unitPriceMinor: number }
    /** The bulky pickup's row: 350.00 kr per job. */
    bulky: { id: string; unitPriceMinor: number }
    /** The EUR list's row for residual collection: 16.00 EUR. */
    residualEuro: { id: string; unitPriceMinor: number }
  }
  agreements: {
    /** AGR-100: the housing association, active, DKK, the default list. */
    housingDkk: { id: string; number: string }
    /** AGR-101: the housing association, active, EUR, the EUR list. */
    housingEur: { id: string; number: string }
    /** AGR-102: Anna, active, DKK. */
    anna: { id: string; number: string }
    /** AGR-103: Bo, a draft. */
    draft: { id: string; number: string }
    /** AGR-104: Anna in Harbor Commercial, active, DKK, a project with no default list. */
    harbor: { id: string; number: string }
  }
  subscriptions: {
    /** Residual collection at Parkvej 18 under AGR-100: what a pickup event names. */
    housingResidual: { id: string }
  }
}

/** Seeds the billing ground on a tenant whose execution fixtures are laid; drop it with the company through `dropTenant`. */
export async function seedBilling(pool: Database, tenant: Tenant, ex: ExecutionFixtures): Promise<BillingFixtures> {
  const { companyId } = tenant
  const copenhagen = tenant.projects.copenhagen.id
  const harbor = tenant.projects.harbor.id
  const fixtures: BillingFixtures = {
    day: ex.day,
    customers: {
      housing: { id: testId(), name: "Østerbro Housing Association" },
      anna: { id: testId(), name: "Anna Andersen" },
      bo: { id: testId(), name: "Bo Berg" },
    },
    products: {
      residual: { id: testId(), name: "Residual collection", invoiceName: "Restaffald 240 L", vatPercent: 25 },
      bulky: { id: testId(), name: "Bulky pickup" },
      inactive: { id: testId(), name: "Retired service" },
      harborBulky: { id: testId(), name: "Bulky pickup" },
    },
    priceLists: {
      default: { id: testId(), code: "PL-CPH-2026", currency: "DKK" },
      euro: { id: testId(), code: "PL-CPH-EUR", currency: "EUR" },
    },
    rows: {
      residual: { id: testId(), unitPriceMinor: 12_000 },
      residualHousing: { id: testId(), unitPriceMinor: 10_000 },
      bulky: { id: testId(), unitPriceMinor: 35_000 },
      residualEuro: { id: testId(), unitPriceMinor: 1_600 },
    },
    agreements: {
      housingDkk: { id: testId(), number: "AGR-100" },
      housingEur: { id: testId(), number: "AGR-101" },
      anna: { id: testId(), number: "AGR-102" },
      draft: { id: testId(), number: "AGR-103" },
      harbor: { id: testId(), number: "AGR-104" },
    },
    subscriptions: { housingResidual: { id: testId() } },
  }
  const { customers, products, priceLists, rows, agreements } = fixtures

  await withCompany(pool.db, companyId, async (tx: Tx) => {
    await tx.insert(customer).values([
      { id: customers.housing.id, companyId, kind: "organisation", name: customers.housing.name, status: "active" },
      { id: customers.anna.id, companyId, kind: "person", name: customers.anna.name, status: "active" },
      { id: customers.bo.id, companyId, kind: "person", name: customers.bo.name, status: "active" },
    ])
    await tx.insert(product).values([
      {
        id: products.residual.id,
        companyId,
        projectId: copenhagen,
        name: products.residual.name,
        kind: "container-collection",
        status: "active",
        unit: "pickup",
        containerTypeId: ex.containerTypes.bin.id,
        wasteFractionId: ex.fractions.residual.id,
        invoiceName: products.residual.invoiceName,
        invoiceCode: "4010",
        vatPercent: products.residual.vatPercent,
      },
      { id: products.bulky.id, companyId, projectId: copenhagen, name: products.bulky.name, kind: "additional-service", status: "active", unit: "job" },
      { id: products.inactive.id, companyId, projectId: copenhagen, name: products.inactive.name, kind: "additional-service", status: "inactive", unit: "job" },
      { id: products.harborBulky.id, companyId, projectId: harbor, name: products.harborBulky.name, kind: "additional-service", status: "active", unit: "job" },
    ])
    await tx.insert(priceList).values([
      { id: priceLists.default.id, companyId, projectId: copenhagen, code: priceLists.default.code, name: "Copenhagen tariff 2026", currency: "DKK", isDefault: true, validFrom: "2026-01-01" },
      { id: priceLists.euro.id, companyId, projectId: copenhagen, code: priceLists.euro.code, name: "Copenhagen EUR list", currency: "EUR", isDefault: false, validFrom: "2026-01-01" },
    ])
    const row = (fixture: { id: string; unitPriceMinor: number }, listId: string, productId: string, conditions: { customerId?: string } = {}) => ({
      id: fixture.id,
      companyId,
      projectId: copenhagen,
      priceListId: listId,
      productId,
      unitPriceMinor: fixture.unitPriceMinor,
      customerId: conditions.customerId ?? null,
      validFrom: "2026-01-01",
    })
    await tx.insert(priceListRow).values([
      row(rows.residual, priceLists.default.id, products.residual.id),
      row(rows.residualHousing, priceLists.default.id, products.residual.id, { customerId: customers.housing.id }),
      row(rows.bulky, priceLists.default.id, products.bulky.id),
      row(rows.residualEuro, priceLists.euro.id, products.residual.id),
    ])
    const signed = (fixture: { id: string; number: string }, customerId: string, options: { projectId?: string; status?: string; currency?: string; priceListId?: string | null } = {}) => ({
      id: fixture.id,
      companyId,
      projectId: options.projectId ?? copenhagen,
      number: fixture.number,
      customerId,
      payerCustomerId: customerId,
      status: options.status ?? "active",
      billingCadence: "monthly",
      currency: options.currency ?? "DKK",
      priceListId: options.priceListId ?? null,
      validFrom: "2026-01-01",
    })
    await tx.insert(agreement).values([
      signed(agreements.housingDkk, customers.housing.id),
      signed(agreements.housingEur, customers.housing.id, { currency: "EUR", priceListId: priceLists.euro.id }),
      signed(agreements.anna, customers.anna.id),
      signed(agreements.draft, customers.bo.id, { status: "draft" }),
      signed(agreements.harbor, customers.anna.id, { projectId: harbor }),
    ])
    await tx.insert(subscription).values({
      id: fixtures.subscriptions.housingResidual.id,
      companyId,
      projectId: copenhagen,
      agreementId: agreements.housingDkk.id,
      productId: products.residual.id,
      propertyId: ex.properties.parkvej.id,
      quantity: 1,
      validFrom: "2026-01-01",
    })
  })

  return fixtures
}

/** The frozen price off an event on the wire, or null while it is blocked: what `reversalOf` copies. */
export function priceOf(event: BillableEvent): PricedAmounts | null {
  if (event.netMinor === null || event.unitPriceMinor === null || event.vatPercent === null || event.vatMinor === null || event.currency === null) return null
  return { priceListRowId: event.priceListRowId, unitPriceMinor: event.unitPriceMinor, netMinor: event.netMinor, vatPercent: event.vatPercent, vatMinor: event.vatMinor, currency: event.currency }
}

/** The consumer's door: records a domain draft as part B's handler will — no person, the outbox event's id as the idempotency key — and answers the event as the API reads it. */
export async function consumerEvent(pool: Database, tenant: Tenant, input: { projectId: string; draft: BillableEventDraft; sourceEventId?: string }): Promise<BillableEvent> {
  return await withCompany(pool.db, tenant.companyId, async (tx: Tx) => {
    const { answered } = await recordBillableEvent(tx, {
      companyId: tenant.companyId,
      projectId: input.projectId,
      draft: input.draft,
      overrideReason: null,
      note: null,
      createdBy: null,
      sourceEventId: input.sourceEventId ?? testId(),
      newId,
    })
    return answered
  })
}

export type PickupEventOptions = {
  /** Which pickup of the completed route, by index; the first, the completed one, unless said. */
  pickupIndex?: number
  /** AGR-100 and residual collection at Parkvej unless said. */
  agreementId?: string
  productId?: string
  subscriptionId?: string | null
  /** The route's day unless said. */
  serviceDate?: string
}

/**
 * A `pickup` event of the completed route, priced as the consumer prices it:
 * the resolver over the agreement's list on the service date with the
 * pickup's conditions — the scheme's planning area (none on the seeded
 * schemes), the bin's type, the residual fraction — or blocked with the
 * reason that stood in the way.
 */
export async function pickupEvent(pool: Database, tenant: Tenant, fixtures: BillingFixtures, ex: ExecutionFixtures, options: PickupEventOptions = {}): Promise<BillableEvent> {
  const projectId = tenant.projects.copenhagen.id
  const agreementId = options.agreementId ?? fixtures.agreements.housingDkk.id
  const productId = options.productId ?? fixtures.products.residual.id
  const serviceDate = options.serviceDate ?? fixtures.day
  const route = ex.routes.completed
  const pickupId = route.pickupIds[options.pickupIndex ?? 0]
  if (pickupId === undefined) throw new Error(`pickupEvent: the completed route has no pickup ${options.pickupIndex}`)
  return await withCompany(pool.db, tenant.companyId, async (tx: Tx) => {
    const outcome = await priceDraft(tx, { companyId: tenant.companyId, projectId }, { agreementId, productId, quantity: 1, serviceDate, planningAreaId: null, containerTypeId: ex.containerTypes.bin.id, wasteFractionId: ex.fractions.residual.id })
    const { answered } = await recordBillableEvent(tx, {
      companyId: tenant.companyId,
      projectId,
      draft: {
        kind: "pickup",
        serviceDate,
        agreementId,
        subscriptionId: options.subscriptionId === undefined ? fixtures.subscriptions.housingResidual.id : options.subscriptionId,
        productId,
        quantity: 1,
        price: outcome.price,
        blockReason: outcome.blockReason,
        links: { routeId: route.id, pickupId, ticketId: null, reversesEventId: null },
      },
      overrideReason: null,
      note: null,
      createdBy: null,
      sourceEventId: testId(),
      newId,
    })
    return answered
  })
}

/** A `ticket` event blocked `no-product`, the way `ticket-completed · recollected` records one, on a ticket seeded here for it to name; AGR-100 unless said. */
export async function ticketEvent(pool: Database, tenant: Tenant, fixtures: BillingFixtures, options: { agreementId?: string; serviceDate?: string } = {}): Promise<BillableEvent> {
  const projectId = tenant.projects.copenhagen.id
  const ticketId = testId()
  return await withCompany(pool.db, tenant.companyId, async (tx: Tx) => {
    const number = await nextTicketNumber(tx, tenant.companyId)
    await tx.insert(ticket).values({
      id: ticketId,
      companyId: tenant.companyId,
      projectId,
      number,
      kind: "missed-collection",
      source: "phone",
      subject: "Bin not emptied",
      description: "The bin at Parkvej 18 was not emptied on Monday.",
      occurredAt: new Date(`${fixtures.day}T09:00:00Z`),
      // A ticket is a person's or an event's (`ticket_origin_shape`): this one is Olivia's.
      createdBy: tenant.users.olivia.id,
    })
    const { answered } = await recordBillableEvent(tx, {
      companyId: tenant.companyId,
      projectId,
      draft: {
        kind: "ticket",
        serviceDate: options.serviceDate ?? fixtures.day,
        agreementId: options.agreementId ?? fixtures.agreements.housingDkk.id,
        subscriptionId: null,
        productId: null,
        quantity: 1,
        price: null,
        blockReason: "no-product",
        links: { routeId: null, pickupId: null, ticketId, reversesEventId: null },
      },
      overrideReason: null,
      note: null,
      createdBy: null,
      sourceEventId: testId(),
      newId,
    })
    return answered
  })
}

/** The `reversal` of an invoiced event, as the consumer records one on `pickup-corrected` to `skipped`: the domain's `reversalOf` over the event as read, through the consumer's door. */
export async function reversalEvent(pool: Database, tenant: Tenant, original: BillableEvent): Promise<BillableEvent> {
  if (original.agreementId === null || original.productId === null) throw new Error(`reversalEvent: event ${original.id} names no agreement or no product; a blocked event is cancelled, never reversed`)
  const draft = reversalOf({
    id: original.id,
    agreementId: original.agreementId,
    subscriptionId: original.subscriptionId,
    productId: original.productId,
    quantity: original.quantity,
    price: priceOf(original),
    serviceDate: original.serviceDate,
    invoiced: original.status === "invoiced",
  })
  return await consumerEvent(pool, tenant, { projectId: original.projectId, draft })
}
