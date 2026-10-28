// A subscription's and an agreement's lifecycle on the wire (#291, slice
// 10c): the actions the agreements module's rows answer another resource to
// — a change of service, a pause written, resumed or cancelled, a
// termination — each the request the API takes, the dialog's days turned
// into the wire's (a pause's and a termination's last day in, the first day
// out on the wire), and a body that cannot be sent refused at its field
// before the API sees it.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Agreement, AgreementTerminated, Subscription, SubscriptionPause, SubscriptionPaused } from "@waste/contracts/agreements"

import { AGREEMENTS_MODULE } from "../../data/agreements"
import { FIXTURE_COMPANY_ID, getModuleDefinition } from "../../data/business-modules"
import { NOTHING_RESOLVED, type MappingContext } from "../records/adapter"
import {
  agreementAdapter,
  agreementsModule,
  CANCEL_PAUSE,
  CHANGE_NAMES_NOTHING,
  CHANGE_SERVICE,
  MOVE_PAUSE,
  PAUSE,
  QUANTITY_REFUSAL,
  subscriptionAdapter,
  subscriptionPauses,
  TERMINATE,
} from "../records/agreements"
import { actOnRecord, loaded, type ServerRecordsState } from "../records/server-records"
import { bodyOf, clientOver, json, scripted } from "./scripted-fetch"

const NOW = new Date("2026-10-24T10:00:00Z")
const STAMPS = { createdAt: "2026-09-24T09:00:00.000Z", updatedAt: "2026-09-25T09:30:00.000Z" }
const fixtures = getModuleDefinition(AGREEMENTS_MODULE)?.records ?? []
const context: MappingContext = { fixtures, resolve: NOTHING_RESOLVED, companyRecordId: FIXTURE_COMPANY_ID, now: NOW }

const PRODUCT = "01a0d2a4-a280-700a-8000-000000000001"
const OTHER_PRODUCT = "01a0d2a4-a280-700a-8000-000000000002"
const PAUSE_ID = "01a0d2a4-a280-7030-8000-000000000001"
const agreement: Agreement = { id: "01a0d2a4-a280-7012-8000-000000000001", ...STAMPS, projectId: "01a0d2a4-a280-7002-8000-000000000001", number: "AGR-2408", customerId: "01a0d2a4-a280-700b-8000-000000000002", payerCustomerId: "01a0d2a4-a280-700b-8000-000000000002", status: "active", billingCadence: "monthly", currency: "DKK", notes: null, priceListId: null, serviceWindow: null, validFrom: "2026-01-01", validTo: null }
const subscription: Subscription = { id: "01a0d2a4-a280-7013-8000-000000000001", ...STAMPS, projectId: agreement.projectId, agreementId: agreement.id, productId: PRODUCT, propertyId: "01a0d2a4-a280-700c-8000-000000000001", sharedCollectionPointId: null, quantity: 1, validFrom: "2026-01-01", validTo: null }
const pause: SubscriptionPause = { id: PAUSE_ID, ...STAMPS, projectId: agreement.projectId, subscriptionId: subscription.id, validFrom: "2026-11-02", validTo: "2026-11-16" }

const agreementRecord = agreementAdapter.toRecord(agreement, context)
const subscriptionRecord = subscriptionAdapter.toRecord(subscription, context)
const current = loaded({ records: [agreementRecord, subscriptionRecord], serverIds: new Map([[agreementRecord.id, agreement.id], [subscriptionRecord.id, subscription.id]]) }, 1)
const state: ServerRecordsState = new Map([["customers.agreements", current]])

/** One action on one row against a scripted API, answering what the API answered and what it was asked. */
async function act(record: typeof agreementRecord, name: string, input: Record<string, unknown>, answer: unknown) {
  const { fetch, calls } = scripted([() => json(answer, 200)])
  const outcome = await actOnRecord(clientOver(fetch), agreementsModule, current, record, name, input, { fixtures, state, now: NOW })
  return { outcome, calls }
}
const sent = (calls: { url: string; init: RequestInit }[]) => calls.map((call) => [call.init.method, call.url.replace("http://api.test", ""), bodyOf(call)])

describe("a change of service", () => {
  test("is the change command on the subscription: its first day, and the product or the quantity, a blank field the subscription's own", async () => {
    const replacement: Subscription = { ...subscription, id: "01a0d2a4-a280-7013-8000-000000000002", quantity: 2, validFrom: "2026-11-01" }
    const { outcome, calls } = await act(subscriptionRecord, CHANGE_SERVICE, { from: "2026-11-01", productId: "", quantity: "2" }, replacement)
    assert.deepEqual(sent(calls), [["POST", `/subscriptions/${subscription.id}/change`, { on: "2026-11-01", quantity: 2 }]])
    assert.deepEqual(outcome, { kind: "done", answer: replacement })
    const product = await act(subscriptionRecord, CHANGE_SERVICE, { from: "2026-11-01", productId: `product-${OTHER_PRODUCT}`, quantity: "" }, replacement)
    assert.deepEqual(sent(product.calls), [["POST", `/subscriptions/${subscription.id}/change`, { on: "2026-11-01", productId: OTHER_PRODUCT }]], "a product by the row it names")
  })

  test("is refused at its field before the API sees it: no first day, nothing named, a quantity that is not a whole number", async () => {
    for (const [input, path, message] of [
      [{ quantity: "2" }, "from", "Pick the first day of the new service"],
      [{ from: "2026-11-01" }, "productId", CHANGE_NAMES_NOTHING],
      [{ from: "2026-11-01", quantity: "0" }, "quantity", QUANTITY_REFUSAL],
    ] as const) {
      const { outcome, calls } = await act(subscriptionRecord, CHANGE_SERVICE, input, {})
      assert.equal(calls.length, 0, JSON.stringify(input))
      assert.equal(outcome.kind, "refused")
      if (outcome.kind === "refused") assert.deepEqual(outcome.problem.errors, [{ path, message }])
    }
  })
})

describe("a pause", () => {
  test("is written under the subscription from its first day through its last, the wire's end the day after; blank, until it is resumed", async () => {
    const answer: SubscriptionPaused = { pause, stopsToRemove: [] }
    const bounded = await act(subscriptionRecord, PAUSE, { from: "2026-11-02", lastDay: "2026-11-15" }, answer)
    assert.deepEqual(sent(bounded.calls), [["POST", `/subscriptions/${subscription.id}/pauses`, { validFrom: "2026-11-02", validTo: "2026-11-16" }]])
    assert.deepEqual(bounded.outcome, { kind: "done", answer })
    const open = await act(subscriptionRecord, PAUSE, { from: "2026-11-02", lastDay: "" }, answer)
    assert.deepEqual(sent(open.calls), [["POST", `/subscriptions/${subscription.id}/pauses`, { validFrom: "2026-11-02" }]])
  })

  test("is resumed by moving its end to the day collections resume, and cancelled before it begins, each by the pause's own id", async () => {
    const resumed = await act(subscriptionRecord, MOVE_PAUSE, { pauseId: PAUSE_ID, resumeOn: "2026-11-09" }, { pause: { ...pause, validTo: "2026-11-09" }, stopsToRemove: [] })
    assert.deepEqual(sent(resumed.calls), [["PATCH", `/subscription-pauses/${PAUSE_ID}`, { validTo: "2026-11-09" }]])
    const cancelled = await act(subscriptionRecord, CANCEL_PAUSE, { pauseId: PAUSE_ID }, pause)
    assert.deepEqual(sent(cancelled.calls), [["POST", `/subscription-pauses/${PAUSE_ID}/cancel`, {}]])
    const nameless = await act(subscriptionRecord, MOVE_PAUSE, { resumeOn: "2026-11-09" }, {})
    assert.equal(nameless.calls.length, 0)
  })

  test("of a subscription is listed by the subscription", async () => {
    const { fetch, calls } = scripted([() => json({ items: [pause], nextCursor: null })])
    assert.deepEqual(await subscriptionPauses(clientOver(fetch), subscription.id), [pause])
    assert.match(calls[0].url, new RegExp(`/subscription-pauses\\?limit=\\d+&subscriptionId=${subscription.id}$`))
  })
})

describe("a termination", () => {
  test("is the terminate command on the agreement: its last day in, the wire's day the one after; the answer carries the stops left to remove", async () => {
    const answer: AgreementTerminated = { agreement: { ...agreement, validTo: "2027-01-01" }, stopsToRemove: [{ routeId: "r1", routeLabel: "RC-1042", operatingDate: "2027-01-04", pickupId: "p1", containerId: "c1" }] }
    const { outcome, calls } = await act(agreementRecord, TERMINATE, { lastDay: "2026-12-31" }, answer)
    assert.deepEqual(sent(calls), [["POST", `/agreements/${agreement.id}/terminate`, { on: "2027-01-01" }]])
    assert.deepEqual(outcome, { kind: "done", answer })
    const undated = await act(agreementRecord, TERMINATE, {}, answer)
    assert.equal(undated.calls.length, 0)
  })
})
