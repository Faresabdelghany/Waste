// Right-sizing on the adapters (M23b of #293): a proposal becomes a record of
// `customers.right-sizing`, `right-sizing-proposal-<uuid>`, named by its
// subscription and what it proposes, its estimates in words; an open one
// offers Approve and Dismiss, a decided one nothing; a size's approve takes a
// day and a product by the server's ids, a frequency's nothing; Propose now
// goes through the client.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { RightSizingApprove, RightSizingDismiss, type RightSizingProposal } from "@waste/contracts/right-sizing"

import { COMMAND_SURFACES } from "@/components/waste/commands/command-surfaces"

import { FIXTURE_COMPANY_ID, type BusinessRecord } from "../../data/business-modules"
import { RIGHT_SIZING_MODULE } from "../../data/right-sizing"
import { isLocalRefusal, NOTHING_RESOLVED, type MappingContext, type Resolver } from "../records/adapter"
import { isServerBacked, SERVER_MODULE_KEYS } from "../records/modules"
import { APPROVE_PROPOSAL, DISMISS_PROPOSAL, proposalCommandsOffered, rightSizingAdapter, runRightSizing, toProposalRecord } from "../records/right-sizing"
import { bodyOf, clientOver, json, scripted } from "./scripted-fetch"

const NOW = new Date("2027-03-04T12:00:00Z")
const STAMPS = { createdAt: "2027-03-04T03:23:00.000Z", updatedAt: "2027-03-04T03:23:00.000Z" }
const id = (n: number) => `01a0d2a4-a280-7062-8000-0000000000${String(n).padStart(2, "0")}`
const PROJECT = id(1)

const holding: Resolver = {
  ...NOTHING_RESOLVED,
  byServerId: (serverId) => (serverId === PROJECT ? ({ id: `project-${PROJECT}`, name: "Copenhagen", submittedValues: { timezone: "Europe/Copenhagen" } } as unknown as BusinessRecord) : undefined),
  serverIdOf: (webId) => (webId.startsWith("product-") ? webId.slice("product-".length) : webId === `project-${PROJECT}` ? PROJECT : undefined),
}
const context: MappingContext = { fixtures: [], resolve: holding, companyRecordId: FIXTURE_COMPANY_ID, now: NOW }

const smaller: RightSizingProposal = {
  id: id(2),
  ...STAMPS,
  projectId: PROJECT,
  subscriptionId: id(3),
  productId: id(4),
  direction: "smaller",
  suggestedProductId: id(5),
  evidence: ["quarter", "half", "empty", "quarter"],
  evidenceThrough: "2027-03-03T08:00:00.000Z",
  status: "open",
  decidedAt: null,
  decidedBy: null,
  dismissNote: null,
  changedOn: null,
  replacementSubscriptionId: null,
}

describe("a right-sizing proposal as a record", () => {
  test("is the module's on the API, after the agreements and the products it names, by its subscription and what it proposes", () => {
    assert.ok(isServerBacked(RIGHT_SIZING_MODULE.workspaceId, RIGHT_SIZING_MODULE.moduleId))
    assert.ok(SERVER_MODULE_KEYS.indexOf("customers.right-sizing") > SERVER_MODULE_KEYS.indexOf("customers.agreements"))
    const record = toProposalRecord(smaller, context)
    assert.equal(record.id, `right-sizing-proposal-${smaller.id}`)
    assert.deepEqual([record.name, record.context, record.status, record.value], [`subscription-${id(3)} · a size down`, `product-${id(4)} → product-${id(5)}`, "Open", "a quarter full, half full, empty, a quarter full"])
    assert.deepEqual(proposalCommandsOffered(record), [APPROVE_PROPOSAL, DISMISS_PROPOSAL])
    assert.deepEqual(proposalCommandsOffered(toProposalRecord({ ...smaller, status: "dismissed", decidedAt: NOW.toISOString(), decidedBy: id(9), dismissNote: "No" }, context)), [])
    assert.ok(rightSizingAdapter.owns(record))
    const surface = COMMAND_SURFACES["customers.right-sizing"]
    assert.ok(typeof surface.primary === "function" && surface.rowActions !== undefined, "Propose now, and Approve and Dismiss in the details")
  })

  test("a size's approve takes the day and the product by the server's ids; a frequency's nothing; a dismissal why", () => {
    const approve = rightSizingAdapter.commands![APPROVE_PROPOSAL]
    const record = toProposalRecord(smaller, context)
    assert.deepEqual(RightSizingApprove.parse(approve.toBody!({ on: "2027-04-01", productId: `product-${id(5)}` }, record, context)), { on: "2027-04-01", productId: id(5) })
    const noDay = approve.toBody!({ productId: `product-${id(5)}` }, record, context)
    assert.ok(isLocalRefusal(noDay) && noDay.path === "on")
    const frequency = toProposalRecord({ ...smaller, direction: "more-frequent", suggestedProductId: null }, context)
    assert.deepEqual(approve.toBody!({}, frequency, context), {})
    const dismiss = rightSizingAdapter.commands![DISMISS_PROPOSAL]
    assert.ok(isLocalRefusal(dismiss.toBody!({}, record, context)))
    assert.deepEqual(RightSizingDismiss.parse(dismiss.toBody!({ note: "The customer is moving" }, record, context)), { note: "The customer is moving" })
  })
})

describe("Propose now", () => {
  test("runs the night's run through the client and says how many it made", async () => {
    const fetch = scripted([() => json({ proposed: 2 })])
    assert.equal(await runRightSizing(clientOver(fetch.fetch)), 2)
    assert.equal(fetch.calls[0].url, "http://api.test/right-sizing-proposals/run")
    assert.deepEqual(bodyOf(fetch.calls[0]), {})
  })
})
