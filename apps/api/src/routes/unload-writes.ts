// The office's unload as one function (Issue #112, §3 "Weight control").
// `POST /routes/:id/unloads` (routes/unloads.ts) appends a weighbridge ticket
// the device did not record, and `POST /unloads/:id/correct`
// (routes/weight-control.ts) appends the corrected reading of a wrong one —
// #104 §2's rule, "a wrong unload is corrected there by a new row naming the
// old, the way `adjust` corrects a movement, and nothing here is updated".
// Two doors, one statement: the row is `source = dispatch`, `recordedBy` the
// caller, `sessionId` null (a session is named by every driver-recorded row
// and by no office row, `unload_session_shape`), no device, no location, no
// photo, the id server-minted, so the capture and the correction cannot drift
// on what an office row is.
//
// What the two doors differ on is theirs and not here: the capture holds its
// route to having run and its `occurredAt` to the request's clock and emits
// `unload-recorded`; the correction copies the route, the station, the
// fraction and the instant off the row it corrects, takes the body's weights,
// and emits nothing (#112 §7.26: the outbox carries what another context acts
// on, and the reader of a weight is Finance itself). Neither reads the row
// back: a row just appended has no review by construction (`NO_REVIEW`).
import type { Tx } from "@waste/db/client"
import { unload } from "@waste/db/schema/execution"

import { newId } from "../ids"
import { NO_REVIEW, unloadColumns, type UnloadRow } from "./execution-shapes"

/** What an office unload says: the route it is on, the project the route is in, where and what was tipped, when, by whose word, the weights, the station's ticket and a note. */
export type OfficeUnload = {
  projectId: string
  routeId: string
  unloadingStationId: string
  wasteFractionId: string
  occurredAt: Date
  recordedBy: string
  grossKg: number | null
  tareKg: number | null
  netKg: number
  weighbridgeTicket: string | null
  note: string | null
}

/** Appends one office unload — `dispatch`, no session, no device, no location, no photo, a server-minted id — and answers the row with the reading a new row has. */
export async function appendUnload(tx: Tx, companyId: string, draft: OfficeUnload): Promise<UnloadRow> {
  const [row] = await tx
    .insert(unload)
    .values({
      id: newId(),
      companyId,
      projectId: draft.projectId,
      routeId: draft.routeId,
      sessionId: null,
      unloadingStationId: draft.unloadingStationId,
      wasteFractionId: draft.wasteFractionId,
      source: "dispatch",
      occurredAt: draft.occurredAt,
      recordedBy: draft.recordedBy,
      deviceId: null,
      location: null,
      grossKg: draft.grossKg,
      tareKg: draft.tareKg,
      netKg: draft.netKg,
      weighbridgeTicket: draft.weighbridgeTicket,
      objectKey: null,
      note: draft.note,
    })
    .returning(unloadColumns)
  return { ...row, ...NO_REVIEW }
}
