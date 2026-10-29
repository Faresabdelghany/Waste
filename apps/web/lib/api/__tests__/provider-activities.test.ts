// Service Provider Activities on the adapter (#474): an Activity becomes a
// record of `service-providers.activities` — its provider named through the
// switched providers module, its scheme by its chip where the reader reads no
// scheme, an open follow-up read overdue on its project's day, the wire kind
// and status beside the form's values for the commands it offers — and the
// records the workspace writes become the bodies the API's contracts accept,
// held here against the contracts' own zod schemas: a proposal opened on a
// route of its group, a follow-up on its award's project. What each side is
// offered, and the closing bodies, are lib/data/provider-activities.ts'.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Project } from "@waste/contracts/organisation"
import { ActivityClose, ActivityReject, ServiceProviderActivity as ActivitySchema, ServiceProviderActivityCreate, ServiceProviderActivityPatch, type ServiceProviderActivity } from "@waste/contracts/service-provider-activities"

import { COMMAND_SURFACES } from "@/components/waste/commands/command-surfaces"

import { FIXTURE_COMPANY_ID, getModuleDefinition, type BusinessRecord } from "../../data/business-modules"
import { activityCommandsOffered, activityCorrectable, activityOpenForm, closeBodyOf, createActivityRecord, kindsOpenedBy, PROVIDER_ACTIVITIES_MODULE, REASON_NEEDED, rejectBodyOf } from "../../data/provider-activities"
import { commandOffered } from "../../data/provider-workspace"
import { NOTHING_RESOLVED, isLocalRefusal, type MappingContext } from "../records/adapter"
import { isServerBacked, SERVER_MODULES } from "../records/modules"
import { projectAdapter } from "../records/organisation"
import { activityAdapter, toActivityCreateBody, toActivityPatchBody, toActivityRecord } from "../records/provider-activities"
import { loaded, resolverOver, type ServerRecordsState } from "../records/server-records"

const NOW = new Date("2026-08-13T12:00:00Z")
const STAMPS = { createdAt: "2026-08-01T09:00:00.000Z", updatedAt: "2026-08-01T09:30:00.000Z" }

const fixtures = getModuleDefinition(PROVIDER_ACTIVITIES_MODULE)?.records ?? []
const organisationFixtures = getModuleDefinition({ workspaceId: "configure", moduleId: "organization" })?.records ?? []

const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays", publicSlug: null, weightTolerancePercent: 5, paymentTermsDays: 30, paymentReferenceScheme: "none", holdForReview: false, privacyPolicy: { positionRetentionDays: null, proofRetentionDays: null, gpsPurpose: null }, branding: { brandColor: null, logoUrl: null, accessibilityStatementUrl: null } }
const NORDREN = "01a0d2a4-a280-7003-8000-000000000001"
const SCHEME = "01a0d2a4-a280-7010-8000-000000000001"
const GROUP = "01a0d2a4-a280-7011-8000-000000000001"
const SUCCESSOR = "01a0d2a4-a280-7010-8000-000000000002"
const AREA = "01a0d2a4-a280-7020-8000-000000000001"
const LARS = "01a0d2a4-a280-7005-8000-000000000002"

const proposal: ServiceProviderActivity = {
  id: "01a0d2a4-a280-7050-8000-000000000001",
  ...STAMPS,
  projectId: copenhagen.id,
  number: 88,
  kind: "route-day-change",
  status: "pending-approval",
  serviceProviderId: NORDREN,
  serviceAreaId: null,
  subject: "Organic route to Wednesday",
  body: "The market blocks Tuesday's streets.",
  dueOn: null,
  routeSchemeId: SCHEME,
  collectionGroupId: GROUP,
  serviceDays: ["wednesday"],
  effectiveFrom: "2026-08-26",
  vehicleId: null,
  driverId: null,
  containerIds: null,
  wasteFractionIds: null,
  successorSchemeId: null,
  openedBy: LARS,
  closedBy: null,
  closedAt: null,
  closeReason: null,
}
const followUp: ServiceProviderActivity = {
  ...proposal,
  id: "01a0d2a4-a280-7050-8000-000000000002",
  number: 89,
  kind: "compliance-follow-up",
  status: "open",
  serviceAreaId: AREA,
  subject: "Insurance document renewal",
  body: null,
  dueOn: "2026-08-12",
  routeSchemeId: null,
  collectionGroupId: null,
  serviceDays: null,
  effectiveFrom: null,
}

const projectRecord = projectAdapter.toRecord(copenhagen, { fixtures: organisationFixtures, resolve: NOTHING_RESOLVED, now: NOW })
/** A route of the scheme's group, as the routes module maps one: its project by web id, its scheme and group by their chips, which a provider's reader holds. */
const route: BusinessRecord = { ...projectRecord, id: "route-rc-1048", name: "RC-1048", recordKind: "Route", submittedValues: { projectId: projectRecord.id, schemeId: `scheme-${SCHEME}`, collectionGroupId: `group-${GROUP}` } }
/** An award, as the service areas module maps one: its project by web id. */
const award: BusinessRecord = { ...projectRecord, id: `service-area-${AREA}`, name: "CA-Ø-2 · Østerbro", recordKind: "Service area", submittedValues: { projectId: projectRecord.id } }
const state: ServerRecordsState = new Map([
  ["configure.organization", loaded({ records: [projectRecord], serverIds: new Map([[projectRecord.id, copenhagen.id]]) }, 1)],
  ["route-studio.routes", loaded({ records: [route], serverIds: new Map([[route.id, "01a0d2a4-a280-7030-8000-000000000001"]]) }, 1)],
  ["service-providers.service-areas", loaded({ records: [award], serverIds: new Map([[award.id, AREA]]) }, 1)],
])
const context: MappingContext = { fixtures, resolve: resolverOver(state), companyRecordId: FIXTURE_COMPANY_ID, now: NOW }

describe("an Activity as a record", () => {
  test("is the module's on the API, `provider-activity-<uuid>`, named by its number and subject, its command surface its own", () => {
    assert.ok(isServerBacked("service-providers", "activities"))
    const keys = SERVER_MODULES.map((module) => `${module.workspaceId}.${module.moduleId}`)
    assert.ok(keys.indexOf("service-providers.activities") > keys.indexOf("route-studio.routes"), "read after the routes a proposal is opened on")
    assert.ok(COMMAND_SURFACES["service-providers.activities"]?.rowActions)
    const record = toActivityRecord(ActivitySchema.parse(proposal), context)
    assert.equal(record.id, `provider-activity-${proposal.id}`)
    assert.equal(record.name, "ACT-88 · Organic route to Wednesday")
    assert.equal(record.status, "Pending approval")
    assert.equal(record.value, "Route-day change")
    assert.equal(record.facts["Route scheme"], `scheme-${SCHEME}`, "a scheme nobody read is its chip")
    assert.equal(record.facts["New days"], "Wednesday")
    assert.equal(record.submittedValues?.kind, "route-day-change")
    assert.equal(record.submittedValues?.status, "pending-approval")
    assert.equal(activityAdapter.auditTable, "service_provider_activity")
  })

  test("reads an open follow-up overdue on its project's day", () => {
    assert.equal(toActivityRecord(followUp, context).facts.Reading, "Open · overdue")
    assert.equal(toActivityRecord({ ...followUp, dueOn: "2026-08-13" }, context).facts.Reading, "Open")
  })

  test("names the version an approval wrote", () => {
    const approved = toActivityRecord({ ...proposal, status: "approved", successorSchemeId: SUCCESSOR, closedBy: LARS, closedAt: "2026-08-14T08:00:00.000Z" }, context)
    assert.equal(approved.facts["New version"], `scheme-${SUCCESSOR}`)
    assert.equal(approved.facts.Closed, "2026-08-14")
  })
})

describe("a create", () => {
  test("a proposal is opened on a route of its group: its project, scheme and group the route's", () => {
    const record = createActivityRecord({ kind: "route-day-change", subject: "Organic route to Wednesday", routeId: route.id, serviceDays: "friday,wednesday", effectiveFrom: "2026-08-26" }, 1, { serviceProviderId: `service-provider-${NORDREN}` })
    const body = toActivityCreateBody(record, context)
    assert.ok(!isLocalRefusal(body), JSON.stringify(body))
    assert.deepEqual(ServiceProviderActivityCreate.parse(body), {
      kind: "route-day-change",
      projectId: copenhagen.id,
      serviceProviderId: NORDREN,
      subject: "Organic route to Wednesday",
      routeSchemeId: SCHEME,
      collectionGroupId: GROUP,
      serviceDays: ["wednesday", "friday"],
      effectiveFrom: "2026-08-26",
    })
  })

  test("a follow-up takes its award's project", () => {
    const record = createActivityRecord({ kind: "compliance-follow-up", serviceProviderId: `service-provider-${NORDREN}`, subject: "Insurance", serviceAreaId: award.id, dueOn: "2026-08-12" }, 1)
    assert.deepEqual(ServiceProviderActivityCreate.parse(toActivityCreateBody(record, context)), { kind: "compliance-follow-up", projectId: copenhagen.id, serviceProviderId: NORDREN, serviceAreaId: AREA, subject: "Insurance", dueOn: "2026-08-12" })
  })

  test("refuses at the field before the API: no route, no days, no provider, no project", () => {
    const at = (values: Record<string, string>) => {
      const body = toActivityCreateBody(createActivityRecord({ serviceProviderId: `service-provider-${NORDREN}`, subject: "S", ...values }, 1), context)
      return isLocalRefusal(body) ? body.path : "accepted"
    }
    assert.equal(at({ kind: "route-day-change", serviceDays: "wednesday", effectiveFrom: "2026-08-26" }), "routeId")
    assert.equal(at({ kind: "route-day-change", routeId: route.id, effectiveFrom: "2026-08-26" }), "serviceDays")
    assert.equal(at({ kind: "coordination-note" }), "projectId")
    assert.equal(at({ kind: "coordination-note", projectId: projectRecord.id }), "accepted")
  })
})

describe("a vehicle change (#474, part 2)", () => {
  const TRUCK = "01a0d2a4-a280-7060-8000-000000000001"
  const DRIVER = "01a0d2a4-a280-7061-8000-000000000001"

  test("is opened on a route of its group with a truck, its driver where one is picked", () => {
    const record = createActivityRecord({ kind: "vehicle-change", subject: "Own truck", routeId: route.id, vehicleId: `vehicle-${TRUCK}`, effectiveFrom: "2026-08-26" }, 1, { serviceProviderId: `service-provider-${NORDREN}` })
    assert.equal(record.status, "Pending approval")
    assert.deepEqual(ServiceProviderActivityCreate.parse(toActivityCreateBody(record, context)), {
      kind: "vehicle-change",
      projectId: copenhagen.id,
      serviceProviderId: NORDREN,
      subject: "Own truck",
      routeSchemeId: SCHEME,
      collectionGroupId: GROUP,
      vehicleId: TRUCK,
      effectiveFrom: "2026-08-26",
    })
    const withDriver = createActivityRecord({ kind: "vehicle-change", subject: "Own truck", routeId: route.id, vehicleId: `vehicle-${TRUCK}`, driverId: `driver-${DRIVER}`, effectiveFrom: "2026-08-26" }, 1, { serviceProviderId: `service-provider-${NORDREN}` })
    assert.equal((toActivityCreateBody(withDriver, context) as { driverId?: string }).driverId, DRIVER)
    const unnamed = createActivityRecord({ kind: "vehicle-change", subject: "Own truck", routeId: route.id, effectiveFrom: "2026-08-26" }, 1, { serviceProviderId: `service-provider-${NORDREN}` })
    assert.equal((toActivityCreateBody(unnamed, context) as { path?: string }).path, "vehicleId")
  })

  test("reads its crew, and is decided by the office as a route-day change is", () => {
    const change = toActivityRecord({ ...proposal, kind: "vehicle-change", serviceDays: null, vehicleId: TRUCK, driverId: DRIVER }, context)
    assert.equal(change.facts["New vehicle"], `vehicle-${TRUCK}`)
    assert.equal(change.facts["New driver"], `driver-${DRIVER}`)
    assert.equal(change.value, "Vehicle change")
    assert.deepEqual(activityCommandsOffered(change, "office").map((offer) => offer.command), ["approve", "reject", "withdraw"])
    assert.deepEqual(activityCommandsOffered(change, "provider").map((offer) => offer.command), ["withdraw"])
    const moved = { ...change, submittedValues: { ...change.submittedValues, driverId: "" } }
    assert.deepEqual(ServiceProviderActivityPatch.parse(toActivityPatchBody(change, moved, context)), { driverId: null })
  })
})

describe("a stop-set change (#474, part 3)", () => {
  const BIN1 = "01a0d2a4-a280-7070-8000-000000000001"
  const BIN3 = "01a0d2a4-a280-7070-8000-000000000003"

  test("is opened on a route of its group with its containers in the order picked", () => {
    const record = createActivityRecord({ kind: "stop-set-change", subject: "Bin 3 first", routeId: route.id, containerIds: `asset-${BIN3},asset-${BIN1}`, effectiveFrom: "2026-08-26" }, 1, { serviceProviderId: `service-provider-${NORDREN}` })
    assert.equal(record.status, "Pending approval")
    assert.deepEqual(ServiceProviderActivityCreate.parse(toActivityCreateBody(record, context)), {
      kind: "stop-set-change",
      projectId: copenhagen.id,
      serviceProviderId: NORDREN,
      subject: "Bin 3 first",
      routeSchemeId: SCHEME,
      collectionGroupId: GROUP,
      containerIds: [BIN3, BIN1],
      effectiveFrom: "2026-08-26",
    })
    const empty = createActivityRecord({ kind: "stop-set-change", subject: "None", routeId: route.id, effectiveFrom: "2026-08-26" }, 1, { serviceProviderId: `service-provider-${NORDREN}` })
    assert.equal((toActivityCreateBody(empty, context) as { path?: string }).path, "containerIds")
  })

  test("reads its stops in order, and is corrected by its list, replaced whole", () => {
    const change = toActivityRecord({ ...proposal, kind: "stop-set-change", serviceDays: null, containerIds: [BIN3, BIN1] }, context)
    assert.equal(change.facts["New stops"], `asset-${BIN3} → asset-${BIN1}`)
    assert.equal(change.value, "Stop-set change")
    assert.deepEqual(activityCommandsOffered(change, "office").map((offer) => offer.command), ["approve", "reject", "withdraw"])
    const moved = { ...change, submittedValues: { ...change.submittedValues, containerIds: `asset-${BIN1}` } }
    assert.deepEqual(ServiceProviderActivityPatch.parse(toActivityPatchBody(change, moved, context)), { containerIds: [BIN1] })
  })
})

describe("a waste-fraction change (#474, part 4)", () => {
  const GLASS = "01a0d2a4-a280-7080-8000-000000000001"

  test("is opened on a route of its group with its rule's fractions, by the office on the web", () => {
    assert.ok(kindsOpenedBy("office").includes("waste-fraction-change"))
    assert.ok(!kindsOpenedBy("provider").includes("waste-fraction-change"), "a provider reads no fractions to pick from")
    const record = createActivityRecord({ kind: "waste-fraction-change", serviceProviderId: `service-provider-${NORDREN}`, subject: "Glass too", routeId: route.id, wasteFractionIds: `fraction-${GLASS}`, effectiveFrom: "2026-08-26" }, 1)
    assert.deepEqual(ServiceProviderActivityCreate.parse(toActivityCreateBody(record, context)), {
      kind: "waste-fraction-change",
      projectId: copenhagen.id,
      serviceProviderId: NORDREN,
      subject: "Glass too",
      routeSchemeId: SCHEME,
      collectionGroupId: GROUP,
      wasteFractionIds: [GLASS],
      effectiveFrom: "2026-08-26",
    })
  })

  test("reads its fractions and is decided by the office", () => {
    const change = toActivityRecord({ ...proposal, kind: "waste-fraction-change", serviceDays: null, wasteFractionIds: [GLASS] }, context)
    assert.equal(change.facts["New fractions"], `fraction-${GLASS}`)
    assert.equal(change.value, "Waste-fraction change")
    assert.deepEqual(activityCommandsOffered(change, "provider").map((offer) => offer.command), ["withdraw"])
  })
})

describe("a correction", () => {
  test("sends what moved, a proposal's days among them", () => {
    const before = toActivityRecord(proposal, context)
    const after = { ...before, submittedValues: { ...before.submittedValues, serviceDays: "thursday", subject: "Organic route to Thursday" } }
    assert.deepEqual(ServiceProviderActivityPatch.parse(toActivityPatchBody(before, after, context)), { subject: "Organic route to Thursday", serviceDays: ["thursday"] })
    assert.equal(toActivityPatchBody(before, before, context), null)
  })
})

describe("what each side is offered", () => {
  const record = (activity: ServiceProviderActivity) => toActivityRecord(activity, context)

  test("the office decides a pending proposal; its provider withdraws it", () => {
    assert.deepEqual(activityCommandsOffered(record(proposal), "office").map((offer) => offer.command), ["approve", "reject", "withdraw"])
    assert.deepEqual(activityCommandsOffered(record(proposal), "provider").map((offer) => offer.command), ["withdraw"])
    assert.deepEqual(activityCommandsOffered(record({ ...proposal, status: "approved", successorSchemeId: SUCCESSOR, closedBy: LARS, closedAt: STAMPS.updatedAt }), "office"), [])
  })

  test("a follow-up is the office's to close and to correct", () => {
    assert.deepEqual(activityCommandsOffered(record(followUp), "office").map((offer) => offer.command), ["complete", "cancel"])
    assert.deepEqual(activityCommandsOffered(record(followUp), "provider"), [])
    assert.equal(activityCorrectable(record(followUp), "office"), true)
    assert.equal(activityCorrectable(record(followUp), "provider"), false)
    assert.equal(activityCorrectable(record(proposal), "provider"), true)
  })

  test("a provider's account is offered the module's withdraw, complete and correction where its role edits it, never a decision", () => {
    const grants = [{ moduleKey: "service-providers.activities" as const, actions: ["view", "edit", "create"] as ("view" | "edit" | "create")[] }]
    const provider = { provider: true, grants }
    assert.equal(commandOffered(provider, "service-providers.activities", "withdraw"), true)
    assert.equal(commandOffered(provider, "service-providers.activities", "complete"), true)
    assert.equal(commandOffered(provider, "service-providers.activities", "patch"), true)
    assert.equal(commandOffered(provider, "service-providers.activities", "approve"), false)
  })

  test("the open form offers a provider a proposal or a note, and asks it no provider and no project", () => {
    assert.deepEqual(kindsOpenedBy("provider"), ["route-day-change", "vehicle-change", "stop-set-change", "coordination-note"])
    const ids = (side: "office" | "provider") => activityOpenForm(side, { routes: [], vehicles: [], drivers: [], containers: [], fractions: [], serviceAreas: [], providers: [], projects: [] }).sections.flatMap((section) => section.fields.map((field) => field.id))
    assert.ok(!ids("provider").includes("serviceProviderId"))
    assert.ok(!ids("provider").includes("projectId"))
    assert.ok(ids("office").includes("serviceProviderId"))
  })
})

describe("the closing bodies", () => {
  test("a rejection says why; every other close may", () => {
    assert.deepEqual(rejectBodyOf({ reason: " " }), { path: "reason", message: REASON_NEEDED })
    assert.deepEqual(ActivityReject.parse(rejectBodyOf({ reason: "Clashes with the glass round." })), { reason: "Clashes with the glass round." })
    assert.deepEqual(ActivityClose.parse(closeBodyOf({})), {})
    assert.deepEqual(ActivityClose.parse(closeBodyOf({ reason: "Received." })), { reason: "Received." })
  })
})
