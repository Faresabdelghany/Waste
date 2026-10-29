// Weight review on the prototype's records (Issue #186, slice 11 of #81, for
// #148; last and cuttable): the unloads a route's driver recorded at a station
// (`@waste/contracts/unloads`, routes apps/api/src/routes/unloads.ts) as
// `route-studio.weights`, read with their review status — `captured` is the
// weights desk's queue, "Needs review" — and moved by the three reviews of
// weight control (`weight-control.ts`): approve, reject with the note that
// says why, and correct with the new weights, which the API writes as a new
// unload. Each review answers the review it appended, never the unload, so a
// command reads the unload back for the row; a correction's new unload joins
// the module, which is read again (`touches`). The load and disposal
// reconciliation copy the prototype carried drops. Nothing else changes on an
// unload: every patch is refused.
//
// The weighbridge in the office (O9 of #290): Record unload is the module's
// create, `POST /routes/:id/unloads` on a route that ran, the time on the
// route's project's clock, with the station's refusal where it turned the
// load away. A row says why it was refused, and reads its load on board
// against the net — the difference, and the project's tolerance as
// `Within tolerance`, `Above tolerance` or `Not measured`, the Tolerance
// filter's values.
//
// Two sentences of the contract's own rules are spelled again here (the web
// imports the contracts as types only) and held equal by the test.
//
// Ids, rule (b) of #81's plan: `unload-<uuid>`; no fixture lends its id.
import type { LoadReading, Unload } from "@waste/contracts/unloads"
import type { UnloadRefusalReason } from "@waste/domain/execution/vocabulary"
import { weightReviewTransition } from "@waste/domain/finance/transitions"
import { WEIGHT_REVIEW_STATUSES, type WeightReviewDecision, type WeightReviewStatus } from "@waste/domain/finance/vocabulary"

import { FIXTURE_COMPANY_ID } from "@/lib/data/business-modules"
import { MASTER_DATA_KIND_DETAILS } from "@/lib/data/master-data-kinds"
import { isUnloadRecord, UNLOAD_PREFIX, UNLOAD_RECORD_KIND, WEIGHTS_MODULE } from "@/lib/data/provider-money"
import { REFUSAL_LABELS, SAY_WHY_REFUSED } from "@/lib/data/unload-refusals"

import { command, create, get, listAll } from "../client"
import { inheritedPresentation, said, stampFacts, typed, webIdOf, type Client, type CommandInput, type ResourceAdapter, type ServerModule } from "./adapter"
import { instantOn, projectTimezoneOf, shownOn } from "./clock"
import { referenced, refusal } from "./places"
import { nameVia, referencedServerId } from "./references"
import { routesWindowFrom } from "./routes"

/** A review status as the desk reads it: `captured` is the queue. */
export const REVIEW_LABELS: Readonly<Record<WeightReviewStatus, string>> = { captured: "Needs review", approved: "Approved", rejected: "Rejected", corrected: "Corrected" }
/** What a correction giving one of gross and tare is told (`@waste/contracts/unloads`, `BOTH_GROSS_AND_TARE`). */
export const BOTH_GROSS_AND_TARE = "Give grossKg and tareKg together or neither"
/** What a correction whose net is not gross less tare is told (`NET_IS_GROSS_LESS_TARE`). */
export const NET_IS_GROSS_LESS_TARE = "netKg is grossKg less tareKg where both are given"
const KILOGRAMS = "A weight is a whole number of kilograms, 1 or more"
export { REFUSAL_LABELS, SAY_WHY_REFUSED }

/** What an unload's load on board reads as against the project's tolerance: the Tolerance filter's values. */
export const TOLERANCE_LABELS = { within: "Within tolerance", above: "Above tolerance", unmeasured: "Not measured" } as const

/** An unload's reading against its project's tolerance; not measured where no stop of its fraction was weighed. */
export const toleranceOf = (load: LoadReading | null): string => (load === null ? TOLERANCE_LABELS.unmeasured : load.withinTolerance ? TOLERANCE_LABELS.within : TOLERANCE_LABELS.above)

/** The weighbridge's net against what was weighed on board, signed: `+7.7%`, `-2.0%`, `0.0%`. */
export const differenceOf = (load: LoadReading): string => `${load.deviationPercent > 0 ? "+" : ""}${load.deviationPercent.toFixed(1)}%`

/** The reviews, by the command each is sent as, and the decision each records. */
export const WEIGHT_REVIEW_COMMANDS = ["approve", "reject", "correct"] as const
export type WeightReviewCommand = (typeof WEIGHT_REVIEW_COMMANDS)[number]
const DECISION: Readonly<Record<WeightReviewCommand, WeightReviewDecision>> = { approve: "approved", reject: "rejected", correct: "corrected" }

/** The reviews an unload's details offer: those the machine moves it by from its status, never the decision it holds; a corrected one none, its correction being the row to review. */
export function weightReviewsOffered(record: { submittedValues?: Record<string, unknown> }): WeightReviewCommand[] {
  const status = WEIGHT_REVIEW_STATUSES.find((candidate) => candidate === record.submittedValues?.reviewStatus)
  if (status === undefined) return []
  return WEIGHT_REVIEW_COMMANDS.filter((name) => weightReviewTransition(status, DECISION[name], null).kind === "move")
}

/** An unload as a resource: a ledger row stamped with its `recordedAt` as both of a resource's stamps. */
export type UnloadResource = Unload & { createdAt: string; updatedAt: string }
const stamped = (unload: Unload): UnloadResource => ({ ...unload, createdAt: unload.recordedAt, updatedAt: unload.recordedAt })

/** Whole kilograms as a person reads them: 8,240 kg; the weights list and a weight charge (O28 of #290) both spell them so. */
export const kilograms = (value: number) => `${new Intl.NumberFormat("en").format(value)} kg`

/** A form's weight: undefined for blank, the whole kilograms of one, NaN for anything else. */
function weightOf(input: CommandInput, key: string): number | undefined {
  const text = said(input, key)
  if (text === undefined) return undefined
  const number = Number(text)
  return Number.isInteger(number) && number > 0 ? number : Number.NaN
}

/** A review, then the unload read back: the review answers itself, the row is the unload's. */
const reviewThenRead = (verb: "approve" | "reject" | "correct") => (client: Client, serverId: string, body: unknown) =>
  command<unknown>(client, `/unloads/${serverId}/${verb}`, body).then(() => get<Unload>(client, `/unloads/${serverId}`).then(stamped))

export const unloadAdapter: ResourceAdapter<UnloadResource> = {
  prefix: UNLOAD_PREFIX,
  owns: isUnloadRecord,
  // The review status is a reading, moved by the reviews alone.
  statuses: undefined,
  // The desk's queue whole, whatever its age; the reviewed over the routes' window, so the ledger is never read whole.
  list: async (client) => {
    const [queue, recent] = await Promise.all([listAll<Unload>(client, "/unloads", { reviewStatus: "captured" }), listAll<Unload>(client, "/unloads", { from: `${routesWindowFrom()}T00:00:00.000Z` })])
    const queued = new Set(queue.map((unload) => unload.id))
    return [...queue, ...recent.filter((unload) => !queued.has(unload.id))].map(stamped)
  },
  read: (client, serverId) => get<Unload>(client, `/unloads/${serverId}`).then(stamped),
  toRecord: (unload, context) => {
    const project = referenced(context, "project", unload.projectId)
    const projectRecord = context.resolve.byServerId(unload.projectId)
    const timezone = projectRecord === undefined ? undefined : typed(projectRecord, "timezone")
    const route = nameVia(context, "route", unload.routeId)
    const station = nameVia(context, "station", unload.unloadingStationId)
    const fraction = nameVia(context, MASTER_DATA_KIND_DETAILS["waste-fraction"].prefix, unload.wasteFractionId)
    const correction = unload.weightReview.correctionUnloadId
    const { refusal, load } = unload
    return {
      id: webIdOf(UNLOAD_PREFIX, unload.id),
      name: unload.weighbridgeTicket === null ? `${fraction} at ${station}` : `${unload.weighbridgeTicket} · ${fraction}`,
      context: `${route} · ${station}`,
      status: REVIEW_LABELS[unload.weightReview.status],
      ...inheritedPresentation(undefined),
      ...stampFacts(unload, context.now),
      value: kilograms(unload.netKg),
      description: refusal === null ? `${fraction} unloaded at ${station} off ${route}.` : `${fraction} refused at ${station} off ${route}: ${REFUSAL_LABELS[refusal.reason].toLowerCase()}.`,
      facts: {
        Route: route,
        Station: station,
        "Waste fraction": fraction,
        ...(unload.grossKg === null ? {} : { Gross: kilograms(unload.grossKg) }),
        ...(unload.tareKg === null ? {} : { Tare: kilograms(unload.tareKg) }),
        Net: kilograms(unload.netKg),
        ...(load === null ? {} : { "On board": kilograms(load.onBoardKg), Difference: differenceOf(load) }),
        Tolerance: toleranceOf(load),
        ...(refusal === null ? {} : { Refused: refusal.note === null ? REFUSAL_LABELS[refusal.reason] : `${REFUSAL_LABELS[refusal.reason]}: ${refusal.note}` }),
        ...(unload.weighbridgeTicket === null ? {} : { Ticket: unload.weighbridgeTicket }),
        Occurred: shownOn(unload.occurredAt, timezone),
        Source: unload.source === "driver-app" ? "Driver App" : unload.source === "dispatch" ? "The office" : "An integration",
        ...(unload.note === null ? {} : { Note: unload.note }),
        ...(correction === null ? {} : { "Corrected by": webIdOf(UNLOAD_PREFIX, correction) }),
      },
      related: [route, station],
      allowedTransitions: [],
      companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
      projectIds: [project.webId],
      recordKind: UNLOAD_RECORD_KIND,
      submittedValues: { routeId: webIdOf("route", unload.routeId), reviewStatus: unload.weightReview.status, tolerance: toleranceOf(load), ...(refusal === null ? {} : { refusalReason: refusal.reason }), netKg: String(unload.netKg), ...(unload.grossKg === null ? {} : { grossKg: String(unload.grossKg) }), ...(unload.tareKg === null ? {} : { tareKg: String(unload.tareKg) }) },
    }
  },
  // Record unload: the route's own path, so the route rides beside the body and is taken off it on the way.
  toCreateBody: (record, context) => {
    const routeWebId = typed(record, "routeId")
    const routeId = routeWebId === undefined ? undefined : context.resolve.serverIdOf(routeWebId)
    const route = routeId === undefined ? undefined : context.resolve.byServerId(routeId)
    if (routeId === undefined || route === undefined) return refusal("routeId", "Pick a route the API holds")
    const stationWebId = typed(record, "unloadingStationId")
    const unloadingStationId = stationWebId === undefined ? undefined : context.resolve.serverIdOf(stationWebId)
    if (unloadingStationId === undefined) return refusal("unloadingStationId", "Pick an unloading station the API holds")
    const fractionWebId = typed(record, "wasteFractionId")
    const wasteFractionId = fractionWebId === undefined ? undefined : referencedServerId(fractionWebId, MASTER_DATA_KIND_DETAILS["waste-fraction"].prefix, context)
    if (wasteFractionId === undefined) return refusal("wasteFractionId", "Pick a waste fraction the API holds")
    const values: CommandInput = record.submittedValues ?? {}
    const netKg = weightOf(values, "netKg")
    if (netKg === undefined || Number.isNaN(netKg)) return refusal("netKg", KILOGRAMS)
    const grossKg = weightOf(values, "grossKg")
    if (Number.isNaN(grossKg)) return refusal("grossKg", KILOGRAMS)
    const tareKg = weightOf(values, "tareKg")
    if (Number.isNaN(tareKg)) return refusal("tareKg", KILOGRAMS)
    if ((grossKg === undefined) !== (tareKg === undefined)) return refusal("tareKg", BOTH_GROSS_AND_TARE)
    if (grossKg !== undefined && tareKg !== undefined && netKg !== grossKg - tareKg) return refusal("netKg", NET_IS_GROSS_LESS_TARE)
    const tipped = said(values, "occurredAt")
    const occurredAt = tipped === undefined ? undefined : instantOn(tipped, projectTimezoneOf(route, context))
    if (occurredAt === undefined) return refusal("occurredAt", "Say when the truck tipped")
    const reason = said(values, "refusalReason") as UnloadRefusalReason | undefined
    const refusalNote = said(values, "refusalNote")
    if (reason === undefined && refusalNote !== undefined) return refusal("refusalReason", "Say why the station refused the load, or leave its words blank")
    if (reason === "other" && refusalNote === undefined) return refusal("refusalNote", SAY_WHY_REFUSED)
    const ticket = said(values, "weighbridgeTicket")
    const note = said(values, "note")
    return {
      routeId,
      body: {
        unloadingStationId,
        wasteFractionId,
        netKg,
        ...(grossKg === undefined ? {} : { grossKg, tareKg }),
        ...(ticket === undefined ? {} : { weighbridgeTicket: ticket }),
        occurredAt,
        ...(note === undefined ? {} : { note }),
        ...(reason === undefined ? {} : { refusal: { reason, ...(refusalNote === undefined ? {} : { note: refusalNote }) } }),
      },
    }
  },
  create: (client, posted) => {
    const { routeId, body } = posted as { routeId: string; body: unknown }
    return create<Unload>(client, `/routes/${routeId}/unloads`, body).then((created) => stamped(created.body))
  },
  toPatchBody: () => refusal("status", "An unload is reviewed, never edited: approve it, reject it, or correct it"),
  // Never reached: every patch is refused above, since the wire has no patch route for an unload.
  update: () => Promise.reject(new Error("An unload has no patch route")),
  commands: {
    approve: {
      toBody: (input) => {
        const note = said(input, "note")
        return note === undefined ? {} : { note }
      },
      run: reviewThenRead("approve"),
      refused: (record) => `${record.name} was not approved`,
    },
    reject: {
      toBody: (input) => {
        const note = said(input, "note")
        return note === undefined ? refusal("note", "Say why the weight is rejected") : { note }
      },
      run: reviewThenRead("reject"),
      refused: (record) => `${record.name} was not rejected`,
    },
    correct: {
      toBody: (input) => {
        const netKg = weightOf(input, "netKg")
        if (netKg === undefined || Number.isNaN(netKg)) return refusal("netKg", KILOGRAMS)
        const grossKg = weightOf(input, "grossKg")
        if (Number.isNaN(grossKg)) return refusal("grossKg", KILOGRAMS)
        const tareKg = weightOf(input, "tareKg")
        if (Number.isNaN(tareKg)) return refusal("tareKg", KILOGRAMS)
        if ((grossKg === undefined) !== (tareKg === undefined)) return refusal("tareKg", BOTH_GROSS_AND_TARE)
        if (grossKg !== undefined && tareKg !== undefined && netKg !== grossKg - tareKg) return refusal("netKg", NET_IS_GROSS_LESS_TARE)
        const note = said(input, "note")
        if (note === undefined) return refusal("note", "Say what was wrong with the weight")
        const ticket = said(input, "weighbridgeTicket")
        return { netKg, ...(grossKg === undefined ? {} : { grossKg, tareKg }), ...(ticket === undefined ? {} : { weighbridgeTicket: ticket }), note }
      },
      run: reviewThenRead("correct"),
      refused: (record) => `${record.name} was not corrected`,
      // The correction is a new unload: the module is read again for it.
      touches: [`${WEIGHTS_MODULE.workspaceId}.${WEIGHTS_MODULE.moduleId}`],
    },
  },
}

/** Route Studio › Weight Control: the unloads and their reviews. */
export const weightsModule: ServerModule = { workspaceId: WEIGHTS_MODULE.workspaceId, moduleId: WEIGHTS_MODULE.moduleId, resources: [unloadAdapter] }
