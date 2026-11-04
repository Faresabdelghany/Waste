// Route Messages (O24 of #290): the office and the route's driver writing to
// each other about one route, the thread of the route itself — read by the
// office in the route's details and by the driver on the route's screen.
//
// `route_message` is a ledger: a message is written once and never edited or
// taken back, so it spreads `recorded` and `wms_api` may not update or delete
// it. Who wrote it is its `author`: the office's names the user account that
// sent it, the driver's names the driver profile and its login's account
// (`route_message_author_shape`). The driver sends under an id their device
// mints, so a send tried again over a lost answer meets the primary key and is
// answered as the message already written (the API's `replayed`). The body is
// plain text, bounded by the contracts. Its index leads with the route and
// the id, the order a thread is read in.
import { ROUTE_MESSAGE_AUTHORS } from "@waste/domain/execution/vocabulary"
import { sql } from "drizzle-orm"
import { check, index, text, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { userAccount } from "./access"
import { oneOf } from "./checks"
import { id, projectScoped, recorded } from "./columns"
import { route } from "./execution"
import { driver } from "./fleet"
import { company, project } from "./organisation"
import { companyReference, projectReference, tenantIndex, tenantReference } from "./references"
import { wms } from "./wms"

export const routeMessage = wms.table(
  "route_message",
  {
    ...id,
    ...projectScoped,
    ...recorded,
    routeId: uuid().notNull(),
    author: text().notNull(),
    /** The account that sent it: the office's person, or the driver's login. */
    sentBy: uuid().notNull(),
    /** The driver profile that wrote it; null for the office's. */
    driverId: uuid(),
    body: text().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.routeId], route),
    projectReference(t, [t.driverId], driver),
    tenantReference(t, [t.sentBy], userAccount),
    oneOf(t.author, ROUTE_MESSAGE_AUTHORS),
    check(tableObjectName(t.id.table, "author_shape", "routeMessage"), sql`(${t.author} = 'driver') = (${t.driverId} is not null)`),
    // A route's thread in the order it was written.
    index(tableObjectName(t.companyId.table, "route_id_idx", "routeMessage")).on(t.companyId, t.routeId, t.id),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.driverId),
    tenantIndex(t, t.sentBy),
  ],
)
