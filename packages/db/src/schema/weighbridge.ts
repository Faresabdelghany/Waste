// A weighbridge's tickets read automatically (O27 of #290, row 8.8): what the
// station's weighbridge said of one weighing — its ticket's number, the
// vehicle's plate, when, the weights and the product — kept as itself, and
// matched to the route its vehicle was out on, where it is written as that
// route's Unload (`source = integration`, the ledger's). A ticket the match
// found no route for waits for the office, with the reason, until a person
// matches it by hand or dismisses it.
//
// Not a ledger: a ticket is matched or dismissed after it arrives, and the
// row says so, the Unload it was written as being the record of the weight.
// Its project is its vehicle's, or the route's it was matched to; a ticket of
// a plate nobody knows has none, and is the company's to read. The station
// and its ticket number are unique in the company, which is how a replayed
// batch is known.
import { WEIGHBRIDGE_TICKET_STATUSES, WEIGHBRIDGE_UNMATCHED_REASONS } from "@waste/domain/execution/vocabulary"
import { sql } from "drizzle-orm"
import { check, index, integer, text, timestamp, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { oneOf, positive } from "./checks"
import { id, tenant, timestamps } from "./columns"
import { userAccount } from "./access"
import { route, unload } from "./execution"
import { vehicle } from "./fleet"
import { company, project } from "./organisation"
import { unloadingStation } from "./places"
import { companyReference, projectReference, tenantIndex, tenantReference, tenantUnique } from "./references"
import { wms } from "./wms"

const instant = () => timestamp({ withTimezone: true })

export const weighbridgeTicket = wms.table(
  "weighbridge_ticket",
  {
    ...id,
    ...tenant,
    /** The vehicle's project, or the matched route's; null where the plate is no vehicle the integration reaches. */
    projectId: uuid(),
    ...timestamps,
    unloadingStationId: uuid().notNull(),
    /** The station's own number for the ticket. */
    ticketNumber: text().notNull(),
    /** The plate as the weighbridge sent it. */
    vehicleRegistration: text().notNull(),
    /** The vehicle the plate is, where it is known; in the ticket's project. */
    vehicleId: uuid(),
    weighedAt: instant().notNull(),
    /** The weighbridge's readings, whole kilograms: gross and tare together or not at all, net always. */
    grossKg: integer(),
    tareKg: integer(),
    netKg: integer().notNull(),
    /** The product as sent: a fraction's key, a waste code, or both. */
    fractionKey: text(),
    wasteCode: text(),
    status: text().notNull(),
    /** Why the match found no route; kept once matched or dismissed, as what the ticket waited for. */
    unmatchedReason: text(),
    /** The route it was matched to and the Unload it was written as. */
    routeId: uuid(),
    unloadId: uuid(),
    /** Why the office dismissed it. */
    dismissedNote: text(),
    /** The account that sent it. */
    receivedBy: uuid().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    tenantReference(t, [t.unloadingStationId], unloadingStation),
    projectReference(t, [t.vehicleId], vehicle),
    projectReference(t, [t.routeId], route),
    projectReference(t, [t.unloadId], unload),
    tenantReference(t, [t.receivedBy], userAccount),
    // A replay is the same station's same ticket.
    tenantUnique(t, t.unloadingStationId, t.ticketNumber),
    oneOf(t.status, WEIGHBRIDGE_TICKET_STATUSES),
    oneOf(t.unmatchedReason, WEIGHBRIDGE_UNMATCHED_REASONS),
    positive(t.grossKg),
    positive(t.tareKg),
    positive(t.netKg),
    // An Unload's own sentence: gross and tare together, and net gross less tare.
    check(tableObjectName(t.id.table, "weights_shape", "weighbridgeTicket"), sql`(${t.grossKg} is null) = (${t.tareKg} is null) and (${t.grossKg} is null or ${t.netKg} = ${t.grossKg} - ${t.tareKg})`),
    // Matched is a route and its Unload in a project; dismissed says why; unmatched says what it waits for.
    check(
      tableObjectName(t.id.table, "status_shape", "weighbridgeTicket"),
      sql`(${t.status} = 'matched') = (${t.routeId} is not null and ${t.unloadId} is not null and ${t.projectId} is not null) and (${t.status} = 'dismissed') = (${t.dismissedNote} is not null) and (${t.status} <> 'unmatched' or ${t.unmatchedReason} is not null)`,
    ),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.vehicleId),
    tenantIndex(t, t.routeId),
    tenantIndex(t, t.unloadId),
    tenantIndex(t, t.receivedBy),
    // The office's queue: a status's tickets in arrival order.
    index(tableObjectName(t.companyId.table, "status_idx", "weighbridgeTicket")).on(t.companyId, t.status, t.id),
  ],
)
