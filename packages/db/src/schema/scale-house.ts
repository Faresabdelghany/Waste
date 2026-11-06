// The scale house (M16a of #293, #404): the tare register and the tickets
// weighed at the window of one of our own sites.
//
// `vehicle_tare` is a vehicle's weight empty, per project: by its plate and,
// where it is weighed with them, its trailer's plate and the container it
// carries, each keyed as the match reads a plate (upper case, letters and
// digits alone, `key_shape`). One active tare per plate, trailer and
// container; a re-weighing changes the row, which the audit trail keeps, and
// a retired one stays for the tickets completed on it.
//
// `scale_ticket` is the window's ticket: weighed in at its gross, for an
// account customer under one of its agreements or a walk-in (`party_shape`),
// and completed at its tare — a second pass or the register's — with its net
// the difference (`completed_shape`), or voided with its reason, never
// deleted, since it is what the customer was handed (`void_shape`). Numbered
// in the company's series. One of our own vehicles' ticket, matched to the
// route it ran, is also that route's Unload, whose id it keeps; one that found
// no route keeps why (`match_shape`).
//
// `scale_ticket_line` is the ledger of a completed ticket's split: a fraction,
// the municipality it came from, and its net, the lines summing to the
// ticket's (which the API holds, as it writes both in one transaction).
// Material in from outside customers is the lines of completed tickets with
// no Unload (#405).
import { WEIGHBRIDGE_UNMATCHED_REASONS } from "@waste/domain/execution/vocabulary"
import { FOUR_DIGITS_PATTERN } from "@waste/domain/registry/address"
import { SCALE_TICKET_PARTIES, SCALE_TICKET_STATUSES, SCALE_TICKET_VOID_REASONS, TARE_SOURCES, VEHICLE_TARE_STATUSES } from "@waste/domain/scale-house/vocabulary"
import { sql } from "drizzle-orm"
import { check, date, index, integer, text, timestamp, uniqueIndex, uuid, type PgColumn } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { userAccount } from "./access"
import { agreement } from "./agreements"
import { product, wasteFraction } from "./catalogue"
import { oneOf, positive } from "./checks"
import { id, projectScoped, recorded, timestamps } from "./columns"
import { customer } from "./customers"
import { route, unload } from "./execution"
import { vehicle } from "./fleet"
import { company, project } from "./organisation"
import { unloadingStation } from "./places"
import { policies } from "./policies"
import { companyReference, projectKey, projectReference, tenantIndex, tenantReference, tenantUnique } from "./references"
import { wms } from "./wms"

const instant = () => timestamp({ withTimezone: true })

/** A plate or a reference as the register keys it: something, upper case, no space and no punctuation. */
const keyShaped = (column: PgColumn) => sql`(${column} <> '' and ${column} = upper(${column}) and ${column} !~ '[[:space:][:punct:]]')`

export const vehicleTare = wms.table(
  "vehicle_tare",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    plate: text().notNull(),
    trailerPlate: text(),
    containerRef: text(),
    tareKg: integer().notNull(),
    /** The day it was weighed empty. */
    weighedOn: date().notNull(),
    /** The haulier it belongs to, where the office names one. */
    customerId: uuid(),
    label: text(),
    status: text().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    tenantReference(t, [t.customerId], customer),
    projectKey(t),
    oneOf(t.status, VEHICLE_TARE_STATUSES),
    positive(t.tareKg),
    check(
      tableObjectName(t.id.table, "key_shape", "vehicleTare"),
      sql`${keyShaped(t.plate)} and (${t.trailerPlate} is null or ${keyShaped(t.trailerPlate)}) and (${t.containerRef} is null or ${keyShaped(t.containerRef)})`,
    ),
    // One active tare per plate, trailer and container in a project; none of them is a value of its own, which the empty key (never a key's shape) stands for.
    uniqueIndex(tableObjectName(t.companyId.table, "active_key", "vehicleTare"))
      .on(t.companyId, t.projectId, t.plate, sql`coalesce(${t.trailerPlate}, '')`, sql`coalesce(${t.containerRef}, '')`)
      .where(sql`${t.status} = 'active'`),
    tenantIndex(t, t.customerId),
  ],
)

export const vehicleTarePolicies = policies(vehicleTare, { audited: {} })

export const scaleTicket = wms.table(
  "scale_ticket",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    /** The company's series, what the customer is handed. */
    number: integer().notNull(),
    /** One of our own stations with a weighbridge, which the API holds. */
    unloadingStationId: uuid().notNull(),
    vehiclePlate: text().notNull(),
    trailerPlate: text(),
    containerRef: text(),
    /** One of our own vehicles, where the plate is one. */
    vehicleId: uuid(),
    party: text().notNull(),
    customerId: uuid(),
    agreementId: uuid(),
    visitorName: text(),
    grossKg: integer().notNull(),
    weighedInAt: instant().notNull(),
    tareKg: integer(),
    tareSource: text(),
    vehicleTareId: uuid(),
    weighedOutAt: instant(),
    netKg: integer(),
    status: text().notNull(),
    routeId: uuid(),
    unloadId: uuid(),
    unmatchedReason: text(),
    voidReason: text(),
    voidNote: text(),
    voidedAt: instant(),
    voidedBy: uuid(),
    note: text(),
    recordedBy: uuid().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    tenantReference(t, [t.unloadingStationId], unloadingStation),
    projectReference(t, [t.vehicleId], vehicle),
    tenantReference(t, [t.customerId], customer),
    projectReference(t, [t.agreementId], agreement),
    projectReference(t, [t.vehicleTareId], vehicleTare),
    projectReference(t, [t.routeId], route),
    projectReference(t, [t.unloadId], unload),
    tenantReference(t, [t.recordedBy], userAccount),
    tenantReference(t, [t.voidedBy], userAccount),
    projectKey(t),
    tenantUnique(t, t.number),
    oneOf(t.party, SCALE_TICKET_PARTIES),
    oneOf(t.status, SCALE_TICKET_STATUSES),
    oneOf(t.tareSource, TARE_SOURCES),
    oneOf(t.voidReason, SCALE_TICKET_VOID_REASONS),
    oneOf(t.unmatchedReason, WEIGHBRIDGE_UNMATCHED_REASONS),
    positive(t.grossKg),
    positive(t.tareKg),
    positive(t.netKg),
    // An account's customer and agreement, a walk-in's neither.
    check(
      tableObjectName(t.id.table, "party_shape", "scaleTicket"),
      sql`case when ${t.party} = 'account' then ${t.customerId} is not null and ${t.agreementId} is not null else ${t.customerId} is null and ${t.agreementId} is null end`,
    ),
    // The second weighing is all or nothing, the net the gross less the tare, the register's tare named exactly when it was used; an open ticket has none, a completed one has it.
    check(
      tableObjectName(t.id.table, "weighing_shape", "scaleTicket"),
      sql`(${t.tareKg} is null) = (${t.tareSource} is null) and (${t.tareKg} is null) = (${t.weighedOutAt} is null) and (${t.tareKg} is null) = (${t.netKg} is null) and (${t.netKg} is null or ${t.netKg} = ${t.grossKg} - ${t.tareKg}) and (${t.tareSource} is not distinct from 'registered') = (${t.vehicleTareId} is not null) and (${t.status} <> 'open' or ${t.tareKg} is null) and (${t.status} <> 'completed' or ${t.tareKg} is not null)`,
    ),
    // Voided says when, by whom and why; nothing else is.
    check(tableObjectName(t.id.table, "void_shape", "scaleTicket"), sql`(${t.status} = 'voided') = (${t.voidReason} is not null) and (${t.voidReason} is null) = (${t.voidedAt} is null) and (${t.voidReason} is null) = (${t.voidedBy} is null) and (${t.voidReason} <> 'other' or ${t.voidNote} is not null)`),
    // Our own vehicle's completed ticket is a route's Unload, or says why it is none; any other ticket is neither.
    check(
      tableObjectName(t.id.table, "match_shape", "scaleTicket"),
      sql`(${t.routeId} is null) = (${t.unloadId} is null) and (${t.unloadId} is null or (${t.vehicleId} is not null and ${t.tareKg} is not null)) and (${t.unmatchedReason} is null or (${t.vehicleId} is not null and ${t.tareKg} is not null and ${t.unloadId} is null))`,
    ),
    tenantIndex(t, t.vehicleId),
    tenantIndex(t, t.customerId),
    tenantIndex(t, t.agreementId),
    tenantIndex(t, t.vehicleTareId),
    tenantIndex(t, t.routeId),
    tenantIndex(t, t.unloadId),
    tenantIndex(t, t.recordedBy),
    tenantIndex(t, t.voidedBy),
    // A site's tickets of a standing, newest last: the window's queue and M17's material in, and the station reference's index.
    index(tableObjectName(t.companyId.table, "station_status_idx", "scaleTicket")).on(t.companyId, t.unloadingStationId, t.status, t.weighedOutAt),
  ],
)

export const scaleTicketPolicies = policies(scaleTicket, { audited: {} })

export const scaleTicketLine = wms.table(
  "scale_ticket_line",
  {
    ...id,
    ...projectScoped,
    ...recorded,
    ticketId: uuid().notNull(),
    position: integer().notNull(),
    wasteFractionId: uuid().notNull(),
    /** The kommunekode it came from, four digits as a Property spells it. */
    originMunicipality: text(),
    netKg: integer().notNull(),
    /** The window's product the line is sold by (M16b of #293), per tonne or per cubic metre; null where the window named none, which a walk-in's ticket may leave. */
    productId: uuid(),
    /** The declared volume of a line sold by the cubic metre, whole litres. */
    volumeLitres: integer(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.ticketId], scaleTicket),
    projectReference(t, [t.productId], product),
    // The project key a billable event's charge of the line references (M16b of #293).
    projectKey(t),
    tenantReference(t, [t.wasteFractionId], wasteFraction),
    // Leads with the ticket, so it is the reference's index and a ticket's lines in order.
    tenantUnique(t, t.ticketId, t.position),
    positive(t.position),
    positive(t.netKg),
    positive(t.volumeLitres),
    check(tableObjectName(t.id.table, "origin_shape", "scaleTicketLine"), sql`${t.originMunicipality} ~ ${sql.raw(`'${FOUR_DIGITS_PATTERN}'`)}`),
    tenantIndex(t, t.wasteFractionId),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.productId),
  ],
)

export const scaleTicketLinePolicies = policies(scaleTicketLine, {
  exempt: "a ledger of a completed ticket's split, written once with the completion its ticket's trail records; a voided ticket voids its lines with it",
})
