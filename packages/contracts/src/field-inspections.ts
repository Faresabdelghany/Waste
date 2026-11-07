// The wire of field inspections (M23 of #293, row 26.4): an inspector's
// visit to a container or a property, what it came to, what was found and
// the photos taken. The routes are apps/api/src/routes/field-inspections.ts;
// what a verdict and its findings hold to, and where a photo's bytes live,
// are @waste/domain/inspections/rules.
//
// An inspection names its subject — a container, or a property — and never
// both; the project is the subject's. The inspector is the account that
// recorded it. While it is `open` its verdict, findings, note and instant may
// be corrected and photos added; `POST /field-inspections/:id/close` ends
// that, and a closed inspection changes no more. A photo is put to the
// private `proofs` bucket under the inspection's prefix through a signed URL
// (`POST /field-inspections/:id/uploads`, as the driver door's uploads are),
// then appended by its key; the bytes never pass through the API.
import { findingsIssue, ONE_SUBJECT } from "@waste/domain/inspections/rules"
import { FIELD_INSPECTION_OUTCOMES, FIELD_INSPECTION_STATUSES, INSPECTION_FINDINGS } from "@waste/domain/inspections/vocabulary"
import { IMAGE_EXTENSIONS, OBJECT_KEY_MAX } from "@waste/domain/storage-objects"
import * as z from "zod"

import { IsoDateTime } from "./dates"
import { Id } from "./ids"
import { ProjectScopedListQuery } from "./queries"
import { resourceBodies, stamped } from "./resource"
import { Paragraph } from "./text"

export const FieldInspectionOutcome = z.enum(FIELD_INSPECTION_OUTCOMES)
export type FieldInspectionOutcome = z.infer<typeof FieldInspectionOutcome>
export const InspectionFinding = z.enum(INSPECTION_FINDINGS)
export type InspectionFinding = z.infer<typeof InspectionFinding>
export const FieldInspectionStatus = z.enum(FIELD_INSPECTION_STATUSES)
export type FieldInspectionStatus = z.infer<typeof FieldInspectionStatus>

/** A photo of an inspection, by its key in the proofs bucket. */
export const InspectionPhoto = z.object({
  id: Id,
  objectKey: z.string(),
  recordedAt: IsoDateTime,
})
export type InspectionPhoto = z.infer<typeof InspectionPhoto>

export const FieldInspection = z.object({
  ...stamped,
  projectId: Id,
  /** The subject: exactly one of the two. */
  containerId: Id.nullable(),
  propertyId: Id.nullable(),
  /** The account that recorded the inspection. */
  inspectorId: Id,
  inspectedAt: IsoDateTime,
  outcome: FieldInspectionOutcome,
  findings: z.array(InspectionFinding),
  note: Paragraph.nullable(),
  status: FieldInspectionStatus,
  closedAt: IsoDateTime.nullable(),
  /** In recording order. */
  photos: z.array(InspectionPhoto),
})
export type FieldInspection = z.infer<typeof FieldInspection>

/** The verdict and its findings agree, the disagreement told at `findings`. */
const findingsAgree = (value: { outcome: FieldInspectionOutcome; findings: InspectionFinding[] }, context: z.RefinementCtx) => {
  const issue = findingsIssue(value.outcome, value.findings)
  if (issue !== undefined) context.addIssue({ code: "custom", message: issue, path: ["findings"] })
}
const oneSubject = (value: { containerId?: string | null; propertyId?: string | null }) => (value.containerId == null) !== (value.propertyId == null)

/**
 * The instant is when the inspector stood there, the request's clock where it
 * is not said. A patch is an open inspection's correction: its subject is
 * what it is, so the verdict, the findings, the note and the instant alone; a
 * verdict and its findings are judged together against the row's other half
 * by the API.
 */
const fieldInspectionBodies = resourceBodies(
  {
    containerId: Id.nullable().optional(),
    propertyId: Id.nullable().optional(),
    inspectedAt: IsoDateTime.optional(),
    outcome: FieldInspectionOutcome,
    findings: z.array(InspectionFinding).max(INSPECTION_FINDINGS.length).default([]),
    note: Paragraph.nullable().optional(),
  },
  { createOnly: { containerId: true, propertyId: true } },
)

export const FieldInspectionCreate = fieldInspectionBodies.create.refine(oneSubject, { message: ONE_SUBJECT, path: ["containerId"] }).superRefine(findingsAgree)
export type FieldInspectionCreate = z.infer<typeof FieldInspectionCreate>

export const FieldInspectionPatch = fieldInspectionBodies.patch
export type FieldInspectionPatch = z.infer<typeof FieldInspectionPatch>

/** A page of inspections: one project's, one subject's, one verdict's, open or closed. */
export const FieldInspectionListQuery = ProjectScopedListQuery.extend({
  containerId: Id.optional(),
  propertyId: Id.optional(),
  outcome: FieldInspectionOutcome.optional(),
  status: FieldInspectionStatus.optional(),
})
export type FieldInspectionListQuery = z.infer<typeof FieldInspectionListQuery>

/** `POST /field-inspections/:id/uploads`: a photo's format; the API mints its id and names its key. */
export const InspectionPhotoUploadRequest = z.strictObject({ extension: z.enum(IMAGE_EXTENSIONS) })
export type InspectionPhotoUploadRequest = z.infer<typeof InspectionPhotoUploadRequest>

/** Where to put the photo's bytes until `expiresAt`, under the key to append it by. */
export const InspectionPhotoUpload = z.strictObject({ objectKey: z.string(), uploadUrl: z.url(), expiresAt: IsoDateTime })
export type InspectionPhotoUpload = z.infer<typeof InspectionPhotoUpload>

/** `POST /field-inspections/:id/photos`: the key an upload named, once its bytes are put. */
export const InspectionPhotoAppend = z.strictObject({ objectKey: z.string().min(1).max(OBJECT_KEY_MAX) })
export type InspectionPhotoAppend = z.infer<typeof InspectionPhotoAppend>

/** A read URL for one of an inspection's photos, until `expiresAt`; null where Storage holds none — never uploaded. */
export const InspectionPhotoLink = z.strictObject({ photoId: Id, objectKey: z.string(), url: z.url().nullable(), expiresAt: IsoDateTime })
export type InspectionPhotoLink = z.infer<typeof InspectionPhotoLink>

/** `GET /field-inspections/:id/photo-objects`: the inspection's photos, in recording order. */
export const InspectionPhotoLinks = z.strictObject({ items: z.array(InspectionPhotoLink) })
export type InspectionPhotoLinks = z.infer<typeof InspectionPhotoLinks>
