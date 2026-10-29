// A transfer station's haul-out (M17 of #293, row 28.3): the Outbound Load,
// which takes material a Transfer Station holds on to the site that treats or
// disposes of it, with the receiving site's own ticket and the haul and
// disposal costs; and the material adjustment, the office's correction of
// what a station holds after a stock count.
//
// What a station holds is a reading and not a table (query/material-stock.ts,
// @waste/domain/execution/haul-out): by project and fraction, the Unloads
// tipped there by their weight review, less the loads sent on, plus the
// adjustments. So the Unload is never copied here, and a weight review that
// corrects an Unload moves the reading with no write of its own.
//
// An Outbound Load is a project's: whose material it is, whose currency its
// costs are in (integer minor units, as a service provider's price is, in the
// project's currency), and whose office reconciles it. The two stations are
// the company's, as every Unloading Station is; the API holds the first to a
// transfer station and the two apart, and the table holds them apart too. The
// carrier is a plate always, our vehicle where it is one, and the hauler where
// a Service Provider drives it. Its weights are an Unload's: net always, gross
// and tare together or not at all. The receiving site's ticket — its number,
// its net and when — is there exactly while the load reads received,
// reconciled or disputed (`receipt_shape`), and a dispute or a cancellation
// says why (`note_shape`). Audited under Route Studio › Weights, the module
// the Unload is read in.
//
// A material adjustment is a ledger row (sql/append-only.ts): signed kilograms
// of one fraction at one station for one project, never zero, with the count's
// words. A wrong adjustment is answered by another.
import { OUTBOUND_LOAD_STATUSES } from "@waste/domain/execution/vocabulary"
import { sql } from "drizzle-orm"
import { check, index, integer, text, timestamp, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { userAccount } from "./access"
import { wasteFraction } from "./catalogue"
import { oneOf, positive } from "./checks"
import { id, projectScoped, recorded, timestamps } from "./columns"
import { vehicle } from "./fleet"
import { company, project, serviceProvider } from "./organisation"
import { unloadingStation } from "./places"
import { companyReference, projectKey, projectReference, tenantIndex, tenantReference } from "./references"
import { wms } from "./wms"

const instant = () => timestamp({ withTimezone: true })

/** The statuses that carry the receiving site's ticket, as SQL. */
const RECEIVED = sql.raw(["received", "reconciled", "disputed"].map((status) => `'${status}'`).join(", "))

export const outboundLoad = wms.table(
  "outbound_load",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    /** The transfer station the load leaves. */
    fromStationId: uuid().notNull(),
    /** The site that takes it, usually an external plant. */
    toStationId: uuid().notNull(),
    wasteFractionId: uuid().notNull(),
    /** Our vehicle, where it is one. */
    vehicleId: uuid(),
    /** The hauler, where a Service Provider carries it. */
    serviceProviderId: uuid(),
    /** The plate, always: a hauler's truck is no vehicle of ours. */
    vehicleRegistration: text().notNull(),
    departedAt: instant().notNull(),
    /** Our out-weighing, whole kilograms: gross and tare together or not at all, net always. */
    grossKg: integer(),
    tareKg: integer(),
    netKg: integer().notNull(),
    /** Our weighbridge's reference for the out-weighing. */
    outboundTicket: text(),
    /** The receiving site's ticket number, its net and when it weighed: together, exactly while the load is received. */
    receivingTicket: text(),
    receivedNetKg: integer(),
    receivedAt: instant(),
    /** In the project's currency, integer minor units; recorded, never billed or settled. */
    haulCostMinor: integer(),
    disposalCostMinor: integer(),
    status: text().notNull(),
    /** Why a load is disputed or cancelled; a note on any other. */
    note: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    tenantReference(t, [t.fromStationId], unloadingStation),
    tenantReference(t, [t.toStationId], unloadingStation),
    tenantReference(t, [t.wasteFractionId], wasteFraction),
    projectReference(t, [t.vehicleId], vehicle),
    tenantReference(t, [t.serviceProviderId], serviceProvider),
    // What an alert about the load points at (part 2): the load of the alert's own project.
    projectKey(t),
    oneOf(t.status, OUTBOUND_LOAD_STATUSES),
    positive(t.grossKg),
    positive(t.tareKg),
    positive(t.netKg),
    positive(t.receivedNetKg),
    check(tableObjectName(t.id.table, "stations_apart", "outboundLoad"), sql`${t.fromStationId} <> ${t.toStationId}`),
    check(tableObjectName(t.id.table, "weights_shape", "outboundLoad"), sql`(${t.grossKg} is null) = (${t.tareKg} is null) and (${t.grossKg} is null or ${t.netKg} = ${t.grossKg} - ${t.tareKg})`),
    check(
      tableObjectName(t.id.table, "receipt_shape", "outboundLoad"),
      sql`(${t.status} in (${RECEIVED})) = (${t.receivingTicket} is not null) and (${t.receivingTicket} is null) = (${t.receivedNetKg} is null) and (${t.receivingTicket} is null) = (${t.receivedAt} is null)`,
    ),
    check(tableObjectName(t.id.table, "note_shape", "outboundLoad"), sql`${t.status} not in ('disputed', 'cancelled') or ${t.note} is not null`),
    check(tableObjectName(t.id.table, "costs_not_negative", "outboundLoad"), sql`(${t.haulCostMinor} is null or ${t.haulCostMinor} >= 0) and (${t.disposalCostMinor} is null or ${t.disposalCostMinor} >= 0)`),
    // What left a station of a fraction, which the stock read sums.
    index(tableObjectName(t.companyId.table, "from_station_idx", "outboundLoad")).on(t.companyId, t.fromStationId, t.wasteFractionId),
    tenantIndex(t, t.toStationId),
    tenantIndex(t, t.wasteFractionId),
    tenantIndex(t, t.vehicleId),
    tenantIndex(t, t.serviceProviderId),
    // The list: a project's loads by when they left.
    tenantIndex(t, t.projectId, t.departedAt),
  ],
)

export const materialAdjustment = wms.table(
  "material_adjustment",
  {
    ...id,
    ...projectScoped,
    ...recorded,
    unloadingStationId: uuid().notNull(),
    wasteFractionId: uuid().notNull(),
    /** Signed whole kilograms: what the count found more (positive) or less (negative) than the reading. */
    deltaKg: integer().notNull(),
    /** The count's words. */
    note: text().notNull(),
    recordedBy: uuid().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    tenantReference(t, [t.unloadingStationId], unloadingStation),
    tenantReference(t, [t.wasteFractionId], wasteFraction),
    tenantReference(t, [t.recordedBy], userAccount),
    check(tableObjectName(t.id.table, "delta_not_zero", "materialAdjustment"), sql`${t.deltaKg} <> 0`),
    // A station's adjustments of a fraction, which the stock read sums and the list reads in order.
    index(tableObjectName(t.companyId.table, "station_idx", "materialAdjustment")).on(t.companyId, t.unloadingStationId, t.wasteFractionId, t.id),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.wasteFractionId),
    tenantIndex(t, t.recordedBy),
  ],
)
