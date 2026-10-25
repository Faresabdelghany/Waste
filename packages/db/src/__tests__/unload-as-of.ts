// `unload` as 0010 (Issue #112) left it and every migration since kept it,
// until the weighbridge's refusal (O9 of #290): the project key the weight
// review points at, and no refusal. weighbridge-rendering.test.ts diffs from
// it, since an applied file is never edited and the schema module spells the
// table as it is today. Not a suite of its own: only ever imported.
import { EXECUTION_SOURCES } from "@waste/domain/execution/vocabulary"
import { sql } from "drizzle-orm"
import { check, integer, text, timestamp, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { userAccount } from "../schema/access"
import { wasteFraction } from "../schema/catalogue"
import { oneOf, positive } from "../schema/checks"
import { id, projectScoped, recorded } from "../schema/columns"
import { route, session } from "../schema/execution"
import { geometry, validGeometry } from "../schema/geometry"
import { company, project } from "../schema/organisation"
import { unloadingStation } from "../schema/places"
import { companyReference, projectKey, projectReference, tenantIndex, tenantReference } from "../schema/references"
import { wms } from "../schema/wms"

const instant = () => timestamp({ withTimezone: true })

export const unloadAsOf0010 = wms.table(
  "unload",
  {
    ...id,
    ...projectScoped,
    ...recorded,
    routeId: uuid().notNull(),
    /** The session, on every driver-recorded row and on no office row. */
    sessionId: uuid(),
    /** Any station of the company; the route's planned one is a default the device offers, not a rule. */
    unloadingStationId: uuid().notNull(),
    /** What was tipped; a multi-compartment vehicle records one row per fraction. */
    wasteFractionId: uuid().notNull(),
    source: text().notNull(),
    occurredAt: instant().notNull(),
    recordedBy: uuid().notNull(),
    deviceId: text(),
    location: geometry.point(),
    /** The weighbridge's two readings, together or not at all, whole kilograms. */
    grossKg: integer(),
    tareKg: integer(),
    /** What was tipped, whole kilograms: given always, and gross less tare where both are. */
    netKg: integer().notNull(),
    /** The station's reference, `WB-2026-3901`; unique nowhere, since two stations may number alike. */
    weighbridgeTicket: text(),
    /** A photo of the ticket, under the row's own ids. */
    objectKey: text(),
    note: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.routeId], route),
    projectReference(t, [t.routeId, t.sessionId], session, [session.routeId, session.id]),
    tenantReference(t, [t.unloadingStationId], unloadingStation),
    tenantReference(t, [t.wasteFractionId], wasteFraction),
    tenantReference(t, [t.recordedBy], userAccount),
    // What the weight review points at (Issue #112, migration 0010): the day something pointed at it, the way the placement got its key in 0007.
    projectKey(t),
    oneOf(t.source, EXECUTION_SOURCES),
    validGeometry(t.location),
    positive(t.grossKg),
    positive(t.tareKg),
    positive(t.netKg),
    check(tableObjectName(t.id.table, "session_shape", "unload"), sql`(${t.source} = 'driver-app') = (${t.sessionId} is not null)`),
    // The prototype's own sentence: gross and tare come together, and net is gross less tare.
    check(tableObjectName(t.id.table, "weights_shape", "unload"), sql`(${t.grossKg} is null) = (${t.tareKg} is null) and (${t.grossKg} is null or ${t.netKg} = ${t.grossKg} - ${t.tareKg})`),
    tenantIndex(t, t.routeId),
    tenantIndex(t, t.sessionId),
    tenantIndex(t, t.unloadingStationId),
    tenantIndex(t, t.wasteFractionId),
    tenantIndex(t, t.recordedBy),
    // The weights list: a project's unloads by when they happened.
    tenantIndex(t, t.projectId, t.occurredAt),
  ],
)
