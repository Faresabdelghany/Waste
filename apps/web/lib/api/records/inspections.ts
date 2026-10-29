// Operate › Inspections on the API (M23 of #293): an inspector's visits to a
// container or a property, `field-inspection-<uuid>` from the start
// (`@waste/contracts/field-inspections`, routes
// apps/api/src/routes/field-inspections.ts). The subject is what the
// inspection is of, so a patch moves its verdict, findings and note alone,
// and only while it is open; Close ends it. A photo is not the store's: the
// details sign an upload, put the bytes to Storage and append the key through
// the client (`addInspectionPhoto`), then read the row back.
import type { FieldInspection, FieldInspectionCreate, FieldInspectionPatch, InspectionPhotoLinks, InspectionPhotoUpload } from "@waste/contracts/field-inspections"
import { FIELD_INSPECTION_OUTCOMES, INSPECTION_FINDINGS, type FieldInspectionOutcome, type InspectionFinding } from "@waste/domain/inspections/vocabulary"
import type { InspectionPhotoExtension } from "@waste/domain/inspections/rules"

import { PROPERTY_PREFIX } from "@/lib/data/agreements"
import { splitMultiValue } from "@/lib/data/business-form-records"
import { FIXTURE_COMPANY_ID, type BusinessRecord } from "@/lib/data/business-modules"
import { FINDING_LABELS, INSPECTION_PREFIX, INSPECTION_RECORD_KIND, INSPECTIONS_MODULE, OUTCOME_LABELS, STATUS_LABELS } from "@/lib/data/inspections"
import { isPropertyRecord } from "@/lib/data/properties"
import { putObject } from "@/lib/driver/reads"

import { command, create, get, listAll, patch, post, type ApiClient } from "../client"
import { inheritedPresentation, isLocalRefusal, ofKind, stampFacts, typed, webIdOf, type LocalRefusal, type MappingContext, type ResourceAdapter, type ServerModule } from "./adapter"
import { projectTimezoneOf, shownOn } from "./clock"
import { refusal } from "./places"
import { nameVia, typedReference, webIdVia } from "./references"

/** A container's web prefix: the containers module's rows. */
const CONTAINER_PREFIX = "asset"

/** The command that ends an open inspection. */
export const CLOSE_INSPECTION = "close"

const kept = "An inspection is of what it was recorded of: record another for another container or property"

const isOutcome = (value: string | undefined): value is FieldInspectionOutcome => FIELD_INSPECTION_OUTCOMES.includes(value as FieldInspectionOutcome)

/** The findings the form's multiselect holds, each one of the list; a value off the list is a refusal. */
function findingsOf(record: Parameters<typeof typed>[0]): InspectionFinding[] | LocalRefusal {
  const picked = splitMultiValue(typed(record, "findings") ?? "")
  const off = picked.find((value) => !INSPECTION_FINDINGS.includes(value as InspectionFinding))
  return off === undefined ? (picked as InspectionFinding[]) : refusal("findings", `${off} is not a finding`)
}

export function toInspectionRecord(inspection: FieldInspection, context: MappingContext): BusinessRecord {
  const project = context.resolve.byServerId(inspection.projectId)
  const projectWebId = project?.id ?? webIdVia(context, "project", inspection.projectId)
  const timezone = projectTimezoneOf({ projectIds: [projectWebId] }, context)
  const container = inspection.containerId === null ? undefined : context.resolve.byServerId(inspection.containerId)
  const subject =
    inspection.containerId !== null ? (container?.facts["Container ID"] ?? nameVia(context, CONTAINER_PREFIX, inspection.containerId)) : nameVia(context, PROPERTY_PREFIX, inspection.propertyId ?? "")
  const findings = inspection.findings.map((finding) => FINDING_LABELS[finding])
  const inspected = shownOn(inspection.inspectedAt, timezone)
  return {
    id: webIdOf(INSPECTION_PREFIX, inspection.id),
    name: `${subject} · ${inspected.slice(0, 10)}`,
    context: OUTCOME_LABELS[inspection.outcome],
    status: STATUS_LABELS[inspection.status],
    ...inheritedPresentation(undefined),
    ...stampFacts(inspection, context.now),
    value: findings.length === 0 ? "Nothing found" : findings.join(" · "),
    description: inspection.note ?? (findings.length === 0 ? "Nothing was found." : `Found: ${findings.join(", ").toLowerCase()}.`),
    facts: {
      [inspection.containerId !== null ? "Container" : "Property"]: subject,
      Verdict: OUTCOME_LABELS[inspection.outcome],
      ...(findings.length === 0 ? {} : { Findings: findings.join(" · ") }),
      Inspected: inspected,
      Inspector: nameVia(context, "user", inspection.inspectorId),
      Photos: String(inspection.photos.length),
      ...(inspection.note === null ? {} : { Note: inspection.note }),
      ...(inspection.closedAt === null ? {} : { Closed: shownOn(inspection.closedAt, timezone) }),
      ...(project?.name === undefined ? {} : { Project: project.name }),
    },
    related: [subject],
    allowedTransitions: [],
    companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
    projectIds: [projectWebId],
    recordKind: INSPECTION_RECORD_KIND,
    submittedValues: {
      containerId: inspection.containerId === null ? "" : webIdVia(context, CONTAINER_PREFIX, inspection.containerId),
      propertyId: inspection.propertyId === null ? "" : webIdVia(context, PROPERTY_PREFIX, inspection.propertyId),
      outcome: inspection.outcome,
      findings: inspection.findings.join(", "),
      note: inspection.note ?? "",
      status: inspection.status,
    },
  }
}

/** `POST /field-inspections` from a record the dialog made: one subject, by the server's id. */
export function toInspectionCreateBody(record: Parameters<typeof typed>[0] & { id: string }, context: MappingContext): FieldInspectionCreate | LocalRefusal {
  const containerId = typedReference(record as never, "containerId", CONTAINER_PREFIX, context, "Pick a container the API holds")
  if (isLocalRefusal(containerId)) return containerId
  const propertyId = typedReference(record as never, "propertyId", PROPERTY_PREFIX, context, "Pick a property the API holds", { owns: isPropertyRecord })
  if (isLocalRefusal(propertyId)) return propertyId
  if ((containerId === undefined) === (propertyId === undefined)) return refusal("containerId", "Pick a container or a property, one of the two")
  const outcome = typed(record, "outcome")
  if (!isOutcome(outcome)) return refusal("outcome", "Pick what the inspection came to")
  const findings = findingsOf(record)
  if (isLocalRefusal(findings)) return findings
  const note = typed(record, "note")
  return { ...(containerId === undefined ? { propertyId } : { containerId }), outcome, findings, ...(note === undefined ? {} : { note }) }
}

/** `PATCH /field-inspections/:id`: the verdict, the findings and the note that moved; the subject is the inspection's own. */
export function toInspectionPatchBody(before: Parameters<typeof typed>[0], after: Parameters<typeof typed>[0]): FieldInspectionPatch | null | LocalRefusal {
  for (const key of ["containerId", "propertyId"] as const) {
    if ((typed(after, key) ?? "") !== (typed(before, key) ?? "")) return refusal(key, kept)
  }
  const body: FieldInspectionPatch = {}
  const outcome = typed(after, "outcome")
  if (outcome !== typed(before, "outcome")) {
    if (!isOutcome(outcome)) return refusal("outcome", "Pick what the inspection came to")
    body.outcome = outcome
  }
  const findings = findingsOf(after)
  if (isLocalRefusal(findings)) return findings
  if (findings.join(", ") !== splitMultiValue(typed(before, "findings") ?? "").join(", ")) body.findings = findings
  const note = typed(after, "note") ?? null
  if (note !== (typed(before, "note") ?? null)) body.note = note
  return Object.keys(body).length === 0 ? null : body
}

export const inspectionAdapter: ResourceAdapter<FieldInspection> = {
  prefix: INSPECTION_PREFIX,
  auditTable: "field_inspection",
  // A row the dialog has just made is `inspections-<clock>` until the server answers: owned by its recordKind.
  owns: ofKind(INSPECTION_PREFIX, [INSPECTION_RECORD_KIND]),
  // An inspection's status moves by Close alone.
  statuses: undefined,
  list: (client: ApiClient) => listAll<FieldInspection>(client, "/field-inspections"),
  read: (client, serverId) => get<FieldInspection>(client, `/field-inspections/${serverId}`),
  toRecord: toInspectionRecord,
  toCreateBody: toInspectionCreateBody,
  toPatchBody: toInspectionPatchBody,
  create: (client, body) => create<FieldInspection>(client, "/field-inspections", body).then((created) => created.body),
  update: (client, serverId, body) => patch<FieldInspection>(client, `/field-inspections/${serverId}`, body),
  commands: {
    [CLOSE_INSPECTION]: {
      run: (client, serverId) => command<FieldInspection>(client, `/field-inspections/${serverId}/close`),
      refused: (record) => `${record.name} was not closed`,
    },
  },
}

/** The extension a photo's file is stored under: one of the bucket's images, read off its type. */
export function photoExtensionOf(file: { type: string; name: string }): InspectionPhotoExtension | undefined {
  if (file.type === "image/jpeg") return "jpg"
  if (file.type === "image/png") return "png"
  if (file.type === "image/webp") return "webp"
  const extension = file.name.split(".").at(-1)?.toLowerCase()
  return extension === "jpg" || extension === "jpeg" || extension === "png" || extension === "webp" ? extension : undefined
}

/** A photo added to an open inspection: the upload signed, the bytes put straight to Storage as the Driver App puts its own (`putObject`), the key appended. Answers the inspection as it now stands. */
export async function addInspectionPhoto(client: ApiClient, serverId: string, photo: { extension: InspectionPhotoExtension; contentType: string; bytes: ArrayBuffer }): Promise<FieldInspection> {
  const signed = await post<InspectionPhotoUpload>(client, `/field-inspections/${serverId}/uploads`, { extension: photo.extension })
  await putObject(client, signed.body.uploadUrl, photo)
  return (await post<FieldInspection>(client, `/field-inspections/${serverId}/photos`, { objectKey: signed.body.objectKey })).body
}

/** The inspection's photos with their read URLs. */
export const inspectionPhotoLinks = (client: ApiClient, serverId: string): Promise<InspectionPhotoLinks> => get<InspectionPhotoLinks>(client, `/field-inspections/${serverId}/photo-objects`)

/** Operate › Inspections: read after the containers and the properties its rows name. */
export const inspectionsModule: ServerModule = { workspaceId: INSPECTIONS_MODULE.workspaceId, moduleId: INSPECTIONS_MODULE.moduleId, resources: [inspectionAdapter] }
