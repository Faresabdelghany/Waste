// `proof_of_service` as 0008 wrote it and 0029 still had it: every kind's
// shape, and no contaminant code. pickup-exceptions-rendering.test.ts diffs
// from it (M5 of #293), since an applied file is never edited and the schema
// module spells the table as it is today.
import { EXECUTION_SOURCES, PICKUP_OUTCOMES, PICKUP_REASONS, PROOF_KINDS } from "@waste/domain/execution/vocabulary"
import { sql } from "drizzle-orm"
import { check, index, integer, text, timestamp, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { userAccount } from "../schema/access"
import { oneOf, positive } from "../schema/checks"
import { id, projectScoped, recorded } from "../schema/columns"
import { kindClause, kindsNaming, pickup, route, session } from "../schema/execution"
import { geometry, validGeometry } from "../schema/geometry"
import { company, project } from "../schema/organisation"
import { companyReference, projectReference, tenantIndex, tenantReference } from "../schema/references"
import { wms } from "../schema/wms"

const instant = () => timestamp({ withTimezone: true })

export const proofAsOf0029 = wms.table(
  "proof_of_service",
  {
    ...id,
    ...projectScoped,
    ...recorded,
    routeId: uuid().notNull(),
    pickupId: uuid(),
    sessionId: uuid(),
    kind: text().notNull(),
    source: text().notNull(),
    occurredAt: instant().notNull(),
    recordedBy: uuid().notNull(),
    deviceId: text(),
    location: geometry.point(),
    locationAccuracyM: integer(),
    reason: text(),
    note: text(),
    weightKg: integer(),
    objectKey: text(),
    outcome: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.routeId], route),
    projectReference(t, [t.routeId, t.pickupId], pickup, [pickup.routeId, pickup.id]),
    projectReference(t, [t.routeId, t.sessionId], session, [session.routeId, session.id]),
    tenantReference(t, [t.recordedBy], userAccount),
    oneOf(t.kind, PROOF_KINDS),
    oneOf(t.source, EXECUTION_SOURCES),
    oneOf(t.reason, PICKUP_REASONS),
    oneOf(t.outcome, PICKUP_OUTCOMES),
    validGeometry(t.location),
    positive(t.locationAccuracyM),
    positive(t.weightKg),
    check(
      tableObjectName(t.id.table, "pickup_shape", "proofOfService"),
      sql`(${t.kind} in (${kindsNaming("required")}) and ${t.pickupId} is not null) or (${t.kind} in (${kindsNaming("none")}) and ${t.pickupId} is null) or ${t.kind} in (${kindsNaming("optional")})`,
    ),
    check(tableObjectName(t.id.table, "session_shape", "proofOfService"), sql`(${t.source} = 'driver-app') = (${t.sessionId} is not null)`),
    check(tableObjectName(t.id.table, "kind_shape", "proofOfService"), sql`case ${t.kind} ${sql.join(PROOF_KINDS.map((kind) => kindClause(kind, t)), sql` `)} else false end`),
    index(tableObjectName(t.companyId.table, "route_id_idx", "proofOfService")).on(t.companyId, t.routeId, t.id),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.pickupId),
    tenantIndex(t, t.sessionId),
    tenantIndex(t, t.recordedBy),
  ],
)
