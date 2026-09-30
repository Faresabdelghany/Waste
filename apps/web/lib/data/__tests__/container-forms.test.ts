// The container's forms on the Pilot (Issue #181): the create and edit form
// offer what the wire carries, and every command's dialog names its fields
// by the keys the command's `toBody` reads, so what a person fills in is the
// body the contract accepts — held here through the adapter itself.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { ContainerType, WasteFraction } from "@waste/contracts/catalogue"
import { ContainerCreate, ContainerServicePlacementCreate, type Container } from "@waste/contracts/containers"
import type { Project } from "@waste/contracts/organisation"
import { Adjust, Decommission, Receive, Return, Transfer } from "@waste/contracts/stock"

import { NOTHING_RESOLVED, type MappingContext } from "../../api/records/adapter"
import { containerAdapter, type ContainerCommand } from "../../api/records/containers"
import { containerTypeAdapter, wasteFractionAdapter } from "../../api/records/master-data"
import { projectAdapter } from "../../api/records/organisation"
import { loaded, resolverOver, type ServerRecordsState } from "../../api/records/server-records"
import { FIXTURE_COMPANY_ID, getModuleDefinition } from "../business-modules"
import type { BusinessFormSchema, BusinessFormValues } from "../business-form-types"
import { CONTAINER_COMMAND_FORMS, CONTAINER_COMMANDS_OFFERED, CONTAINER_FORM, containerEditForm, containerFormValues, createContainerRecord, updateContainerRecord } from "../containers"

const NOW = new Date("2026-09-30T12:00:00Z")
const STAMPS = { createdAt: "2026-09-24T09:00:00.000Z", updatedAt: "2026-09-25T09:30:00.000Z" }
const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays" }
const organic: WasteFraction = { id: "01a0d2a4-a280-7007-8000-000000000002", ...STAMPS, key: "organic", name: "Organic" }
const bin240: ContainerType = { id: "01a0d2a4-a280-7008-8000-000000000002", ...STAMPS, name: "Two-wheel bin · 240 L", volumeLitres: 240 }
const warehouseId = "01a0d2a4-a280-7021-8000-000000000001"
const subscriptionId = "01a0d2a4-a280-7013-8000-000000000001"

const projectRecord = projectAdapter.toRecord(copenhagen, { fixtures: getModuleDefinition({ workspaceId: "configure", moduleId: "organization" })?.records ?? [], resolve: NOTHING_RESOLVED, now: NOW })
const masterContext: MappingContext = { fixtures: [], resolve: NOTHING_RESOLVED, companyRecordId: FIXTURE_COMPANY_ID, now: NOW }
const organicRecord = wasteFractionAdapter.toRecord(organic, masterContext)
const bin240Record = containerTypeAdapter.toRecord(bin240, masterContext)
const state: ServerRecordsState = new Map([
  ["configure.organization", loaded({ records: [projectRecord], serverIds: new Map([[projectRecord.id, copenhagen.id]]) }, 1)],
  ["configure.master", loaded({ records: [organicRecord, bin240Record], serverIds: new Map([[organicRecord.id, organic.id], [bin240Record.id, bin240.id]]) }, 1)],
])
const context: MappingContext = { fixtures: [], resolve: resolverOver(state), companyRecordId: FIXTURE_COMPANY_ID, now: NOW }

const fieldIdsOf = (schema: BusinessFormSchema) => schema.sections.flatMap((section) => section.fields.map((field) => field.id))
const requiredOf = (schema: BusinessFormSchema) => schema.sections.flatMap((section) => section.fields.filter((field) => field.required).map((field) => field.id))

const bin91007: Container = { id: "01a0d2a4-a280-7014-8000-000000000007", ...STAMPS, projectId: copenhagen.id, label: "BIN-91007", containerTypeId: bin240.id, barcode: "WH91007", rfid: null, serialNumber: null, ownership: "company", notes: null, assetState: null }

describe("the container form on the Pilot", () => {
  test("offers what the wire carries, and nothing it would drop", () => {
    assert.deepEqual(fieldIdsOf(CONTAINER_FORM), ["projectId", "containerId", "barcode", "rfid", "serialNumber", "containerType", "ownership", "description"])
    assert.deepEqual(requiredOf(CONTAINER_FORM), ["projectId", "containerId", "containerType", "ownership"])
  })

  test("what it makes is a create body the contract accepts", () => {
    const record = createContainerRecord({ projectId: projectRecord.id, containerId: "BIN-95002", barcode: "", rfid: "E2095002", serialNumber: "", containerType: bin240Record.id, ownership: "company", description: "" }, { now: 1 })
    assert.ok(containerAdapter.owns(record))
    assert.equal(record.name, "BIN-95002")
    assert.deepEqual(record.projectIds, [projectRecord.id])
    const body = containerAdapter.toCreateBody?.(record, context)
    assert.deepEqual(body, { projectId: copenhagen.id, label: "BIN-95002", containerTypeId: bin240.id, rfid: "E2095002", ownership: "company" })
    assert.ok(ContainerCreate.safeParse(body).success)
  })

  test("the edit keeps the project, and offers the placement's corrections only where there is a placement", () => {
    const unplaced = containerAdapter.toRecord({ ...bin91007, placements: [] }, context)
    const unplacedForm = containerEditForm(unplaced)
    assert.ok(unplacedForm.sections.flatMap((section) => section.fields).find((field) => field.id === "projectId")?.readOnly)
    assert.ok(!fieldIdsOf(unplacedForm).includes("wasteFraction"))
    const placed = containerAdapter.toRecord({ ...bin91007, placements: [{ id: "01a0d2a4-a280-7015-8000-000000000007", ...STAMPS, projectId: copenhagen.id, containerId: bin91007.id, subscriptionId, wasteFractionId: organic.id, serviceFrequencyId: null, effectiveServiceFrequencyId: null, validFrom: "2026-01-01", validTo: "2026-09-01" }] }, context)
    assert.deepEqual(fieldIdsOf(containerEditForm(placed)).slice(-3), ["wasteFraction", "serviceFrequencyId", "placementTo"])
    const values = containerFormValues(placed)
    assert.equal(values.containerId, "BIN-91007")
    assert.equal(values.placementTo, "2026-08-31")
    const edited = updateContainerRecord(placed, { ...values, rfid: "E2091007", placementTo: "2026-08-30" })
    assert.equal(edited.id, placed.id)
    assert.deepEqual(containerAdapter.toPatchBody(placed, edited, context), {
      container: { rfid: "E2091007" },
      placement: { id: "01a0d2a4-a280-7015-8000-000000000007", patch: { validTo: "2026-08-31" } },
    })
  })
})

describe("the container's command dialogs", () => {
  const record = containerAdapter.toRecord({ ...bin91007, placements: [] }, context)
  const warehouse = `warehouse-${warehouseId}`
  /** What a person fills in, by the dialog's field ids. */
  const filled: Record<ContainerCommand, BusinessFormValues> = {
    receive: { warehouseId: warehouse, occurredAt: "", reference: "DN-4471" },
    issue: { subscriptionId, wasteFractionId: organicRecord.id, serviceFrequencyId: "", validFrom: "2026-10-01", occurredAt: "", reference: "" },
    return: { warehouseId: warehouse, toKind: "warehouse", lastDay: "2026-09-29", occurredAt: "", reason: "", reference: "" },
    transfer: { warehouseId: warehouse, toKind: "maintenance", occurredAt: "", reason: "Cracked lid", reference: "" },
    decommission: { reason: "Burnt out", lastDay: "", occurredAt: "", reference: "" },
    adjust: { toKind: "warehouse", warehouseId: warehouse, reason: "Imported without its receipt", correctsMovementId: "", occurredAt: "" },
  }
  const contracts: Record<ContainerCommand, { safeParse: (value: unknown) => { success: boolean } }> = { receive: Receive, issue: ContainerServicePlacementCreate, return: Return, transfer: Transfer, decommission: Decommission, adjust: Adjust }

  test("are offered for every command the container has, in the ledger's order", () => {
    assert.deepEqual([...CONTAINER_COMMANDS_OFFERED].sort(), Object.keys(containerAdapter.commands ?? {}).sort())
    assert.deepEqual(Object.keys(CONTAINER_COMMAND_FORMS).sort(), [...CONTAINER_COMMANDS_OFFERED].sort())
  })

  test("what each dialog is filled in with becomes the body its contract accepts", () => {
    for (const name of CONTAINER_COMMANDS_OFFERED) {
      assert.deepEqual(Object.keys(filled[name]).sort(), fieldIdsOf(CONTAINER_COMMAND_FORMS[name]).sort(), `${name}'s dialog fields`)
      const body = containerAdapter.commands?.[name]?.toBody?.(filled[name], record, context)
      assert.ok(contracts[name].safeParse(body).success, `${name}: ${JSON.stringify(body)}`)
    }
  })

  test("the door into service picks its subscription from the switched subscriptions, by web id (#184)", () => {
    const field = CONTAINER_COMMAND_FORMS.issue.sections.flatMap((section) => section.fields).find((candidate) => candidate.id === "subscriptionId")
    assert.equal(field?.type, "select")
    assert.deepEqual(field?.relation, { workspaceId: "customers", moduleId: "agreements" })
    const body = containerAdapter.commands?.issue?.toBody?.({ ...filled.issue, subscriptionId: `subscription-${subscriptionId}` }, record, context) as { subscriptionId?: string }
    assert.equal(body?.subscriptionId, subscriptionId)
  })

  test("a required field left blank is refused under that field's own id", () => {
    for (const name of CONTAINER_COMMANDS_OFFERED) {
      for (const fieldId of requiredOf(CONTAINER_COMMAND_FORMS[name])) {
        const body = containerAdapter.commands?.[name]?.toBody?.({ ...filled[name], [fieldId]: "" }, record, context) as { path?: string } | undefined
        assert.equal(body?.path, fieldId, `${name} without ${fieldId}`)
      }
    }
  })
})

