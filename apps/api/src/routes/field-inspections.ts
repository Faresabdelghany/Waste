// Field inspections (M23 of #293, row 26.4), under `operate.inspections`: an
// inspector's visit to a container or a property, what it came to, what was
// found and the photos taken. The subject is a container or a property of a
// project the caller works in (400 at its field otherwise), and the
// inspection is that project's; the inspector is the account that recorded
// it. While it is open its verdict, findings, note and instant may be
// corrected — the verdict and its findings judged together against the row's
// other half (`findingsIssue`) — and photos added; `close` ends that, and a
// closed inspection changes no more (409).
//
// A photo's bytes live in the private `proofs` bucket under the inspection's
// own prefix (`inspectionPhotoKeyOf`, @waste/domain/inspections/rules), as a
// driver's photos do under a command's: `POST /field-inspections/:id/uploads`
// signs the upload of a photo id the API mints, the client puts the bytes
// straight to Storage, and `POST /field-inspections/:id/photos` appends the
// key, held to the inspection's prefix; `GET /field-inspections/:id/photo-objects`
// signs read URLs. The two routes that call Storage hold no transaction
// across the call (#124 §4): their guard is `identify`, and each reads its
// fence in one short transaction of its own before it asks Storage, as
// routes/proof-objects.ts does, with the same 503 and 502.
import { Page } from "@waste/contracts/pagination"
import {
  FieldInspection,
  FieldInspectionCreate,
  FieldInspectionListQuery,
  FieldInspectionPatch,
  InspectionPhotoAppend,
  InspectionPhotoLinks,
  InspectionPhotoUpload,
  InspectionPhotoUploadRequest,
  type FieldInspectionOutcome,
  type FieldInspectionStatus,
  type InspectionFinding,
} from "@waste/contracts/field-inspections"
import { NO_PROOF_STORAGE } from "@waste/contracts/problem"
import type { Database, Tx } from "@waste/db/client"
import { container } from "@waste/db/schema/containers"
import { property } from "@waste/db/schema/customers"
import { fieldInspection, fieldInspectionPhoto } from "@waste/db/schema/inspections"
import { StorageRefused, StorageSilent, type ProofStorage } from "@waste/db/storage"
import { withCompany } from "@waste/db/tenant"
import { findingsIssue, inspectionPhotoKeyNames, inspectionPhotoKeyOf, photoIdOf } from "@waste/domain/inspections/rules"
import { and, asc, eq, gt, inArray } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type IdentifiedEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, loggable, problem, validate } from "../problem"
import { NO_PROOF_STORAGE_DETAIL, READ_URL_TTL_SECONDS, STORAGE_REFUSED, STORAGE_SILENT } from "./proof-objects"
import { created, describeCreated, describeJson, IdParam, instantOf, lockRow, refuseDuplicate, stampsOf } from "./shared"

const MODULE = "operate.inspections"

const InspectionPage = Page(FieldInspection)

/** What a subject outside the caller's projects is told, at its field. */
export const NOT_A_CONTAINER = "Not a container of a project this account works in"
export const NOT_A_PROPERTY = "Not a property of a project this account works in"
/** What a change to a closed inspection is told. */
export const INSPECTION_CLOSED = "The inspection is closed; it changes no more"
/** What a photo's key outside the inspection's prefix is told, at `objectKey`. */
export const KEY_NAMES_ANOTHER = "The photo key names another company or another inspection"
/** What a photo appended twice is told. */
export const PHOTO_ALREADY_APPENDED = "That photo is already the inspection's"
/** What an upload of a key the bucket holds already is told: a fresh id never meets one, so asking again signs another. */
export const PHOTO_ALREADY_UPLOADED = "Storage holds that photo already; ask again for another"

const noSuchInspection = (id: string) => problem(404, { detail: `No field inspection ${id} in the projects this account works in` })

const columns = {
  id: fieldInspection.id,
  projectId: fieldInspection.projectId,
  containerId: fieldInspection.containerId,
  propertyId: fieldInspection.propertyId,
  inspectorId: fieldInspection.inspectorId,
  inspectedAt: fieldInspection.inspectedAt,
  outcome: fieldInspection.outcome,
  findings: fieldInspection.findings,
  note: fieldInspection.note,
  status: fieldInspection.status,
  closedAt: fieldInspection.closedAt,
  createdAt: fieldInspection.createdAt,
  updatedAt: fieldInspection.updatedAt,
}

type Row = Pick<typeof fieldInspection.$inferSelect, keyof typeof columns>
type PhotoRow = { id: string; inspectionId: string; objectKey: string; recordedAt: Date }

function inspectionOf(row: Row, photos: readonly PhotoRow[]): FieldInspection {
  return {
    id: row.id,
    projectId: row.projectId,
    containerId: row.containerId,
    propertyId: row.propertyId,
    inspectorId: row.inspectorId,
    inspectedAt: row.inspectedAt.toISOString(),
    outcome: row.outcome as FieldInspectionOutcome,
    findings: row.findings as InspectionFinding[],
    note: row.note,
    status: row.status as FieldInspectionStatus,
    closedAt: instantOf(row.closedAt),
    photos: photos.map((photo) => ({ id: photo.id, objectKey: photo.objectKey, recordedAt: photo.recordedAt.toISOString() })),
    ...stampsOf(row),
  }
}

const inspectionScope = (principal: Principal) => and(eq(fieldInspection.companyId, principal.companyId), inProjects(fieldInspection.projectId, principal))

/** The photos of these inspections, in recording order. */
async function photosOf(tx: Tx, companyId: string, ids: readonly string[]): Promise<Map<string, PhotoRow[]>> {
  const byInspection = new Map<string, PhotoRow[]>()
  if (ids.length === 0) return byInspection
  const rows = await tx
    .select({ id: fieldInspectionPhoto.id, inspectionId: fieldInspectionPhoto.inspectionId, objectKey: fieldInspectionPhoto.objectKey, recordedAt: fieldInspectionPhoto.recordedAt })
    .from(fieldInspectionPhoto)
    .where(and(eq(fieldInspectionPhoto.companyId, companyId), inArray(fieldInspectionPhoto.inspectionId, [...ids])))
    .orderBy(asc(fieldInspectionPhoto.id))
  for (const row of rows) byInspection.set(row.inspectionId, [...(byInspection.get(row.inspectionId) ?? []), row])
  return byInspection
}

async function findInspection(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .select(columns)
    .from(fieldInspection)
    .where(and(inspectionScope(principal), eq(fieldInspection.id, id)))
    .limit(1)
  return row
}

/** One inspection on the wire, with its photos. */
async function answered(tx: Tx, principal: Principal, row: Row): Promise<FieldInspection> {
  return inspectionOf(row, (await photosOf(tx, principal.companyId, [row.id])).get(row.id) ?? [])
}

/** The project of the subject the body names, read under the caller's projects: a container's or a property's (400 at its field otherwise). */
async function subjectProject(tx: Tx, principal: Principal, subject: { containerId?: string | null; propertyId?: string | null }): Promise<string> {
  if (subject.containerId != null) {
    const [found] = await tx
      .select({ projectId: container.projectId })
      .from(container)
      .where(and(eq(container.companyId, principal.companyId), inProjects(container.projectId, principal), eq(container.id, subject.containerId)))
      .limit(1)
    if (found === undefined) throw invalidRequest("body", [{ path: "containerId", message: NOT_A_CONTAINER }])
    return found.projectId
  }
  const [found] = await tx
    .select({ projectId: property.projectId })
    .from(property)
    .where(and(eq(property.companyId, principal.companyId), inProjects(property.projectId, principal), eq(property.id, subject.propertyId ?? "")))
    .limit(1)
  if (found === undefined) throw invalidRequest("body", [{ path: "propertyId", message: NOT_A_PROPERTY }])
  return found.projectId
}

/** An open inspection, locked: the path's row (404), then its state (409). */
async function openInspection(tx: Tx, principal: Principal, id: string): Promise<Row> {
  await lockRow(tx, fieldInspection, { companyId: principal.companyId, id })
  const current = await findInspection(tx, principal, id)
  if (current === undefined) throw noSuchInspection(id)
  if (current.status !== "open") throw problem(409, { detail: INSPECTION_CLOSED })
  return current
}

const problems = (action: "view" | "edit" | "create") => ({
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(`No active account here, or the caller's role does not allow \`${action}\` on \`${MODULE}\`.`),
})

export type FieldInspectionOptions = {
  /** The app's clock: an inspection's instant where the body gives none, a close's, a read URL's lapse. */
  now: () => Date
  /** The request pool: the Storage routes' short transactions run on it. */
  pool: Database
  /** The proofs' Storage, or null on a deployment without its key. */
  storage: ProofStorage | null
  /** Where the cause of Storage's silence goes. */
  log: (error: unknown) => void
}

export function fieldInspectionRoutes(guard: MiddlewareHandler<AuthEnv>, identified: MiddlewareHandler<IdentifiedEnv>, { now, pool, storage, log }: FieldInspectionOptions) {
  /** Storage, or the deployment's 503. */
  const required = (): ProofStorage => {
    if (storage === null) throw problem(503, { kind: NO_PROOF_STORAGE, detail: NO_PROOF_STORAGE_DETAIL })
    return storage
  }
  /** A call to Storage: its silence a 502, its refusal the deployment's 503, and the cause of either in the log. */
  const asking = async <T>(ask: () => Promise<T>): Promise<T> => {
    try {
      return await ask()
    } catch (error) {
      if (error instanceof StorageRefused) {
        log(loggable(error))
        throw problem(503, { kind: NO_PROOF_STORAGE, detail: STORAGE_REFUSED })
      }
      if (!(error instanceof StorageSilent)) throw error
      log(loggable(error))
      throw problem(502, { detail: STORAGE_SILENT })
    }
  }

  const routes = new Hono<AuthEnv>()
    .get(
      "/field-inspections",
      describeRoute({
        operationId: "listFieldInspections",
        summary: "The inspections of containers and properties",
        description:
          "One page of the field inspections of the projects the caller works in, oldest first, each with its photos in recording order. `projectId`, `containerId` and `propertyId` narrow it to a project or a subject, `outcome` to a verdict, `status` to the open or the closed. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of inspections.", InspectionPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, a filter is malformed, or `projectId` is not a project this account works in."),
          ...problems("view"),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", FieldInspectionListQuery),
      async (c) => {
        const { limit, cursor, projectId, containerId, propertyId, outcome, status } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await tx
          .select(columns)
          .from(fieldInspection)
          .where(
            and(
              inspectionScope(principal),
              projectId === undefined ? undefined : eq(fieldInspection.projectId, projectId),
              containerId === undefined ? undefined : eq(fieldInspection.containerId, containerId),
              propertyId === undefined ? undefined : eq(fieldInspection.propertyId, propertyId),
              outcome === undefined ? undefined : eq(fieldInspection.outcome, outcome),
              status === undefined ? undefined : eq(fieldInspection.status, status),
              after === undefined ? undefined : gt(fieldInspection.id, after),
            ),
          )
          .orderBy(asc(fieldInspection.id))
          .limit(fetchLimit(limit))
        const page = pageOf(rows, limit)
        const photos = await photosOf(tx, principal.companyId, page.items.map((row) => row.id))
        return c.json({ ...page, items: page.items.map((row) => inspectionOf(row, photos.get(row.id) ?? [])) })
      },
    )
    .post(
      "/field-inspections",
      describeRoute({
        operationId: "createFieldInspection",
        summary: "Record an inspection",
        description:
          "Records an inspector's visit to a container or a property — exactly one, of a project the caller works in (400 at `containerId` or `propertyId` otherwise) — in that project, with the caller as the inspector. `inspectedAt` is when the inspector stood there, the request's clock where it is not said. A `compliant` visit names no findings, a `minor` or a `major` one names what was found, each once (400 at `findings`). The inspection is open: photos are added and its verdict corrected until it is closed.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The inspection as it was written.", FieldInspection),
          400: describeProblem("The body is missing the verdict, names a member the server owns, no subject or two, a subject of no project this account works in, or findings its verdict disagrees with."),
          ...problems("create"),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", FieldInspectionCreate),
      async (c) => {
        const body = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const projectId = await subjectProject(tx, principal, body)
        const [row] = await tx
          .insert(fieldInspection)
          .values({
            id: newId(),
            companyId: principal.companyId,
            projectId,
            containerId: body.containerId ?? null,
            propertyId: body.propertyId ?? null,
            inspectorId: principal.user.id,
            inspectedAt: body.inspectedAt === undefined ? now() : new Date(body.inspectedAt),
            outcome: body.outcome,
            findings: body.findings,
            note: body.note ?? null,
          })
          .returning(columns)
        return created(c, "/field-inspections", inspectionOf(row, []))
      },
    )
    .get(
      "/field-inspections/:id",
      describeRoute({
        operationId: "getFieldInspection",
        summary: "One inspection",
        description: "One field inspection of a project the caller works in, with its photos in recording order. An inspection of another company, or of a project this account does not work in, is one that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The inspection.", FieldInspection),
          400: describeProblem("The path does not hold an id."),
          ...problems("view"),
          404: describeProblem("No inspection with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await findInspection(tx, principal, id)
        if (row === undefined) throw noSuchInspection(id)
        return c.json(await answered(tx, principal, row))
      },
    )
    .patch(
      "/field-inspections/:id",
      describeRoute({
        operationId: "patchFieldInspection",
        summary: "Correct an open inspection",
        description:
          "Corrects the verdict, the findings, the note or the instant of one open inspection, under its row lock; every field is optional and at least one must be given. A verdict and its findings are judged together, a field the patch leaves as the row has it (400 at `findings`). The subject is what the inspection is of: another subject is another inspection. A closed inspection changes no more (409).",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The inspection as it now stands.", FieldInspection),
          400: describeProblem("The path does not hold an id, or the patch is empty, names a field the caller does not own, or leaves a verdict its findings disagree with."),
          ...problems("edit"),
          404: describeProblem("No inspection with that id in the projects this account works in."),
          409: describeProblem(INSPECTION_CLOSED),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", FieldInspectionPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const fields = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const current = await openInspection(tx, principal, id)
        const issue = findingsIssue(fields.outcome ?? (current.outcome as FieldInspectionOutcome), fields.findings ?? (current.findings as InspectionFinding[]))
        if (issue !== undefined) throw invalidRequest("json", [{ path: "findings", message: issue }])
        const [row] = await tx
          .update(fieldInspection)
          .set({ ...fields, inspectedAt: fields.inspectedAt === undefined ? undefined : new Date(fields.inspectedAt) })
          .where(and(inspectionScope(principal), eq(fieldInspection.id, id)))
          .returning(columns)
        return c.json(await answered(tx, principal, row))
      },
    )
    .post(
      "/field-inspections/:id/close",
      describeRoute({
        operationId: "closeFieldInspection",
        summary: "Close an inspection",
        description: "Ends the office's work on one open inspection, at the request's clock: its verdict, findings and photos change no more (409 for one already closed).",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The inspection as it now stands.", FieldInspection),
          400: describeProblem("The path does not hold an id."),
          ...problems("edit"),
          404: describeProblem("No inspection with that id in the projects this account works in."),
          409: describeProblem(INSPECTION_CLOSED),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        await openInspection(tx, principal, id)
        const [row] = await tx
          .update(fieldInspection)
          .set({ status: "closed", closedAt: now() })
          .where(and(inspectionScope(principal), eq(fieldInspection.id, id)))
          .returning(columns)
        return c.json(await answered(tx, principal, row))
      },
    )
    .post(
      "/field-inspections/:id/photos",
      describeRoute({
        operationId: "appendFieldInspectionPhoto",
        summary: "Add a photo to an open inspection",
        description:
          "Appends a photo whose bytes were put through `POST /field-inspections/{id}/uploads`, by the key that upload named: `inspections/<companyId>/<inspectionId>/<photoId>.<jpg|jpeg|png|webp>`, held to this inspection's company and id (400 at `objectKey`). Each photo once (409). A closed inspection takes no more (409). Answers 201 with the inspection and no `Location`, like an append to a ledger.",
        security: BEARER_SECURITY,
        responses: {
          201: describeJson("The inspection with the photo.", FieldInspection),
          400: describeProblem("The path does not hold an id, or the key is not one of this inspection's photos."),
          ...problems("edit"),
          404: describeProblem("No inspection with that id in the projects this account works in."),
          409: describeProblem(`${INSPECTION_CLOSED}; or ${PHOTO_ALREADY_APPENDED}`),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", InspectionPhotoAppend),
      async (c) => {
        const { id } = c.req.valid("param")
        const { objectKey } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const current = await openInspection(tx, principal, id)
        if (!inspectionPhotoKeyNames(objectKey, { companyId: principal.companyId, inspectionId: id })) throw invalidRequest("json", [{ path: "objectKey", message: KEY_NAMES_ANOTHER }])
        await refuseDuplicate({ field_inspection_photo_pkey: PHOTO_ALREADY_APPENDED, field_inspection_photo_object_key_key: PHOTO_ALREADY_APPENDED }, () =>
          tx.insert(fieldInspectionPhoto).values({ id: photoIdOf(objectKey), companyId: principal.companyId, projectId: current.projectId, inspectionId: id, objectKey, recordedBy: principal.user.id }),
        )
        return c.json(await answered(tx, principal, current), 201)
      },
    )

  // The two routes that call Storage: `identify`, and a short transaction of their own before the call.
  const objects = new Hono<IdentifiedEnv>()
    .post(
      "/field-inspections/:id/uploads",
      describeRoute({
        operationId: "signFieldInspectionUpload",
        summary: "Where to put a photo's bytes",
        description:
          "Mints a photo id for one open inspection and answers its key in the private `proofs` bucket — `inspections/<companyId>/<inspectionId>/<photoId>.<extension>` — and a signed URL to `PUT` the bytes to, straight to Storage, until `expiresAt`. Then `POST /field-inspections/{id}/photos` appends the key. Nothing is written here, and no byte passes through the API.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The key, and where to put the bytes.", InspectionPhotoUpload),
          400: describeProblem("The path does not hold an id, or the body is not one of the bucket's image formats."),
          ...problems("edit"),
          404: describeProblem("No inspection with that id in the projects this account works in."),
          409: describeProblem(INSPECTION_CLOSED),
          502: describeProblem(STORAGE_SILENT),
          503: describeProblem(`${NO_PROOF_STORAGE_DETAIL}; or ${STORAGE_REFUSED}`),
        },
      }),
      identified,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", InspectionPhotoUploadRequest),
      async (c) => {
        const bucket = required()
        const { id } = c.req.valid("param")
        const { extension } = c.req.valid("json")
        const principal = c.get("principal")
        await withCompany(pool.db, principal.companyId, async (tx) => {
          const found = await findInspection(tx, principal, id)
          if (found === undefined) throw noSuchInspection(id)
          // A photo no append can land for is one nothing ever names.
          if (found.status !== "open") throw problem(409, { detail: INSPECTION_CLOSED })
        })
        const objectKey = inspectionPhotoKeyOf({ companyId: principal.companyId, inspectionId: id, photoId: newId() }, extension)
        const signed = await asking(() => bucket.signUpload(objectKey))
        if (signed.kind === "exists") throw problem(409, { detail: PHOTO_ALREADY_UPLOADED })
        const answer: InspectionPhotoUpload = { objectKey, uploadUrl: signed.url, expiresAt: signed.expiresAt.toISOString() }
        return c.json(answer)
      },
    )
    .get(
      "/field-inspections/:id/photo-objects",
      describeRoute({
        operationId: "getFieldInspectionPhotoObjects",
        summary: "Read URLs for an inspection's photos",
        description: `A read URL for each of the inspection's photos, in recording order, lasting ${READ_URL_TTL_SECONDS / 60} minutes; a null URL where the private \`proofs\` bucket holds no such object — appended, but never uploaded. No byte passes through the API.`,
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The inspection's photos and their read URLs.", InspectionPhotoLinks),
          400: describeProblem("The path does not hold an id."),
          ...problems("view"),
          404: describeProblem("No inspection with that id in the projects this account works in."),
          502: describeProblem(STORAGE_SILENT),
          503: describeProblem(`${NO_PROOF_STORAGE_DETAIL}; or ${STORAGE_REFUSED}`),
        },
      }),
      identified,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const bucket = required()
        const { id } = c.req.valid("param")
        const principal = c.get("principal")
        const photos = await withCompany(pool.db, principal.companyId, async (tx) => {
          const found = await findInspection(tx, principal, id)
          if (found === undefined) throw noSuchInspection(id)
          return (await photosOf(tx, principal.companyId, [id])).get(id) ?? []
        })
        const expiresAt = new Date(now().getTime() + READ_URL_TTL_SECONDS * 1000).toISOString()
        const urls = await asking(() => bucket.signReads(photos.map((photo) => photo.objectKey), READ_URL_TTL_SECONDS))
        const answer: InspectionPhotoLinks = { items: photos.map((photo) => ({ photoId: photo.id, objectKey: photo.objectKey, url: urls.get(photo.objectKey) ?? null, expiresAt })) }
        return c.json(answer)
      },
    )

  return { routes, objects }
}
