// Field inspections (M23 of #293, row 26.4): an inspector's visit to a
// container or a property, with what it came to, what was found and the
// photos taken.
//
// `field_inspection` is the office's row: its subject is exactly one of a
// container and a property (`subject_exactly_one`), of the inspection's
// project; the inspector is the account that recorded it. Its verdict and its
// findings agree (`findings_shape`: a compliant visit found nothing, any
// other something; that each is named once is the contracts' rule, the API
// being the only writer), and a closed inspection carries when
// (`closed_shape`). It is audited, so a correction of an open one is read in
// its history.
//
// `field_inspection_photo` is a ledger: one row per photo appended, by its
// key in the private `proofs` bucket under the inspection's own prefix
// (`inspectionPhotoKeyOf`, @waste/domain/inspections/rules), each key once.
// Its id is the photo id the key names.
import { FIELD_INSPECTION_OUTCOMES, FIELD_INSPECTION_STATUSES, INSPECTION_FINDINGS } from "@waste/domain/inspections/vocabulary"
import { sql } from "drizzle-orm"
import { check, index, text, timestamp, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { userAccount } from "./access"
import { exactlyOne, oneOf, subsetOf } from "./checks"
import { id, projectScoped, recorded, timestamps } from "./columns"
import { container } from "./containers"
import { property } from "./customers"
import { company, project } from "./organisation"
import { companyReference, projectKey, projectReference, tenantIndex, tenantReference, tenantUnique } from "./references"
import { wms } from "./wms"

const instant = () => timestamp({ withTimezone: true })

export const fieldInspection = wms.table(
  "field_inspection",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    /** The subject: exactly one of the two. */
    containerId: uuid(),
    propertyId: uuid(),
    /** The account that recorded it. */
    inspectorId: uuid().notNull(),
    inspectedAt: instant().notNull(),
    outcome: text().notNull(),
    findings: text().array().notNull().default(sql`'{}'::text[]`),
    note: text(),
    status: text().notNull().default("open"),
    closedAt: instant(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.containerId], container),
    projectReference(t, [t.propertyId], property),
    tenantReference(t, [t.inspectorId], userAccount),
    // A photo names its inspection with the project, as every child of a project-scoped row does.
    projectKey(t),
    exactlyOne(t, "subject", [t.containerId, t.propertyId]),
    oneOf(t.outcome, FIELD_INSPECTION_OUTCOMES),
    oneOf(t.status, FIELD_INSPECTION_STATUSES),
    subsetOf(t.findings, INSPECTION_FINDINGS),
    check(tableObjectName(t.id.table, "findings_shape", "fieldInspection"), sql`(${t.outcome} = 'compliant') = (cardinality(${t.findings}) = 0)`),
    check(tableObjectName(t.id.table, "closed_shape", "fieldInspection"), sql`(${t.status} = 'closed') = (${t.closedAt} is not null)`),
    // A subject's inspections, latest first: what its details list.
    index(tableObjectName(t.companyId.table, "container_id_idx", "fieldInspection")).on(t.companyId, t.containerId, t.inspectedAt),
    index(tableObjectName(t.companyId.table, "property_id_idx", "fieldInspection")).on(t.companyId, t.propertyId, t.inspectedAt),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.inspectorId),
  ],
)

export const fieldInspectionPhoto = wms.table(
  "field_inspection_photo",
  {
    ...id,
    ...projectScoped,
    ...recorded,
    inspectionId: uuid().notNull(),
    objectKey: text().notNull(),
    /** The account that appended it. */
    recordedBy: uuid().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.inspectionId], fieldInspection),
    tenantReference(t, [t.recordedBy], userAccount),
    tenantUnique(t, t.objectKey),
    tenantIndex(t, t.inspectionId),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.recordedBy),
  ],
)
