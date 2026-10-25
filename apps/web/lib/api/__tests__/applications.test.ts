// Applications on the adapter (M7 of #293): an Application and its latest
// Decision become a record of `customers.applications` — its customer named
// through the switched contacts module, its Decision read on the project's
// day, the wire status and the Decision's id beside the form's values for
// the commands it offers — and the records the workspace writes become the
// bodies the API's contracts accept, held here against the contracts' own zod
// schemas. The decide form's body, the commands a status offers, and the
// letter a decided one prints are lib/data/applications.ts's.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { Application as ApplicationSchema, ApplicationCreate, ApplicationDecide, ApplicationPatch, ONE_PLACE as WIRE_ONE_PLACE, type Application, type Decision } from "@waste/contracts/applications"
import type { Customer } from "@waste/contracts/customers"
import type { Project } from "@waste/contracts/organisation"
import { APPEAL_TEXT_NEEDED, GRANT_STARTS } from "@waste/domain/registry/applications"

import { COMMAND_SURFACES, genericEditOffered } from "@/components/waste/commands/command-surfaces"

import { applicationCommandsOffered, APPLICATIONS_MODULE, decideBodyOf, decisionLetterHref, decisionLetterOf, LAST_DAY_SENTENCE, letterOffered, NOT_A_DAY, recordedDecisionOf } from "../../data/applications"
import { FIXTURE_COMPANY_ID, getModuleDefinition, type BusinessRecord } from "../../data/business-modules"
import { NOTHING_RESOLVED, isLocalRefusal, type MappingContext } from "../records/adapter"
import { applicationAdapter, ONE_PLACE, toApplicationCreateBody, toApplicationPatchBody, toApplicationRecord } from "../records/applications"
import { isServerBacked } from "../records/modules"
import { projectAdapter } from "../records/organisation"
import { customerAdapter } from "../records/registry"
import { loaded, resolverOver, type ServerRecordsState } from "../records/server-records"

const NOW = new Date("2026-11-20T12:00:00Z")
const STAMPS = { createdAt: "2026-11-02T09:00:00.000Z", updatedAt: "2026-11-02T09:30:00.000Z" }

const fixtures = getModuleDefinition(APPLICATIONS_MODULE)?.records ?? []
const organisationFixtures = getModuleDefinition({ workspaceId: "configure", moduleId: "organization" })?.records ?? []
const customerFixtures = getModuleDefinition({ workspaceId: "customers", moduleId: "contacts" })?.records ?? []

const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays", publicSlug: null, weightTolerancePercent: 5, paymentTermsDays: 30, paymentReferenceScheme: "none" }
const anna: Customer = { id: "01a0d2a4-a280-700b-8000-000000000001", ...STAMPS, kind: "person", name: "Anna Andersen", registrationNumber: null, email: null, phone: null, billingAddress: "Rosenvej 4\n2100 København Ø", serviceMessagesAllowed: true, paymentTermsDays: null, status: "active" }

const received: Application = {
  id: "01a0d2a4-a280-7040-8000-000000000001",
  ...STAMPS,
  projectId: copenhagen.id,
  number: 12,
  kind: "home-composting",
  status: "received",
  channel: "email",
  receivedOn: "2026-11-02",
  customerId: anna.id,
  propertyId: null,
  sharedCollectionPointId: null,
  subscriptionId: null,
  statement: "We compost our food waste in the garden.",
  decision: null,
}
const grant: Decision = {
  id: "01a0d2a4-a280-7041-8000-000000000001",
  applicationId: received.id,
  outcome: "granted",
  conditions: "The compost bin stays covered.",
  validFrom: "2026-11-09",
  validTo: "2027-01-01",
  appealText: null,
  decidedBy: "01a0d2a4-a280-7005-8000-000000000001",
  decidedAt: "2026-11-05T09:00:00.000Z",
}
const decided: Application = { ...received, status: "decided", decision: grant }
const refusal: Decision = { ...grant, id: "01a0d2a4-a280-7041-8000-000000000002", outcome: "refused", conditions: "Your garden is too small.", validFrom: null, validTo: null, appealText: "Write to the municipality within four weeks." }

const projectRecord = projectAdapter.toRecord(copenhagen, { fixtures: organisationFixtures, resolve: NOTHING_RESOLVED, now: NOW })
const customerRecord = customerAdapter.toRecord(anna, { fixtures: customerFixtures, resolve: NOTHING_RESOLVED, companyRecordId: FIXTURE_COMPANY_ID, now: NOW })
const state: ServerRecordsState = new Map([
  ["configure.organization", loaded({ records: [projectRecord], serverIds: new Map([[projectRecord.id, copenhagen.id]]) }, 1)],
  ["customers.contacts", loaded({ records: [customerRecord], serverIds: new Map([[customerRecord.id, anna.id]]) }, 1)],
])
const context: MappingContext = { fixtures, resolve: resolverOver(state), companyRecordId: FIXTURE_COMPANY_ID, now: NOW }

const withValues = (record: BusinessRecord, values: Record<string, string>): BusinessRecord => ({ ...record, submittedValues: { ...record.submittedValues, ...values } })

describe("an Application as a record", () => {
  test("is the module's on the API, `application-<uuid>`, named by its number and kind", () => {
    assert.ok(isServerBacked("customers", "applications"))
    const record = toApplicationRecord(received, context)
    assert.equal(record.id, `application-${received.id}`)
    assert.equal(record.name, "Application 12 · Home composting")
    assert.equal(record.status, "Received")
    assert.equal(record.facts?.Customer, "Anna Andersen")
    assert.equal(record.facts?.Decision, "Not decided")
    assert.ok(applicationAdapter.owns(record))
    assert.ok(applicationAdapter.owns({ ...record, id: "applications-application-1792915901965" }), "a row the workspace has just made, by its form's recordKind")
    assert.ok(!applicationAdapter.owns({ ...record, id: "agreement-1", recordKind: "Agreement" }))
    const surface = COMMAND_SURFACES["customers.applications"]
    assert.deepEqual([surface.primary, surface.rowActions !== undefined], ["form", true], "its own form, moved by its commands")
  })

  test("is corrected by the generic Edit while undecided alone, as the API's patch takes it", () => {
    const surface = COMMAND_SURFACES["customers.applications"]
    const offered = (application: Application) => genericEditOffered(surface, toApplicationRecord(application, context))
    assert.deepEqual([offered(received), offered({ ...received, status: "in-review" }), offered(decided), offered({ ...received, status: "withdrawn" })], [true, true, false, false])
    assert.equal(genericEditOffered(surface, null), false, "no row, no Edit")
  })

  test("reads its latest Decision on the project's day, the period by its last day in force", () => {
    const record = toApplicationRecord(decided, context)
    assert.deepEqual(
      [record.value, record.facts?.Outcome, record.facts?.["In force"], record.facts?.Conditions, record.facts?.Decided],
      ["Granted · in force", "Granted", "2026-11-09 to 2026-12-31", "The compost bin stays covered.", "2026-11-05"],
    )
    assert.equal(toApplicationRecord(decided, { ...context, now: new Date("2027-01-02T12:00:00Z") }).value, "Granted · expired 2026-12-31", "expired is a reading")
  })

  test("carries its server id and its latest Decision, structured, for its commands and its letter", () => {
    const record = toApplicationRecord(decided, context)
    assert.equal(record.submittedValues?.applicationId, received.id)
    assert.deepEqual(recordedDecisionOf(record), { id: grant.id, outcome: "granted", conditions: "The compost bin stays covered.", validFrom: "2026-11-09", validTo: "2027-01-01", appealText: null, decidedOn: "2026-11-05" })
    assert.equal(recordedDecisionOf(toApplicationRecord(received, context)), null)
    assert.equal(recordedDecisionOf(withValues(record, { latestDecision: "not json" })), null, "a value this file did not write")
  })

  test("offers the commands its status moves it by, each told in its own words", () => {
    assert.deepEqual(applicationCommandsOffered(toApplicationRecord(received, context)).map((offer) => offer.command), ["review", "decide", "withdraw"])
    assert.deepEqual(applicationCommandsOffered(toApplicationRecord({ ...received, status: "in-review" }, context)).map((offer) => offer.label), ["Decide", "Withdraw"])
    assert.deepEqual(applicationCommandsOffered(toApplicationRecord(decided, context)).map((offer) => offer.label), ["Reopen on appeal"])
    assert.deepEqual(applicationCommandsOffered(toApplicationRecord({ ...decided, status: "in-review" }, context)).map((offer) => [offer.label, offer.done]), [["Decide", "Decision recorded"], ["Withdraw appeal", "Appeal withdrawn; the decision stands"]], "an appeal under review")
    assert.deepEqual(applicationCommandsOffered(toApplicationRecord({ ...received, status: "withdrawn" }, context)), [])
  })
})

describe("the bodies", () => {
  const record = toApplicationRecord(received, context)

  test("a create is the contracts' create, its customer by server id", () => {
    const body = toApplicationCreateBody(record, context)
    assert.ok(!isLocalRefusal(body))
    assert.deepEqual(ApplicationCreate.parse(body), { projectId: copenhagen.id, kind: "home-composting", channel: "email", receivedOn: "2026-11-02", customerId: anna.id, statement: received.statement })
  })

  test("a create names one place at most and a customer", () => {
    const twoPlaces = toApplicationCreateBody(withValues(record, { propertyId: "property-01a0d2a4-a280-700c-8000-000000000001", sharedCollectionPointId: "shared-point-01a0d2a4-a280-7010-8000-000000000001" }), context)
    assert.deepEqual(twoPlaces, { path: "sharedCollectionPointId", message: ONE_PLACE })
    assert.equal(ONE_PLACE, WIRE_ONE_PLACE, "spelled again, since the web imports the contracts as types only")
    assert.deepEqual(toApplicationCreateBody(withValues(record, { customerId: "" }), context), { path: "customerId", message: "Pick the customer who applies" })
  })

  test("a patch moves what changed, keeps the customer, and is nothing when nothing moved", () => {
    const patch = toApplicationPatchBody(record, withValues(record, { statement: "We compost everything." }), context)
    assert.deepEqual(ApplicationPatch.parse(patch), { statement: "We compost everything." })
    assert.equal(toApplicationPatchBody(record, record, context), null)
    assert.ok(isLocalRefusal(toApplicationPatchBody(record, withValues(record, { customerId: "customer-other" }), context)))
  })

  test("a decision is the contracts' decide, its last day becoming the first day out", () => {
    const granted = decideBodyOf({ outcome: "granted", validFrom: "2026-11-09", lastDay: "2026-12-31", conditions: " Covered. ", appealText: "dropped" })
    assert.deepEqual(ApplicationDecide.parse(granted), { outcome: "granted", conditions: "Covered.", validFrom: "2026-11-09", validTo: "2027-01-01" })
    const refused = decideBodyOf({ outcome: "refused", validFrom: "2026-11-09", lastDay: "2026-12-31", appealText: "Write to us." })
    assert.deepEqual(ApplicationDecide.parse(refused), { outcome: "refused", appealText: "Write to us." }, "a refusal's hidden period is dropped")
  })

  test("a decision is refused where the API would refuse it, in the domain's sentences", () => {
    assert.deepEqual(decideBodyOf({ outcome: "granted" }), { path: "validFrom", message: GRANT_STARTS })
    assert.deepEqual(decideBodyOf({ outcome: "partly-granted", validFrom: "2026-11-09" }), { path: "appealText", message: APPEAL_TEXT_NEEDED })
    assert.deepEqual(decideBodyOf({ outcome: "granted", validFrom: "2026-11-09", lastDay: "2026-11-08" }), { path: "lastDay", message: LAST_DAY_SENTENCE })
    assert.deepEqual(decideBodyOf({ outcome: "maybe" }), { path: "outcome", message: "Pick the outcome" })
    assert.deepEqual(decideBodyOf({ outcome: "granted", validFrom: "2026-11-09", lastDay: "2026-12-3" }), { path: "lastDay", message: NOT_A_DAY }, "never an open-ended grant from a day the field does not hold")
    assert.deepEqual(decideBodyOf({ outcome: "granted", validFrom: "11/09/2026" }), { path: "validFrom", message: NOT_A_DAY })
  })

  test("the wire's Application parses as the contracts', the record's source", () => {
    assert.doesNotThrow(() => ApplicationSchema.parse(decided))
  })
})

describe("the decision letter", () => {
  const parties = { company: "Kystbyen Renovation", address: anna.billingAddress }

  test("prints at the Application's server id, only while it stands decided", () => {
    assert.equal(decisionLetterHref(received.id), `/applications/${received.id}/letter`)
    assert.equal(decisionLetterOf(toApplicationRecord(received, context), parties), null)
    assert.deepEqual([letterOffered(toApplicationRecord(decided, context)), letterOffered(toApplicationRecord({ ...decided, status: "in-review" }, context)), letterOffered(toApplicationRecord(received, context))], [true, false, false], "never while an appeal reconsiders it")
  })

  test("tells a grant, its period by the last day in force, and what it holds the customer to", () => {
    const letter = decisionLetterOf(toApplicationRecord(decided, context), parties)
    assert.deepEqual(letter, {
      sender: "Kystbyen Renovation",
      recipient: "Anna Andersen",
      address: "Rosenvej 4\n2100 København Ø",
      date: "2026-11-05",
      subject: "Decision on application 12: Home composting",
      paragraphs: ["We received your application for home composting on 2026-11-02.", "Your application is granted.", "The decision is in force from 2026-11-09 up to and including 2026-12-31."],
      conditions: { heading: "Conditions", text: "The compost bin stays covered." },
      appeal: null,
    })
  })

  test("tells a refusal its reasons and how to appeal it, with no period", () => {
    const letter = decisionLetterOf(toApplicationRecord({ ...decided, decision: refusal }, context), parties)
    assert.deepEqual([letter?.paragraphs, letter?.conditions, letter?.appeal], [["We received your application for home composting on 2026-11-02.", "Your application is refused."], { heading: "Reasons", text: "Your garden is too small." }, "Write to the municipality within four weeks."])
  })
})
