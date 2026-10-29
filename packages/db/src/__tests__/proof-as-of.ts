// `proof_of_service` as 0008 wrote it and 0029 still had it — every kind's
// shape, and no contaminant code — and as 0038 left it, with the code (M5 of
// #293), both before 0098 gave it the `volume` kind and the litres it carries
// (M11 of #293). pickup-exceptions-rendering.test.ts diffs 0029's to 0038's,
// and tanks-rendering.test.ts reads 0038's, since an applied file is never
// edited and the schema module spells the table as it is today.
import { PROOF_SHAPES } from "@waste/domain/execution/proof-shapes"
import { EXECUTION_SOURCES, PICKUP_OUTCOMES, PICKUP_REASONS, PROOF_KINDS } from "@waste/domain/execution/vocabulary"
import { sql, type SQL } from "drizzle-orm"
import { check, index, integer, text, timestamp, uuid, type PgColumn } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { userAccount } from "../schema/access"
import { literal, oneOf, positive } from "../schema/checks"
import { id, projectScoped, recorded } from "../schema/columns"
import { pickup, route, session } from "../schema/execution"
import { geometry, validGeometry } from "../schema/geometry"
import { company, project } from "../schema/organisation"
import { contaminantCode } from "../schema/pickup-exceptions"
import { companyReference, projectReference, tenantIndex, tenantReference } from "../schema/references"
import { wms } from "../schema/wms"

const instant = () => timestamp({ withTimezone: true })

/** The kinds before 0098: today's less `volume`. */
export const KINDS_BEFORE_TANKS = PROOF_KINDS.filter((kind) => kind !== "volume")

/** The kinds before 0098 by what they say of the pickup, as SQL literals. */
const naming = (presence: "required" | "optional" | "none") => sql.raw(KINDS_BEFORE_TANKS.filter((kind) => PROOF_SHAPES[kind].pickup === presence).map(literal).join(", "))

/** One `WHEN` of the kind CASE before 0098: the five columns a shape decided over then. */
function clause(kind: (typeof KINDS_BEFORE_TANKS)[number], columns: { reason: PgColumn; objectKey: PgColumn; weightKg: PgColumn; outcome: PgColumn; note: PgColumn; source: PgColumn }): SQL {
  const shape = PROOF_SHAPES[kind]
  const terms: SQL[] = []
  for (const column of ["reason", "objectKey", "weightKg", "outcome", "note"] as const) {
    const presence = shape[column]
    if (presence === "required") terms.push(sql`${columns[column]} is not null`)
    else if (presence === "none") terms.push(sql`${columns[column]} is null`)
  }
  if (shape.source === "dispatch") terms.push(sql`${columns.source} = 'dispatch'`)
  return sql`when ${sql.raw(literal(kind))} then ${sql.join(terms, sql` and `)}`
}

const columnsAsOf0029 = {
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
}

type ProofColumns = { [K in keyof typeof columnsAsOf0029]: PgColumn } & { id: PgColumn; companyId: PgColumn; projectId: PgColumn }

const constraintsAsOf0029 = (t: ProofColumns) => [
  companyReference(t as never, company),
  tenantReference(t as never, [t.projectId], project),
  projectReference(t as never, [t.routeId], route),
  projectReference(t as never, [t.routeId, t.pickupId], pickup, [pickup.routeId, pickup.id]),
  projectReference(t as never, [t.routeId, t.sessionId], session, [session.routeId, session.id]),
  tenantReference(t as never, [t.recordedBy], userAccount),
  oneOf(t.kind, KINDS_BEFORE_TANKS),
  oneOf(t.source, EXECUTION_SOURCES),
  oneOf(t.reason, PICKUP_REASONS),
  oneOf(t.outcome, PICKUP_OUTCOMES),
  validGeometry(t.location),
  positive(t.locationAccuracyM),
  positive(t.weightKg),
  check(
    tableObjectName(t.id.table, "pickup_shape", "proofOfService"),
    sql`(${t.kind} in (${naming("required")}) and ${t.pickupId} is not null) or (${t.kind} in (${naming("none")}) and ${t.pickupId} is null) or ${t.kind} in (${naming("optional")})`,
  ),
  check(tableObjectName(t.id.table, "session_shape", "proofOfService"), sql`(${t.source} = 'driver-app') = (${t.sessionId} is not null)`),
  check(tableObjectName(t.id.table, "kind_shape", "proofOfService"), sql`case ${t.kind} ${sql.join(KINDS_BEFORE_TANKS.map((kind) => clause(kind, t)), sql` `)} else false end`),
  index(tableObjectName(t.companyId.table, "route_id_idx", "proofOfService")).on(t.companyId, t.routeId, t.id),
  tenantIndex(t as never, t.projectId),
  tenantIndex(t as never, t.pickupId),
  tenantIndex(t as never, t.sessionId),
  tenantIndex(t as never, t.recordedBy),
]

export const proofAsOf0029 = wms.table("proof_of_service", columnsAsOf0029, (t) => constraintsAsOf0029(t as unknown as ProofColumns))

/** As 0038 left it (M5 of #293): the contaminant code an outcome is tagged with, on the kinds that record one. */
export const proofAsOf0038 = wms.table("proof_of_service", { ...columnsAsOf0029, contaminantCodeId: uuid() }, (t) => [
  ...constraintsAsOf0029(t as unknown as ProofColumns),
  tenantReference(t, [t.contaminantCodeId], contaminantCode),
  check(tableObjectName(t.id.table, "contaminant_code_shape", "proofOfService"), sql`${t.contaminantCodeId} is null or ${t.kind} in ('completion', 'skip', 'failure', 'correction')`),
  tenantIndex(t, t.contaminantCodeId),
])
