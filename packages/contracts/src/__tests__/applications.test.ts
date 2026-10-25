// Applications and their Decisions on the wire (M7 of #293): a create's one
// place, a patch of the undecided fields alone, and a decision's period and
// appeal text held to the domain's rules in the domain's sentences.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { APPEAL_TEXT_NEEDED, GRANT_STARTS, REFUSAL_HAS_NO_PERIOD } from "@waste/domain/registry/applications"
import { APPLICATION_CHANNELS, APPLICATION_KINDS, APPLICATION_STATUSES, DECISION_OUTCOMES } from "@waste/domain/registry/vocabulary"

import { Application, ApplicationChannel, ApplicationCreate, ApplicationDecide, ApplicationKind, ApplicationListQuery, ApplicationPatch, ApplicationStatus, DecisionOutcome, ONE_PLACE } from "../applications"
import { ENDS_AFTER_IT_STARTS } from "../validity"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const CREATE = { projectId: ID, kind: "home-composting", channel: "email", receivedOn: "2026-11-02", customerId: ID, propertyId: OTHER, statement: "We compost our food waste in the garden." } as const

const issues = (result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) => (result.error?.issues ?? []).map((issue) => [issue.path.join("."), issue.message])

describe("the vocabularies", () => {
  test("are the Registry's", () => {
    assert.deepEqual(ApplicationKind.options, [...APPLICATION_KINDS])
    assert.deepEqual(ApplicationStatus.options, [...APPLICATION_STATUSES])
    assert.deepEqual(ApplicationChannel.options, [...APPLICATION_CHANNELS])
    assert.deepEqual(DecisionOutcome.options, [...DECISION_OUTCOMES])
  })
})

describe("a create", () => {
  test("names its project, kind, channel, day received, customer and statement, and one place at most", () => {
    assert.deepEqual(ApplicationCreate.parse(CREATE), CREATE)
    assert.equal(ApplicationCreate.safeParse({ ...CREATE, propertyId: undefined, sharedCollectionPointId: OTHER, subscriptionId: ID }).success, true)
    assert.deepEqual(issues(ApplicationCreate.safeParse({ ...CREATE, sharedCollectionPointId: ID })), [["sharedCollectionPointId", ONE_PLACE]])
  })

  test("refuses what the server owns: the number, the status, a decision", () => {
    for (const member of [{ number: 1 }, { status: "decided" }, { decision: null }]) assert.equal(ApplicationCreate.safeParse({ ...CREATE, ...member }).success, false, JSON.stringify(member))
    assert.equal(ApplicationCreate.safeParse({ ...CREATE, statement: " " }).success, false)
  })
})

describe("a patch", () => {
  test("corrects the undecided fields, never the project or the customer", () => {
    assert.equal(ApplicationPatch.safeParse({ kind: "pause", statement: "Away for the winter." }).success, true)
    assert.equal(ApplicationPatch.safeParse({ propertyId: null, sharedCollectionPointId: ID }).success, true)
    for (const member of [{ customerId: OTHER }, { projectId: OTHER }, { status: "decided" }]) assert.equal(ApplicationPatch.safeParse(member).success, false, JSON.stringify(member))
    assert.equal(ApplicationPatch.safeParse({}).success, false)
    assert.deepEqual(issues(ApplicationPatch.safeParse({ propertyId: ID, sharedCollectionPointId: OTHER })), [["sharedCollectionPointId", ONE_PLACE]])
  })
})

describe("a decision", () => {
  test("a grant in full names its first day, its end and its conditions optional, no appeal text needed", () => {
    assert.equal(ApplicationDecide.safeParse({ outcome: "granted", validFrom: "2026-11-09" }).success, true)
    assert.equal(ApplicationDecide.safeParse({ outcome: "granted", validFrom: "2026-11-09", validTo: "2027-11-09", conditions: "The compost bin stays covered." }).success, true)
    assert.deepEqual(issues(ApplicationDecide.safeParse({ outcome: "granted" })), [["validFrom", GRANT_STARTS]])
    assert.deepEqual(issues(ApplicationDecide.safeParse({ outcome: "granted", validFrom: "2026-11-09", validTo: "2026-11-09" })), [["validTo", ENDS_AFTER_IT_STARTS]])
  })

  test("a partial grant says how to appeal it", () => {
    assert.deepEqual(issues(ApplicationDecide.safeParse({ outcome: "partly-granted", validFrom: "2026-11-09" })), [["appealText", APPEAL_TEXT_NEEDED]])
    assert.equal(ApplicationDecide.safeParse({ outcome: "partly-granted", validFrom: "2026-11-09", appealText: "Write to the municipality within four weeks." }).success, true)
  })

  test("a refusal has no period and says how to appeal it", () => {
    assert.equal(ApplicationDecide.safeParse({ outcome: "refused", conditions: "The garden is too small.", appealText: "Write within four weeks." }).success, true)
    assert.deepEqual(issues(ApplicationDecide.safeParse({ outcome: "refused", validFrom: "2026-11-09", appealText: "x" })), [["validFrom", REFUSAL_HAS_NO_PERIOD]])
    assert.deepEqual(issues(ApplicationDecide.safeParse({ outcome: "refused" })), [["appealText", APPEAL_TEXT_NEEDED]])
  })
})

describe("the resource and its list", () => {
  test("an Application reads with its latest decision, null until decided", () => {
    const stamps = { id: ID, createdAt: "2026-11-02T08:00:00.000Z", updatedAt: "2026-11-02T08:00:00.000Z" }
    const read = { ...stamps, ...CREATE, number: 12, status: "received", sharedCollectionPointId: null, subscriptionId: null, decision: null }
    assert.equal(Application.safeParse(read).success, true)
    const decided = { ...read, status: "decided", decision: { id: OTHER, applicationId: ID, outcome: "granted", conditions: null, validFrom: "2026-11-09", validTo: null, appealText: null, decidedBy: ID, decidedAt: "2026-11-05T10:00:00.000Z" } }
    assert.equal(Application.safeParse(decided).success, true)
  })

  test("lists by project, customer, kind, status and the grants in force on a day", () => {
    assert.equal(ApplicationListQuery.safeParse({ projectId: ID, customerId: OTHER, kind: "pause", status: "decided", inForceOn: "2026-12-01" }).success, true)
    assert.equal(ApplicationListQuery.safeParse({ status: "expired" }).success, false, "expired is a reading, never a status")
  })
})
