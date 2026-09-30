// Pickups on the prototype's records (Issue #179, slice 6 of #81): a route's
// stops, as the rows of `route-studio.pickups` — the Pickups table reads
// them, the route's details list them in their sequence, and the map draws a
// route through them. The wire shapes are the contracts'
// (`@waste/contracts/pickups`), imported as types so no zod reaches the
// bundle; the routes are apps/api/src/routes/pickups.ts.
//
// A pickup is never created or edited here: generation writes it, the
// driver's device decides it, and the dispatcher has two commands on it —
// `remove` takes a stop off a route that has not started, saying why
// (`planned → skipped · removed-by-dispatcher`), and `correct-outcome` is the
// audited correction after the fact, which appends a correction proof. So
// the adapter lists no `statuses` and refuses every patch; which command a
// stop may take is the API's to say, and its 409 speaks.
//
// Relations by web id through the store's resolver: the route (loaded just
// before, so a stop reads its label, its scheme and its dates), the
// container (5b's, by its label) and the fraction (the master data), each an
// id chip where its module has not loaded. The office pickup carries no
// place: the map puts a stop where its container stands — on the Pilot where
// its placement in force delivers (#184) — linking the two by the container's
// id and by its label (`Container ID`), which the stop carries as a fact. The
// time a stop was decided is shown on its project's clock.
import type { Pickup, PickupDetail } from "@waste/contracts/pickups"
import type { ProofOfService } from "@waste/contracts/proofs"
import { PICKUP_OUTCOMES, PICKUP_REASONS } from "@waste/domain/execution/vocabulary"

import { FIXTURE_COMPANY_ID, type BusinessRecord, type ModuleLocation } from "@/lib/data/business-modules"

import { command, get, listAll } from "../client"
import { inheritedPresentation, moduleKeyOf, ofKind, said, stampFacts, statusLabel, typed, webIdOf, type Client, type MappingContext, type RecordCommand, type ResourceAdapter, type ServerModule } from "./adapter"
import { wallClockIn } from "./clock"
import { LIVE_MODULE } from "./live"
import { referenced, refusal } from "./places"
import { webIdVia } from "./references"
import { ROUTES_MODULE, routesWindowFrom } from "./routes"

/** The workspace module the pickups are the rows of. */
export const PICKUPS_MODULE: ModuleLocation = { workspaceId: "route-studio", moduleId: "pickups" }

/** The stop's commands, by the names the surfaces send. */
export const REMOVE_PICKUP = "remove"
export const CORRECT_PICKUP = "correct"

/** The sentence the contract refuses a reason with a completion, or none with a miss, in (`REASON_WITH_A_MISS`, @waste/contracts/pickups), quoted since the web imports no zod at runtime; the test holds the two equal. */
export const REASON_WITH_A_MISS = "Give a reason with skipped or failed, and none with completed"

const PICKUP_PREFIX = "pickup"

/** "06:15": when an instant was, on the project's clock. */
const clockOn = (instant: string, timezone: string | undefined) => wallClockIn(instant, timezone).slice(11, 16)

export function toPickupRecord(pickup: Pickup, context: MappingContext): BusinessRecord {
  const project = referenced(context, "project", pickup.projectId)
  const projectRecord = context.resolve.byServerId(pickup.projectId)
  const timezone = projectRecord === undefined ? undefined : typed(projectRecord, "timezone")
  const route = context.resolve.byServerId(pickup.routeId)
  const routeWebId = webIdVia(context, "route", pickup.routeId)
  const container = referenced(context, "asset", pickup.containerId)
  const containerRecord = context.resolve.byServerId(pickup.containerId)
  const fraction = referenced(context, "fraction", pickup.wasteFractionId)
  const stop = pickup.sequence ?? pickup.position
  const status = statusLabel(pickup.status)
  const facts: Record<string, string> = {
    Route: route?.name ?? routeWebId,
    Stop: String(stop),
    Type: "Collection",
    "Waste fraction": fraction.name ?? fraction.webId,
    Project: project.name ?? project.webId,
  }
  // The label a fixture container is linked by on the map; a container the store has not loaded has none to give.
  const label = containerRecord?.facts["Container ID"] ?? containerRecord?.name
  if (label !== undefined) facts["Container ID"] = label
  if (pickup.arrivedAt !== null) facts["Arrived at"] = clockOn(pickup.arrivedAt, timezone)
  if (pickup.status === "completed" && pickup.outcomeAt !== null) facts["Completed at"] = clockOn(pickup.outcomeAt, timezone)
  if (pickup.reason !== null) facts.Reason = statusLabel(pickup.reason)
  if (pickup.note !== null) facts.Note = pickup.note
  const onRoute = (key: string) => {
    const value = route === undefined ? undefined : typed(route, key)
    return value === undefined ? {} : { [key]: value }
  }
  return {
    id: webIdOf(PICKUP_PREFIX, pickup.id),
    name: `Stop ${stop} · ${label ?? container.webId}`,
    context: [route?.name ?? routeWebId, fraction.name ?? fraction.webId].join(" · "),
    status,
    ...inheritedPresentation(undefined),
    ...stampFacts(pickup, context.now),
    value: pickup.status === "planned" || pickup.outcomeAt === null ? status : `${clockOn(pickup.outcomeAt, timezone)} · ${status}`,
    description: "A stop of a dated route: generation wrote it, the driver decides it, the dispatcher may remove it or correct its outcome.",
    facts,
    deepLink: `/route-studio?module=routes&record=${routeWebId}`,
    companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
    projectIds: [project.webId],
    recordKind: "Pickup",
    submittedValues: {
      routeId: routeWebId,
      containerId: container.webId,
      wasteFractionId: fraction.webId,
      position: String(pickup.position),
      ...(pickup.sequence === undefined ? {} : { sequence: String(pickup.sequence) }),
      ...onRoute("schemeId"),
      ...onRoute("serviceDate"),
      ...onRoute("operatingDate"),
      status: pickup.status,
      ...(pickup.reason === null ? {} : { reason: pickup.reason }),
    },
  }
}

// ---------------------------------------------------------------------------
// The dispatcher's commands on a stop
// ---------------------------------------------------------------------------

/** A command posted to its path on the stop, which answers the stop with its proofs. A stop removed or corrected moves its route's progress, on the Routes table and the Live board. */
const onPickup = (path: string, verb: string, toBody: NonNullable<RecordCommand<Pickup>["toBody"]>): RecordCommand<Pickup> => ({
  toBody,
  run: (client, serverId, body) => command<PickupDetail>(client, `/pickups/${serverId}/${path}`, body),
  refused: (record) => `${record.name} was not ${verb}`,
  touches: [moduleKeyOf(ROUTES_MODULE.workspaceId, ROUTES_MODULE.moduleId), moduleKeyOf(LIVE_MODULE.workspaceId, LIVE_MODULE.moduleId)],
})

const isOneOf = <T extends string>(words: readonly T[], value: string): value is T => (words as readonly string[]).includes(value)

export const PICKUP_COMMANDS = {
  [REMOVE_PICKUP]: onPickup("remove", "removed", (input) => {
    const reason = said(input, "reason")
    return reason === undefined ? refusal("reason", "Say why the stop is removed") : { reason }
  }),
  [CORRECT_PICKUP]: onPickup("correct-outcome", "corrected", (input) => {
    const outcome = said(input, "outcome")
    if (outcome === undefined || !isOneOf(PICKUP_OUTCOMES, outcome)) return refusal("outcome", "Pick the outcome: completed, skipped or failed")
    const reason = said(input, "reason")
    if ((outcome === "completed") !== (reason === undefined)) return refusal("reason", REASON_WITH_A_MISS)
    if (reason !== undefined && !isOneOf(PICKUP_REASONS, reason)) return refusal("reason", "Pick a reason the API knows")
    const note = said(input, "note")
    if (note === undefined) return refusal("note", "Say why the outcome is corrected")
    // A completion names no reason at all: the contract takes the key's absence, never a null.
    return reason === undefined ? { outcome, note } : { outcome, reason, note }
  }),
} satisfies Record<string, RecordCommand<Pickup>>

/** A stop's proofs, in recording order: its own read. */
export async function pickupProofs(client: Client, serverId: string): Promise<ProofOfService[]> {
  return (await get<PickupDetail>(client, `/pickups/${serverId}`)).proofs
}

const CHANGED_BY_COMMANDS = "A pickup is changed by its commands: remove it from a route that has not started, or correct its outcome"

export const pickupAdapter: ResourceAdapter<Pickup> = {
  prefix: PICKUP_PREFIX,
  owns: ofKind(PICKUP_PREFIX, ["Pickup"]),
  // Planned, completed, skipped and failed move by the driver's device and the dispatcher's commands alone.
  statuses: undefined,
  // The routes' window (routes.ts): a stop is read with its route.
  list: (client) => listAll<Pickup>(client, "/pickups", { from: routesWindowFrom() }),
  toRecord: toPickupRecord,
  toPatchBody: () => refusal("", CHANGED_BY_COMMANDS),
  update: () => Promise.reject(new Error(CHANGED_BY_COMMANDS)),
  commands: PICKUP_COMMANDS,
}

/** Route Studio › Pickups: every route's stops, after the routes and the containers they name. */
export const pickupsModule: ServerModule = {
  workspaceId: PICKUPS_MODULE.workspaceId,
  moduleId: PICKUPS_MODULE.moduleId,
  resources: [pickupAdapter],
}

export type { Client }
