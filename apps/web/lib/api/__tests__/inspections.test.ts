// Field inspections on the adapters (M23 of #293): an inspection becomes a
// record of `operate.inspections`, `field-inspection-<uuid>`, named by its
// subject and its day, its verdict, findings and photos in words; the row the
// form makes becomes the create the contract takes — one subject, findings of
// the list — held here against its zod schema; a patch moves the verdict, the
// findings and the note alone; and a stop's fill estimate is a fact of the
// stop. Photos go through the client: signed, put, appended.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { FieldInspectionCreate, FieldInspectionPatch, type FieldInspection } from "@waste/contracts/field-inspections"

import { COMMAND_SURFACES, genericEditOffered } from "@/components/waste/commands/command-surfaces"

import { FIXTURE_COMPANY_ID, type BusinessRecord } from "../../data/business-modules"
import { mintedRecord } from "../../data/containers"
import { FILL_LABELS } from "../../data/fill-levels"
import { INSPECTION_RECORD_KIND, INSPECTIONS_MODULE } from "../../data/inspections"
import { isLocalRefusal, NOTHING_RESOLVED, type MappingContext, type Resolver } from "../records/adapter"
import { addInspectionPhoto, CLOSE_INSPECTION, inspectionAdapter, toInspectionCreateBody, toInspectionPatchBody, toInspectionRecord } from "../records/inspections"
import { isServerBacked, SERVER_MODULE_KEYS } from "../records/modules"
import { bodyOf, clientOver, json, scripted } from "./scripted-fetch"

const NOW = new Date("2027-03-04T12:00:00Z")
const STAMPS = { createdAt: "2027-03-04T09:00:00.000Z", updatedAt: "2027-03-04T09:30:00.000Z" }
const id = (n: number) => `01a0d2a4-a280-7061-8000-0000000000${String(n).padStart(2, "0")}`
const PROJECT = id(1)

const holding: Resolver = {
  ...NOTHING_RESOLVED,
  byServerId: (serverId) => (serverId === PROJECT ? ({ id: `project-${PROJECT}`, name: "Copenhagen", submittedValues: { timezone: "Europe/Copenhagen" } } as unknown as BusinessRecord) : undefined),
  serverIdOf: (webId) => (webId === `project-${PROJECT}` ? PROJECT : undefined),
}
const context: MappingContext = { fixtures: [], resolve: holding, companyRecordId: FIXTURE_COMPANY_ID, now: NOW }

const atTheBin: FieldInspection = {
  id: id(2),
  ...STAMPS,
  projectId: PROJECT,
  containerId: id(3),
  propertyId: null,
  inspectorId: id(4),
  inspectedAt: "2027-03-04T09:00:00.000Z",
  outcome: "major",
  findings: ["contamination", "overfilled"],
  note: null,
  status: "open",
  closedAt: null,
  photos: [{ id: id(5), objectKey: `inspections/x/${id(2)}/${id(5)}.jpg`, recordedAt: "2027-03-04T09:05:00.000Z" }],
}

describe("a field inspection as a record", () => {
  test("is the module's on the API, `field-inspection-<uuid>`, by its subject and day, its verdict and findings in words", () => {
    assert.ok(isServerBacked(INSPECTIONS_MODULE.workspaceId, INSPECTIONS_MODULE.moduleId))
    assert.ok(SERVER_MODULE_KEYS.indexOf("operate.inspections") > SERVER_MODULE_KEYS.indexOf("resources.containers"), "after the containers it names")
    const record = toInspectionRecord(atTheBin, context)
    assert.equal(record.id, `field-inspection-${atTheBin.id}`)
    assert.deepEqual([record.name, record.context, record.status, record.value], [`asset-${id(3)} · 2027-03-04`, "Major finding", "Open", "Contamination · Overfilled"])
    assert.deepEqual([record.facts.Container, record.facts.Photos, record.facts.Inspected], [`asset-${id(3)}`, "1", "2027-03-04 10:00"])
    assert.deepEqual(record.submittedValues, { containerId: `asset-${id(3)}`, propertyId: "", outcome: "major", findings: "contamination, overfilled", note: "", status: "open" })
    assert.ok(inspectionAdapter.owns(record))
    const atTheHouse = toInspectionRecord({ ...atTheBin, containerId: null, propertyId: id(6), outcome: "compliant", findings: [], status: "closed", closedAt: "2027-03-04T11:00:00.000Z" }, context)
    assert.deepEqual([atTheHouse.facts.Property, atTheHouse.value, atTheHouse.status, atTheHouse.facts.Closed], [`property-${id(6)}`, "Nothing found", "Closed", "2027-03-04 12:00"])
  })

  test("is recorded by its form, photographed and closed in its details, and corrected by the generic Edit only while open", () => {
    const surface = COMMAND_SURFACES["operate.inspections"]
    assert.equal(surface.primary, "form")
    assert.ok(surface.rowActions !== undefined)
    assert.equal(genericEditOffered(surface, toInspectionRecord(atTheBin, context)), true)
    assert.equal(genericEditOffered(surface, toInspectionRecord({ ...atTheBin, status: "closed", closedAt: NOW.toISOString() }, context)), false)
    assert.ok(inspectionAdapter.commands?.[CLOSE_INSPECTION] !== undefined)
  })
})

describe("the form's row as the wire's", () => {
  const row = (values: Record<string, string>) => mintedRecord({ id: "inspections-1", name: "", status: "Open", recordKind: INSPECTION_RECORD_KIND, values: { outcome: "minor", ...values } })

  test("one subject, by the server's id, and the findings of the list", () => {
    const body = toInspectionCreateBody(row({ containerId: `asset-${id(3)}`, findings: "damaged, blocked-access", note: "Lid cracked" }), context)
    assert.ok(!isLocalRefusal(body))
    assert.deepEqual(FieldInspectionCreate.parse(body), { containerId: id(3), outcome: "minor", findings: ["damaged", "blocked-access"], note: "Lid cracked" })
    const atTheHouse = toInspectionCreateBody(row({ propertyId: `property-${id(6)}`, outcome: "compliant" }), context)
    assert.deepEqual(FieldInspectionCreate.parse(atTheHouse), { propertyId: id(6), outcome: "compliant", findings: [] })
    for (const values of [{}, { containerId: `asset-${id(3)}`, propertyId: `property-${id(6)}` }] as Record<string, string>[]) {
      const refused = toInspectionCreateBody(row(values), context)
      assert.ok(isLocalRefusal(refused) && refused.path === "containerId", JSON.stringify(values))
    }
    const off = toInspectionCreateBody(row({ containerId: `asset-${id(3)}`, findings: "melted" }), context)
    assert.ok(isLocalRefusal(off) && off.path === "findings")
  })

  test("a patch moves the verdict, the findings and the note, never the subject", () => {
    const before = toInspectionRecord(atTheBin, context)
    const after = { ...before, submittedValues: { ...before.submittedValues, outcome: "minor", findings: "overfilled", note: "Garden waste" } }
    assert.deepEqual(FieldInspectionPatch.parse(toInspectionPatchBody(before, after)), { outcome: "minor", findings: ["overfilled"], note: "Garden waste" })
    assert.equal(toInspectionPatchBody(before, before), null)
    const moved = toInspectionPatchBody(before, { ...before, submittedValues: { ...before.submittedValues, containerId: `asset-${id(9)}` } })
    assert.ok(isLocalRefusal(moved) && moved.path === "containerId")
  })
})

describe("a photo", () => {
  test("is signed, put straight to Storage and appended by the key the upload named", async () => {
    const key = `inspections/${id(1)}/${atTheBin.id}/${id(7)}.jpg`
    const fetch = scripted([
      () => json({ objectKey: key, uploadUrl: "https://storage.test/upload/x?token=t", expiresAt: "2027-03-04T14:00:00.000Z" }),
      () => new Response(null, { status: 200 }),
      () => json({ ...atTheBin, photos: [...atTheBin.photos, { id: id(7), objectKey: key, recordedAt: NOW.toISOString() }] }, 201),
    ])
    const answered = await addInspectionPhoto(clientOver(fetch.fetch), atTheBin.id, { extension: "jpg", contentType: "image/jpeg", bytes: new ArrayBuffer(4) })
    assert.equal(answered.photos.length, 2)
    assert.deepEqual(
      fetch.calls.map((call) => `${call.init.method} ${call.url.replace("http://api.test", "")}`),
      [`POST /field-inspections/${atTheBin.id}/uploads`, "PUT https://storage.test/upload/x?token=t", `POST /field-inspections/${atTheBin.id}/photos`],
    )
    assert.deepEqual(bodyOf(fetch.calls[2]), { objectKey: key })
  })
})

describe("a stop's fill estimate", () => {
  test("is said in a person's words, emptiest first", () => {
    assert.deepEqual(Object.values(FILL_LABELS), ["Empty", "A quarter full", "Half full", "Three quarters full", "Full", "Overflowing"])
  })
})
