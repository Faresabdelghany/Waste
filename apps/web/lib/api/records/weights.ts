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
// Two sentences of the contract's own rules are spelled again here (the web
// imports the contracts as types only) and held equal by the test.
//
// Ids, rule (b) of #81's plan: `unload-<uuid>`; no fixture lends its id.
import type { Unload } from "@waste/contracts/unloads"
import type { WeightReviewStatus } from "@waste/domain/finance/vocabulary"

import { FIXTURE_COMPANY_ID } from "@/lib/data/business-modules"
import { MASTER_DATA_KIND_DETAILS } from "@/lib/data/master-data-kinds"
import { isUnloadRecord, UNLOAD_PREFIX, UNLOAD_RECORD_KIND, WEIGHTS_MODULE } from "@/lib/data/provider-money"

import { command, get, listAll } from "../client"
import { inheritedPresentation, said, stampFacts, typed, webIdOf, type Client, type CommandInput, type ResourceAdapter, type ServerModule } from "./adapter"
import { shownOn } from "./clock"
import { referenced, refusal } from "./places"
import { nameVia } from "./references"

/** A review status as the desk reads it: `captured` is the queue. */
export const REVIEW_LABELS: Readonly<Record<WeightReviewStatus, string>> = { captured: "Needs review", approved: "Approved", rejected: "Rejected", corrected: "Corrected" }
/** What a correction giving one of gross and tare is told (`@waste/contracts/unloads`, `BOTH_GROSS_AND_TARE`). */
export const BOTH_GROSS_AND_TARE = "Give grossKg and tareKg together or neither"
/** What a correction whose net is not gross less tare is told (`NET_IS_GROSS_LESS_TARE`). */
export const NET_IS_GROSS_LESS_TARE = "netKg is grossKg less tareKg where both are given"
const KILOGRAMS = "A weight is a whole number of kilograms, 1 or more"

/** An unload as a resource: a ledger row stamped with its `recordedAt` as both of a resource's stamps. */
export type UnloadResource = Unload & { createdAt: string; updatedAt: string }
const stamped = (unload: Unload): UnloadResource => ({ ...unload, createdAt: unload.recordedAt, updatedAt: unload.recordedAt })

const kilograms = (value: number) => `${new Intl.NumberFormat("en").format(value)} kg`

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
  list: async (client) => (await listAll<Unload>(client, "/unloads")).map(stamped),
  read: (client, serverId) => get<Unload>(client, `/unloads/${serverId}`).then(stamped),
  toRecord: (unload, context) => {
    const project = referenced(context, "project", unload.projectId)
    const projectRecord = context.resolve.byServerId(unload.projectId)
    const timezone = projectRecord === undefined ? undefined : typed(projectRecord, "timezone")
    const route = nameVia(context, "route", unload.routeId)
    const station = nameVia(context, "station", unload.unloadingStationId)
    const fraction = nameVia(context, MASTER_DATA_KIND_DETAILS["waste-fraction"].prefix, unload.wasteFractionId)
    const correction = unload.weightReview.correctionUnloadId
    return {
      id: webIdOf(UNLOAD_PREFIX, unload.id),
      name: unload.weighbridgeTicket === null ? `${fraction} at ${station}` : `${unload.weighbridgeTicket} · ${fraction}`,
      context: `${route} · ${station}`,
      status: REVIEW_LABELS[unload.weightReview.status],
      ...inheritedPresentation(undefined),
      ...stampFacts(unload, context.now),
      value: kilograms(unload.netKg),
      description: `${fraction} tipped at ${station} off ${route}.`,
      facts: {
        Route: route,
        Station: station,
        "Waste fraction": fraction,
        ...(unload.grossKg === null ? {} : { Gross: kilograms(unload.grossKg) }),
        ...(unload.tareKg === null ? {} : { Tare: kilograms(unload.tareKg) }),
        Net: kilograms(unload.netKg),
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
      submittedValues: { routeId: webIdOf("route", unload.routeId), netKg: String(unload.netKg), ...(unload.grossKg === null ? {} : { grossKg: String(unload.grossKg) }), ...(unload.tareKg === null ? {} : { tareKg: String(unload.tareKg) }) },
    }
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
