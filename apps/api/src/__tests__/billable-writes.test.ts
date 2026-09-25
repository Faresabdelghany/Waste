// The billable-event statements, in order, without a database (Issue #112
// §6): a scripted `tx` records every statement `recordBillableEvent` and
// `priceDraft` run and answers what each would — the agreement with its
// customer's kind, the list in force, its rows, the product's rate, the row
// as inserted — so the suite can say that a recording is one insert and
// nothing else (no history row, no outbox event), that a pricing reads the
// agreement, the list, the rows and the product in that order and stops at
// the first block, and that a row disagreeing with its kind is thrown before
// anything reaches the database; the `ticket-writes.test.ts` precedent. The
// statements themselves run against Postgres in billable-events.test.ts.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Tx } from "@waste/db/client"
import type { BillableEventDraft } from "@waste/domain/finance/from-event"
import { getTableName, type Table } from "drizzle-orm"

import { createIdMinter } from "../ids"
import { billableEventShapeIssue, priceDraft, recordBillableEvent, type ComposedEvent } from "../routes/billable-writes"

const COMPANY = "01a0d3a5-e5e0-7000-8000-000000000000"
const PROJECT = "01a0d3a5-e5e0-7000-8000-000000000001"
const OLIVIA = "01a0d3a5-e5e0-7000-8000-000000000002"
const AGREEMENT = "01a0d3a5-e5e0-7000-8000-000000000003"
const PRODUCT = "01a0d3a5-e5e0-7000-8000-000000000004"
const HOUSING = "01a0d3a5-e5e0-7000-8000-000000000005"
const LIST = "01a0d3a5-e5e0-7000-8000-000000000006"
const ROW = "01a0d3a5-e5e0-7000-8000-000000000007"
const NEGOTIATED = "01a0d3a5-e5e0-7000-8000-000000000008"
const ROUTE = "01a0d3a5-e5e0-7000-8000-000000000009"
const PICKUP = "01a0d3a5-e5e0-7000-8000-00000000000a"
const SOURCE = "01a0d3a5-e5e0-7000-8000-00000000000b"
const STAMP = new Date("2026-10-05T12:00:00Z")
const DAY = "2026-10-05"

type Statement = { kind: "select" | "insert"; table: string; values?: Record<string, unknown> }

/** A `tx` that records each statement by kind and table, answering a select from the rows scripted for its table and an insert with the row as inserted. */
const scripted = (answers: Partial<Record<string, unknown[]>> = {}) => {
  const statements: Statement[] = []
  const chainFor = (rows: unknown[]) => {
    const chain: Record<string, unknown> = {}
    const same = () => chain
    Object.assign(chain, {
      innerJoin: same,
      where: same,
      orderBy: same,
      limit: same,
      then: (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject),
    })
    return chain
  }
  const tx = {
    select: () => ({
      from: (table: Table) => {
        const name = getTableName(table)
        statements.push({ kind: "select", table: name })
        return chainFor(answers[name] ?? [])
      },
    }),
    insert: (table: Table) => ({
      values: (values: Record<string, unknown>) => {
        statements.push({ kind: "insert", table: getTableName(table), values })
        return { returning: () => Promise.resolve([{ ...values, createdAt: STAMP, updatedAt: STAMP }]) }
      },
    }),
  } as unknown as Tx
  return { tx, statements }
}

const shape = (statements: readonly Statement[]) => statements.map((statement) => `${statement.kind} ${statement.table}`)

/** Ids that count up from a pinned clock, so the suite can name them. */
const minter = () => createIdMinter(() => STAMP.getTime())

const NO_LINKS = { routeId: null, pickupId: null, ticketId: null, reversesEventId: null }

/** A manual event priced by the resolver at 100.00 kr, 25 % VAT. */
const priced: BillableEventDraft = {
  kind: "manual",
  serviceDate: DAY,
  agreementId: AGREEMENT,
  subscriptionId: null,
  productId: PRODUCT,
  quantity: 2,
  price: { priceListRowId: ROW, unitPriceMinor: 10_000, netMinor: 20_000, vatPercent: 25, vatMinor: 5_000, currency: "DKK" },
  blockReason: null,
  links: NO_LINKS,
}

const record = (tx: Tx, draft: BillableEventDraft, origin: { createdBy: string | null; sourceEventId: string | null } = { createdBy: OLIVIA, sourceEventId: null }, texts: { overrideReason: string | null; note: string | null } = { overrideReason: null, note: null }) =>
  recordBillableEvent(tx, { companyId: COMPANY, projectId: PROJECT, draft, ...texts, ...origin, newId: minter() })

describe("recordBillableEvent", () => {
  test("writes the row and nothing else — no history row, no outbox event — and answers it ready", async () => {
    const { tx, statements } = scripted()
    const { row, answered } = await record(tx, priced, { createdBy: OLIVIA, sourceEventId: null }, { overrideReason: null, note: "Entered by hand" })
    assert.deepEqual(shape(statements), ["insert billable_event"])
    const [inserted] = statements
    assert.deepEqual(
      [inserted.values?.companyId, inserted.values?.projectId, inserted.values?.kind, inserted.values?.createdBy, inserted.values?.sourceEventId, inserted.values?.blockReason, inserted.values?.priceListRowId],
      [COMPANY, PROJECT, "manual", OLIVIA, null, null, ROW],
      "a person's event, priced, with the row that won",
    )
    assert.deepEqual([inserted.values?.unitPriceMinor, inserted.values?.netMinor, inserted.values?.vatPercent, inserted.values?.vatMinor, inserted.values?.currency], [10_000, 20_000, 25, 5_000, "DKK"], "the price frozen as resolved")
    assert.deepEqual([inserted.values?.routeId, inserted.values?.pickupId, inserted.values?.ticketId, inserted.values?.reversesEventId], [null, null, null, null])
    assert.deepEqual([inserted.values?.cancelledAt, inserted.values?.cancelledBy, inserted.values?.cancelReason, inserted.values?.overrideReason, inserted.values?.note], [null, null, null, null, "Entered by hand"])
    assert.equal(inserted.values?.id, row.id)
    assert.deepEqual([answered.id, answered.status, answered.invoiceLineId, answered.createdBy, answered.sourceEventId, answered.netMinor, answered.createdAt], [row.id, "ready", null, OLIVIA, null, 20_000, STAMP.toISOString()])
    assert.deepEqual(answered.links, NO_LINKS)
  })

  test("records the consumer's blocked pickup event with no person and the outbox event's id, and answers it blocked", async () => {
    const { tx, statements } = scripted()
    const draft: BillableEventDraft = { kind: "pickup", serviceDate: DAY, agreementId: null, subscriptionId: null, productId: null, quantity: 1, price: null, blockReason: "no-subscription", links: { ...NO_LINKS, routeId: ROUTE, pickupId: PICKUP } }
    const { answered } = await record(tx, draft, { createdBy: null, sourceEventId: SOURCE })
    assert.deepEqual(shape(statements), ["insert billable_event"])
    const [inserted] = statements
    assert.deepEqual([inserted.values?.createdBy, inserted.values?.sourceEventId, inserted.values?.blockReason, inserted.values?.routeId, inserted.values?.pickupId], [null, SOURCE, "no-subscription", ROUTE, PICKUP])
    assert.deepEqual([inserted.values?.unitPriceMinor, inserted.values?.netMinor, inserted.values?.vatPercent, inserted.values?.vatMinor, inserted.values?.currency, inserted.values?.priceListRowId], [null, null, null, null, null, null], "a blocked event carries no price")
    assert.deepEqual([answered.status, answered.blockReason, answered.createdBy, answered.sourceEventId, answered.links.pickupId], ["blocked", "no-subscription", null, SOURCE, PICKUP])
  })

  test("throws before the insert on a row that disagrees with its kind, its origin or its price: the API composes every row, so that is a bug and not a client's", async () => {
    const { tx, statements } = scripted()
    await assert.rejects(record(tx, { ...priced, kind: "pickup", links: { ...NO_LINKS, routeId: ROUTE, pickupId: PICKUP } }, { createdBy: OLIVIA, sourceEventId: SOURCE }), /never both and never neither \(billable_event_origin_shape\)/)
    await assert.rejects(record(tx, priced, { createdBy: null, sourceEventId: null }), /has its person \(billable_event_kind_shape\)/)
    await assert.rejects(record(tx, { ...priced, kind: "reversal", links: { ...NO_LINKS, reversesEventId: ROW } }), /negated on a reversal \(billable_event_amounts_shape\)/, "a reversal's net is negated")
    await assert.rejects(record(tx, { ...priced, blockReason: "no-price-row" }), /billable_event_priced_shape/)
    await assert.rejects(record(tx, { ...priced, price: { ...priced.price!, priceListRowId: null } }), /billable_event_override_shape/)
    await assert.rejects(record(tx, { ...priced, kind: "pickup", price: { ...priced.price!, priceListRowId: null }, links: { ...NO_LINKS, routeId: ROUTE, pickupId: PICKUP } }, { createdBy: null, sourceEventId: SOURCE }), /a priced pickup event names the row that won/, "a resolver-priced pickup event with no row")
    assert.equal(statements.length, 0, "nothing reached the database")
  })
})

describe("billableEventShapeIssue", () => {
  const manual: ComposedEvent = {
    kind: "manual",
    agreementId: AGREEMENT,
    productId: PRODUCT,
    quantity: 1,
    unitPriceMinor: 10_000,
    netMinor: 10_000,
    vatPercent: 25,
    vatMinor: 2_500,
    currency: "DKK",
    priceListRowId: ROW,
    blockReason: null,
    routeId: null,
    pickupId: null,
    ticketId: null,
    reversesEventId: null,
    sourceEventId: null,
    createdBy: OLIVIA,
    overrideReason: null,
  }

  test("lets every well-formed row through: a priced manual event, a hand-priced one, a blocked one, a pickup's, a ticket's, a reversal", () => {
    assert.equal(billableEventShapeIssue(manual), undefined)
    assert.equal(billableEventShapeIssue({ ...manual, priceListRowId: null, overrideReason: "Agreed by phone" }), undefined)
    assert.equal(billableEventShapeIssue({ ...manual, unitPriceMinor: null, netMinor: null, vatPercent: null, vatMinor: null, currency: null, priceListRowId: null, blockReason: "no-price-row" }), undefined)
    assert.equal(billableEventShapeIssue({ ...manual, kind: "pickup", routeId: ROUTE, pickupId: PICKUP, createdBy: null, sourceEventId: SOURCE }), undefined)
    assert.equal(billableEventShapeIssue({ ...manual, kind: "ticket", ticketId: ROUTE, productId: null, agreementId: AGREEMENT, unitPriceMinor: null, netMinor: null, vatPercent: null, vatMinor: null, currency: null, priceListRowId: null, blockReason: "no-product", createdBy: null, sourceEventId: SOURCE }), undefined)
    assert.equal(billableEventShapeIssue({ ...manual, kind: "reversal", reversesEventId: ROW, priceListRowId: null, netMinor: -10_000, vatMinor: -2_500, createdBy: null, sourceEventId: SOURCE }), undefined)
  })

  test("names the table's check each disagreement would meet", () => {
    assert.match(billableEventShapeIssue({ ...manual, currency: null }) ?? "", /null together or none \(billable_event_priced_shape\)/)
    assert.match(billableEventShapeIssue({ ...manual, unitPriceMinor: null, netMinor: null, vatPercent: null, vatMinor: null, currency: null, priceListRowId: null, blockReason: "no-price-row", agreementId: null, productId: null }) ?? "", /^$|billable_event_priced_references/, "a blocked event may leave the agreement and the product null")
    assert.match(billableEventShapeIssue({ ...manual, netMinor: 10_001 }) ?? "", /billable_event_amounts_shape/)
    assert.match(billableEventShapeIssue({ ...manual, vatMinor: 2_501 }) ?? "", /billable_event_vat_shape/)
    assert.match(billableEventShapeIssue({ ...manual, kind: "pickup", routeId: ROUTE, pickupId: PICKUP, createdBy: null, sourceEventId: SOURCE, priceListRowId: null }) ?? "", /billable_event_row_shape/)
    assert.match(billableEventShapeIssue({ ...manual, overrideReason: "with a row too" }) ?? "", /billable_event_override_shape/)
    assert.match(billableEventShapeIssue({ ...manual, kind: "pickup", pickupId: PICKUP, createdBy: null, sourceEventId: SOURCE }) ?? "", /billable_event_pickup_shape/)
    assert.match(billableEventShapeIssue({ ...manual, kind: "pickup", routeId: ROUTE, pickupId: PICKUP, ticketId: ROW, createdBy: null, sourceEventId: SOURCE }) ?? "", /billable_event_kind_shape/)
    assert.match(billableEventShapeIssue({ ...manual, createdBy: null }) ?? "", /a manual event names neither[^(]*\(billable_event_kind_shape\)/)
    assert.match(billableEventShapeIssue({ ...manual, kind: "reversal", reversesEventId: ROW, priceListRowId: null, createdBy: null, sourceEventId: SOURCE }) ?? "", /billable_event_amounts_shape/, "a reversal with a positive net is caught by the amounts first")
    assert.match(billableEventShapeIssue({ ...manual, kind: "reversal", priceListRowId: null, netMinor: -10_000, vatMinor: -2_500, createdBy: null, sourceEventId: SOURCE }) ?? "", /names the event it undoes[^(]*\(billable_event_kind_shape\)/, "a reversal naming nothing")
    assert.match(billableEventShapeIssue({ ...manual, sourceEventId: SOURCE }) ?? "", /billable_event_origin_shape/)
  })
})

describe("priceDraft", () => {
  const agreementRow = (status: string, priceListId: string | null = null) => ({ id: AGREEMENT, status, customerId: HOUSING, payerCustomerId: HOUSING, currency: "DKK", priceListId, customerKind: "organisation" })
  const listRow = { id: LIST, currency: "DKK" }
  const row = (id: string, unitPriceMinor: number, customerId: string | null = null) => ({ id, unitPriceMinor, planningAreaId: null, customerKind: null, containerTypeId: null, wasteFractionId: null, customerId, validFrom: "2026-01-01", validTo: null })
  const input = { agreementId: AGREEMENT, productId: PRODUCT, quantity: 2, serviceDate: DAY }
  const scope = { companyId: COMPANY, projectId: PROJECT }

  test("reads the agreement, the list, the rows and the product in that order and answers the price the resolver resolved — the negotiated row winning — frozen in the list's currency", async () => {
    const { tx, statements } = scripted({ agreement: [agreementRow("active")], price_list: [listRow], price_list_row: [row(ROW, 12_000), row(NEGOTIATED, 10_000, HOUSING)], product: [{ vatPercent: 25 }] })
    const outcome = await priceDraft(tx, scope, input)
    assert.deepEqual(shape(statements), ["select agreement", "select price_list", "select price_list_row", "select product"])
    assert.equal(outcome.blockReason, null)
    assert.deepEqual(outcome.price, { priceListRowId: NEGOTIATED, unitPriceMinor: 10_000, netMinor: 20_000, vatPercent: 25, vatMinor: 5_000, currency: "DKK" })
    assert.equal(outcome.resolution?.verdicts.length, 2, "every row judged, so the office reads why the other lost")
  })

  test("stops at the first block in the order reprice mends them: a draft agreement after one read, no list after two, no row and no rate after all four", async () => {
    const draft = scripted({ agreement: [agreementRow("draft")] })
    assert.equal((await priceDraft(draft.tx, scope, input)).blockReason, "agreement-draft")
    assert.deepEqual(shape(draft.statements), ["select agreement"])

    const noList = scripted({ agreement: [agreementRow("active")] })
    assert.equal((await priceDraft(noList.tx, scope, input)).blockReason, "no-price-list")
    assert.deepEqual(shape(noList.statements), ["select agreement", "select price_list"])

    const noRow = scripted({ agreement: [agreementRow("active", LIST)], price_list: [listRow], price_list_row: [row(NEGOTIATED, 10_000, "01a0d3a5-e5e0-7000-8000-0000000000ff")], product: [{ vatPercent: 25 }] })
    const blocked = await priceDraft(noRow.tx, scope, input)
    assert.equal(blocked.blockReason, "no-price-row")
    assert.deepEqual(shape(noRow.statements), ["select agreement", "select price_list", "select price_list_row", "select product"])
    assert.match(blocked.resolution?.verdicts[0]?.reason ?? "", /^Negotiated for .*, not this customer$/, "the losing row's sentence is the prototype's")

    const noRate = scripted({ agreement: [agreementRow("active")], price_list: [listRow], price_list_row: [row(ROW, 12_000)], product: [{ vatPercent: null }] })
    assert.equal((await priceDraft(noRate.tx, scope, input)).blockReason, "no-vat-rate")
  })

  test("throws on an agreement or a product that is not there: the route held both before pricing, so that is a row gone between statements", async () => {
    await assert.rejects(priceDraft(scripted().tx, scope, input), /a route holds the agreement it prices under before pricing/)
    await assert.rejects(priceDraft(scripted({ agreement: [agreementRow("active")], price_list: [listRow] }).tx, scope, input), /a route holds the product it prices before pricing/)
  })
})
