// Weight review on the adapter (#186, slice 11 of #81, for #148): the unloads
// a route's driver recorded, as `route-studio.weights`, read with their review
// status — `captured` is "Needs review" — and moved by approve, reject (with
// the note that says why) and correct (the new weights, as a new unload).
// Each command answers the review it appended, so the unload is read back for
// the row; a correction adds a row, so the module is read again.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { BOTH_GROSS_AND_TARE as WIRE_BOTH, NET_IS_GROSS_LESS_TARE as WIRE_NET, type Unload } from "@waste/contracts/unloads"
import { WeightApprove, WeightCorrect, WeightReject, type WeightReview } from "@waste/contracts/weight-control"

import { FIXTURE_COMPANY_ID, getModuleDefinition, type BusinessRecord } from "../../data/business-modules"
import { WEIGHTS_MODULE } from "../../data/provider-money"
import { problemSentence } from "../problem"
import { NOTHING_RESOLVED, type MappingContext } from "../records/adapter"
import { isServerBacked, SERVER_MODULE_KEYS } from "../records/modules"
import { commandRecord, loaded, resolverOver, spellsStatus, type ServerRecordsState } from "../records/server-records"
import { BOTH_GROSS_AND_TARE, NET_IS_GROSS_LESS_TARE, REVIEW_LABELS, unloadAdapter, weightReviewsOffered, weightsModule } from "../records/weights"
import { bodyOf, clientOver, json, problem, scripted } from "./scripted-fetch"

const NOW = new Date("2026-09-30T12:00:00Z")
const fixtures = getModuleDefinition(WEIGHTS_MODULE)?.records ?? []
const PROJECT = "01a0d2a4-a280-7002-8000-000000000001"
const ROUTE = "01a0d2a4-a280-7030-8000-000000000001"
const STATION = "01a0d2a4-a280-7020-8000-000000000002"
const RESIDUAL = "01a0d2a4-a280-7005-8000-000000000001"
const DRIVER = "01a0d2a4-a280-7003-8000-000000000003"

const raw: Unload = {
  id: "01a0d2a4-a280-7096-8000-000000000001",
  recordedAt: "2026-09-29T13:10:00.000Z",
  projectId: PROJECT,
  routeId: ROUTE,
  sessionId: "01a0d2a4-a280-7097-8000-000000000001",
  unloadingStationId: STATION,
  wasteFractionId: RESIDUAL,
  source: "driver-app",
  occurredAt: "2026-09-29T13:05:00.000Z",
  recordedBy: DRIVER,
  deviceId: "phone-1",
  location: null,
  grossKg: 18400,
  tareKg: 11200,
  netKg: 7200,
  weighbridgeTicket: "WB-2026-3901",
  objectKey: null,
  note: null,
  weightReview: { status: "captured", latestReviewId: null, correctionUnloadId: null },
}
/** As the adapter lists it: a ledger row with a resource's stamps. */
const unload = { ...raw, createdAt: raw.recordedAt, updatedAt: raw.recordedAt }

const bare: MappingContext = { fixtures, resolve: NOTHING_RESOLVED, companyRecordId: FIXTURE_COMPANY_ID, now: NOW }
const plain = (id: string, name: string, extra: Partial<BusinessRecord> = {}): BusinessRecord =>
  ({ id, name, context: "", status: "Active", owner: "", value: "", updated: "", description: "", facts: {}, related: [], source: "", freshness: "", recordKind: "", submittedValues: {}, ...extra }) as BusinessRecord
const moduleOf = (records: BusinessRecord[], ids: string[]) => loaded({ records, serverIds: new Map(records.map((record, index) => [record.id, ids[index]])) }, 1)
const state: ServerRecordsState = new Map([
  ["configure.organization", moduleOf([plain(`project-${PROJECT}`, "Copenhagen Central", { submittedValues: { timezone: "Europe/Copenhagen" } })], [PROJECT])],
  ["route-studio.routes", moduleOf([plain(`route-${ROUTE}`, "RC-1042 · 2026-09-29")], [ROUTE])],
  ["resources.depots", moduleOf([plain(`station-${STATION}`, "ARC Amager")], [STATION])],
  ["configure.master", moduleOf([plain(`fraction-${RESIDUAL}`, "Residual")], [RESIDUAL])],
])
const context: MappingContext = { ...bare, resolve: resolverOver(state) }

describe("the weights module", () => {
  test("is switched after the routes, the stations and the fractions an unload names", () => {
    assert.ok(isServerBacked("route-studio", "weights"))
    const at = SERVER_MODULE_KEYS.indexOf("route-studio.weights")
    for (const before of ["route-studio.routes", "resources.depots", "configure.master"]) assert.ok(SERVER_MODULE_KEYS.indexOf(before) < at, before)
    assert.deepEqual(weightsModule.resources, [unloadAdapter])
  })

  test("shows an unload by its route and station, its weights in kilograms, captured as Needs review", () => {
    const record = unloadAdapter.toRecord(unload, context)
    assert.equal(record.id, `unload-${unload.id}`)
    assert.equal(record.name, "WB-2026-3901 · Residual")
    assert.equal(record.context, "RC-1042 · 2026-09-29 · ARC Amager")
    assert.equal(record.status, "Needs review")
    assert.equal(record.value, "7,200 kg")
    assert.equal(record.facts.Gross, "18,400 kg")
    assert.equal(record.facts.Tare, "11,200 kg")
    assert.equal(record.facts.Occurred, "2026-09-29 15:05")
    assert.deepEqual(REVIEW_LABELS, { captured: "Needs review", approved: "Approved", rejected: "Rejected", corrected: "Corrected" })
    assert.equal(unloadAdapter.toRecord({ ...unload, grossKg: null, tareKg: null, weighbridgeTicket: null }, context).name, "Residual at ARC Amager")
    assert.ok(!spellsStatus(weightsModule, record, "Approved"), "a review is a command, never a patch")
  })

  test("offers the reviews the machine moves an unload by, never the decision it holds, and none once it was corrected", () => {
    const offered = (status: Unload["weightReview"]["status"]) => weightReviewsOffered(unloadAdapter.toRecord({ ...unload, weightReview: { ...unload.weightReview, status } }, context))
    assert.deepEqual(offered("captured"), ["approve", "reject", "correct"])
    assert.deepEqual(offered("approved"), ["reject", "correct"])
    assert.deepEqual(offered("rejected"), ["approve", "correct"])
    assert.deepEqual(offered("corrected"), [], "the correction is the row to review")
  })

  test("approves, rejects with its note and corrects with the new weights, reading the unload back after each review", async () => {
    const record = unloadAdapter.toRecord(unload, context)
    const current = moduleOf([record], [unload.id])
    const review = (decision: WeightReview["decision"], correctionUnloadId: string | null = null): WeightReview => ({ id: "01a0d2a4-a280-7098-8000-000000000001", recordedAt: "2026-09-30T12:00:00.000Z", projectId: PROJECT, unloadId: unload.id, decision, note: null, correctionUnloadId, reviewedBy: DRIVER })
    const { fetch, calls } = scripted([
      () => json(review("approved"), 201),
      () => json({ ...unload, weightReview: { status: "approved", latestReviewId: "r", correctionUnloadId: null } }),
      () => problem(409, "This unload was corrected by unload 01a0d2a4; review that one"),
      () => json(review("corrected", "01a0d2a4-a280-7096-8000-000000000002"), 201),
      () => json({ ...unload, weightReview: { status: "corrected", latestReviewId: "r", correctionUnloadId: "01a0d2a4-a280-7096-8000-000000000002" } }),
    ])
    const options = { fixtures, state }
    const approved = await commandRecord(clientOver(fetch), weightsModule, current, record, "approve", { note: "" }, options)
    assert.equal(approved.kind, "done")
    if (approved.kind === "done") assert.equal(approved.record.status, "Approved")
    assert.deepEqual([calls[0].init.method, calls[0].url], ["POST", `http://api.test/unloads/${unload.id}/approve`])
    assert.ok(WeightApprove.safeParse(bodyOf(calls[0])).success)
    assert.equal(calls[1].url, `http://api.test/unloads/${unload.id}`)
    const unsaid = await commandRecord(clientOver(fetch), weightsModule, current, record, "reject", { note: "" }, options)
    assert.equal(unsaid.kind, "refused", "a rejection says why")
    const rejected = await commandRecord(clientOver(fetch), weightsModule, current, record, "reject", { note: "Wrong vehicle" }, options)
    assert.equal(rejected.kind, "refused")
    if (rejected.kind === "refused") assert.match(problemSentence(rejected.problem), /review that one/)
    assert.ok(WeightReject.safeParse(bodyOf(calls[2])).success)
    const corrected = await commandRecord(clientOver(fetch), weightsModule, current, record, "correct", { netKg: "7100", grossKg: "18300", tareKg: "11200", weighbridgeTicket: "WB-2026-3901B", note: "Ticket misread" }, options)
    assert.equal(corrected.kind, "done")
    assert.deepEqual(bodyOf(calls[3]), { netKg: 7100, grossKg: 18300, tareKg: 11200, weighbridgeTicket: "WB-2026-3901B", note: "Ticket misread" })
    assert.ok(WeightCorrect.safeParse(bodyOf(calls[3])).success)
    if (corrected.kind === "done") assert.deepEqual(corrected.touches, ["route-studio.weights"], "the correction's new unload is read with the module")
    const halfWeighed = await commandRecord(clientOver(fetch), weightsModule, current, record, "correct", { netKg: "7100", grossKg: "18300", note: "x" }, options)
    assert.equal(halfWeighed.kind, "refused", "gross and tare come together")
    assert.equal(BOTH_GROSS_AND_TARE, WIRE_BOTH, "the contract's sentences, spelled again since the web imports the contracts as types")
    assert.equal(NET_IS_GROSS_LESS_TARE, WIRE_NET)
  })
})
