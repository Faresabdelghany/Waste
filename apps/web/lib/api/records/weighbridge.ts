// Route Studio › Weighbridge on the API (O27 of #290): the tickets a station's
// weighbridge sent, `weighbridge-ticket-<uuid>` from the start
// (`@waste/contracts/weighbridge`, routes apps/api/src/routes/weighbridge.ts).
// A ticket is the weighbridge's, never the office's: no create and no patch.
// An unmatched one is matched by hand — to a route that ran and a fraction the
// station takes, the ticket then written as the route's Unload, which Weight
// Control reads again (`touches`) — or dismissed with why. The queue opens on
// what waits for the office, the whole of it, beside the window of the routes
// for the rest.
import type { WeighbridgeTicket } from "@waste/contracts/weighbridge"

import { FIXTURE_COMPANY_ID } from "@/lib/data/business-modules"
import { MASTER_DATA_KIND_DETAILS } from "@/lib/data/master-data-kinds"
import { WEIGHTS_MODULE } from "@/lib/data/provider-money"
import { TICKET_STATUS_LABELS, UNMATCHED_LABELS, WEIGHBRIDGE_MODULE, WEIGHBRIDGE_PREFIX, WEIGHBRIDGE_RECORD_KIND } from "@/lib/data/weighbridge"

import { command, get, listAll, type ApiFile } from "../client"
import { inheritedPresentation, said, stampFacts, typed, webIdOf, type ResourceAdapter, type ServerModule } from "./adapter"
import { shownOn } from "./clock"
import { referenced, refusal } from "./places"
import { nameVia, referencedServerId } from "./references"
import { routesWindowFrom } from "./routes"

export type { ApiFile }

/** The commands an unmatched ticket's details offer. */
export const MATCH_TICKET = "match"
export const DISMISS_TICKET = "dismiss"

const kilograms = (value: number) => `${new Intl.NumberFormat("en").format(value)} kg`

/** The commands a ticket's details offer: Match and Dismiss while it waits, none once it is matched or dismissed. */
export const ticketCommandsOffered = (record: { submittedValues?: Record<string, unknown> }): string[] => (record.submittedValues?.status === "unmatched" ? [MATCH_TICKET, DISMISS_TICKET] : [])

export const weighbridgeTicketAdapter: ResourceAdapter<WeighbridgeTicket> = {
  prefix: WEIGHBRIDGE_PREFIX,
  auditTable: "weighbridge_ticket",
  owns: (record) => record.id.startsWith(`${WEIGHBRIDGE_PREFIX}-`),
  // A ticket's status moves by its commands alone.
  statuses: undefined,
  // The office's queue whole, whatever its age; the rest over the routes' window.
  list: async (client) => {
    const [queue, recent] = await Promise.all([
      listAll<WeighbridgeTicket>(client, "/weighbridge-tickets", { status: "unmatched" }),
      listAll<WeighbridgeTicket>(client, "/weighbridge-tickets"),
    ])
    const since = Date.parse(`${routesWindowFrom()}T00:00:00.000Z`)
    const queued = new Set(queue.map((ticket) => ticket.id))
    return [...queue, ...recent.filter((ticket) => !queued.has(ticket.id) && Date.parse(ticket.weighedAt) >= since)]
  },
  read: (client, serverId) => get<WeighbridgeTicket>(client, `/weighbridge-tickets/${serverId}`),
  toRecord: (ticket, context) => {
    const project = ticket.projectId === null ? undefined : referenced(context, "project", ticket.projectId)
    const projectRecord = ticket.projectId === null ? undefined : context.resolve.byServerId(ticket.projectId)
    const timezone = projectRecord === undefined ? undefined : typed(projectRecord, "timezone")
    const station = nameVia(context, "station", ticket.unloadingStationId)
    const route = ticket.routeId === null ? undefined : nameVia(context, "route", ticket.routeId)
    const product = [ticket.fractionKey, ticket.wasteCode].filter((part) => part !== null).join(" · ")
    return {
      id: webIdOf(WEIGHBRIDGE_PREFIX, ticket.id),
      name: `${ticket.ticketNumber} · ${ticket.vehicleRegistration}`,
      context: `${station} · ${route ?? "No route"}`,
      status: TICKET_STATUS_LABELS[ticket.status],
      ...inheritedPresentation(undefined),
      ...stampFacts(ticket, context.now),
      value: kilograms(ticket.netKg),
      description:
        ticket.status === "unmatched" && ticket.unmatchedReason !== null
          ? `Waiting for the office: ${UNMATCHED_LABELS[ticket.unmatchedReason].toLowerCase()}.`
          : ticket.status === "dismissed"
            ? `Dismissed: ${ticket.dismissedNote ?? ""}`
            : `Written as ${route ?? "its route"}'s unload.`,
      facts: {
        Station: station,
        Ticket: ticket.ticketNumber,
        Plate: ticket.vehicleRegistration,
        ...(ticket.vehicleId === null ? {} : { Vehicle: nameVia(context, "vehicle", ticket.vehicleId) }),
        Weighed: shownOn(ticket.weighedAt, timezone),
        ...(ticket.grossKg === null ? {} : { Gross: kilograms(ticket.grossKg) }),
        ...(ticket.tareKg === null ? {} : { Tare: kilograms(ticket.tareKg) }),
        Net: kilograms(ticket.netKg),
        ...(product === "" ? {} : { Product: product }),
        ...(ticket.unmatchedReason === null ? {} : { "Waited for": UNMATCHED_LABELS[ticket.unmatchedReason] }),
        ...(route === undefined ? {} : { Route: route }),
        ...(ticket.unloadId === null ? {} : { Unload: webIdOf("unload", ticket.unloadId) }),
        ...(ticket.dismissedNote === null ? {} : { Dismissed: ticket.dismissedNote }),
      },
      related: [station, ...(route === undefined ? [] : [route])],
      allowedTransitions: [],
      companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
      projectIds: project === undefined ? [] : [project.webId],
      recordKind: WEIGHBRIDGE_RECORD_KIND,
      submittedValues: { status: ticket.status, ...(ticket.unmatchedReason === null ? {} : { unmatchedReason: ticket.unmatchedReason }), ...(ticket.unloadId === null ? {} : { unloadId: webIdOf("unload", ticket.unloadId) }) },
    }
  },
  toPatchBody: () => refusal("status", "A weighbridge ticket is the weighbridge's: match it to a route or dismiss it"),
  // Never reached: every patch is refused above, since the wire has no patch route for a ticket.
  update: () => Promise.reject(new Error("A weighbridge ticket has no patch route")),
  commands: {
    [MATCH_TICKET]: {
      toBody: (input, _record, context) => {
        const routeWebId = said(input, "routeId")
        const routeId = routeWebId === undefined ? undefined : context.resolve.serverIdOf(routeWebId)
        if (routeId === undefined) return refusal("routeId", "Pick a route the API holds")
        const fractionWebId = said(input, "wasteFractionId")
        const wasteFractionId = fractionWebId === undefined ? undefined : referencedServerId(fractionWebId, MASTER_DATA_KIND_DETAILS["waste-fraction"].prefix, context)
        if (wasteFractionId === undefined) return refusal("wasteFractionId", "Pick a waste fraction the API holds")
        return { routeId, wasteFractionId }
      },
      run: (client, serverId, body) => command<WeighbridgeTicket>(client, `/weighbridge-tickets/${serverId}/match`, body),
      refused: (record) => `${record.name} was not matched`,
      // The ticket is now its route's unload: Weight Control reads it.
      touches: [`${WEIGHTS_MODULE.workspaceId}.${WEIGHTS_MODULE.moduleId}`],
    },
    [DISMISS_TICKET]: {
      toBody: (input) => {
        const note = said(input, "note")
        return note === undefined ? refusal("note", "Say why the ticket is no route's") : { note }
      },
      run: (client, serverId, body) => command<WeighbridgeTicket>(client, `/weighbridge-tickets/${serverId}/dismiss`, body),
      refused: (record) => `${record.name} was not dismissed`,
    },
  },
}

/** Route Studio › Weighbridge: the tickets, read after the stations, the routes, the vehicles and the fractions they name. */
export const weighbridgeModule: ServerModule = { workspaceId: WEIGHBRIDGE_MODULE.workspaceId, moduleId: WEIGHBRIDGE_MODULE.moduleId, resources: [weighbridgeTicketAdapter] }
