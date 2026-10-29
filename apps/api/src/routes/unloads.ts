// The Unload as the weights desk reads and captures it (Issue #104, slice 3):
// `GET /unloads` lists the ledger across routes, `GET /unloads/:id` reads one
// row, and `POST /routes/:id/unloads` is the office's capture of a
// weighbridge ticket the device did not record — a forgotten one, a ticket
// that came by post. The row is a ledger's (`recorded`, `appendOnly`): it is
// never updated here, and weight control — approve, reject, correct — is
// Finance's review over these rows (Issue #112, routes/weight-control.ts), a
// wrong unload corrected there by a new row naming the old.
//
// The office's capture is `source = dispatch`, `recordedBy` the caller,
// `sessionId` null (a session is named by every driver-recorded row and by
// no office row, `unload_session_shape`), the id server-minted — the
// statements of routes/unload-writes.ts, which the correction writes through
// too. It is made on a route that ran, `active` or `completed` (#104 §7.21:
// the office may capture on a completed route where the device may not after
// `end-route`) — a route that has not is refused (409), and a cancelled one
// does not change. The station is one of the company's — any station, since
// a full truck unloads where it can and the route's planned one is a default
// the device offers, not a rule — and the fraction one of the company's, each
// a 400 at its field; the weights hold the table's own sentence at the
// boundary (contracts/unloads.ts: net given, gross and tare together or not
// at all, and net gross less tare where both are); and `occurredAt` may run
// ahead of the request's clock by the ledger's skew (`OCCURRED_AT_SKEW_MS`,
// routes/shared.ts, the one constant the ledger, the driver door and this
// capture read, and `requireNotAhead` the one check over it) and no further,
// in the domain's words. The `unload-recorded` event is written in the same
// transaction, carrying the unload as answered.
//
// The weighbridge in the office (O9 of #290): the capture may say the station
// refused the load (`refusal`, a reason and a note, which `other` needs); an
// accepted load's fraction is one the station takes, a 400 at
// `wasteFractionId` in the station's sentence otherwise (routes/unload-writes.ts,
// `stationTakes`), and a refused one's any. Every unload answered carries
// `load`, what the stops of its fraction weighed on board since the route's
// last accepted unload of it against its net, within the project's tolerance
// or above it, null where no stop was weighed (`unloadsAnswered`,
// routes/execution-shapes.ts).
//
// Every Unload answered here carries `weightReview`, the review ledger's
// reading (Issue #112 §5): the list, the read and the capture go through
// `unloadsFrom` (routes/execution-shapes.ts), one LATERAL probe per row for
// the latest review, and the list takes `?reviewStatus=` over the same fold,
// so the queue the weights desk works ("Needs review" is `captured`) is a
// filter and never a column.
//
// `GET /unloads/:id/transfer-note` (O18 of #290) answers the unload's waste
// transfer note as a PDF: made of its rows (routes/transfer-notes.ts) by the
// domain's model and `@waste/documents`' renderer, imported inside the
// handler alone as the invoice's document is, its bytes' sha256 the ETag. A
// load the station refused and an unload a review corrected have none (409).
//
// Every statement carries the tenant and `inProjects`; the grant is
// `route-studio.weights`, `view` to read and `create` to capture.
import { createHash } from "node:crypto"

import { Page } from "@waste/contracts/pagination"
import { Unload, UnloadCreate, UnloadListQuery } from "@waste/contracts/unloads"
import { reviewStatus } from "@waste/db/query/weight-review"
import { route, unload } from "@waste/db/schema/execution"
import { transferNoteOf } from "@waste/domain/execution/transfer-note"
import { and, asc, eq, gt, gte, lte } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv } from "../auth/principal"
import { projectIdsOf, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { emit } from "../outbox"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, validate } from "../problem"
import { findRoute, findUnload, noSuchRoute, noSuchUnload, unloadAnswered, unloadScope, unloadsAnswered, unloadsFrom } from "./execution-shapes"
import { requireRoute, requireUnloadingStation, requireWasteFraction } from "./references"
import { requireRan } from "./routes"
import type { ClockOptions } from "./scheme-groups"
import { created, describeCreated, describeJson, IdParam, lockRow, requireNotAhead } from "./shared"
import { noteRefusal, transferNoteInputOf } from "./transfer-notes"
import { appendUnload, notTaken, stationTakes } from "./unload-writes"

const MODULE = "route-studio.weights"

const UnloadPage = Page(Unload)

export function unloadRoutes(guard: MiddlewareHandler<AuthEnv>, { now = () => new Date() }: ClockOptions = {}) {
  return new Hono<AuthEnv>()
    .get(
      "/unloads",
      describeRoute({
        operationId: "listUnloads",
        summary: "The unloads of the caller's projects",
        description:
          "One page of unloads, oldest first (ids are time-ordered, so a cursor over them is a cursor over recording order), from the projects the caller works in — an account that works in none reads an empty page. `projectId` narrows it to one of those projects; naming another is refused. `routeId` is one route's unloads, and must be a route of a project this account works in (400 on the query); `unloadingStationId` what was tipped at one station, `wasteFractionId` one fraction, and `from` and `to` the window over `occurredAt` (both inclusive, `to` on or after `from`). Every unload carries `weightReview`, weight control's reading over it — the latest review's decision as its status, or `captured` where nobody has looked, with that review's id and, after a correction, the new unload the correction wrote — and `reviewStatus` narrows the page to one reading: `captured` is the weights desk's queue. Reviewing is `POST /unloads/{id}/approve`, `/reject` and `/correct`. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of unloads.", UnloadPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, a filter is malformed, the window runs backwards, `projectId` is not a project this account works in, or `routeId` is not a route of one."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`view\` on \`${MODULE}\`.`),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", UnloadListQuery),
      async (c) => {
        const { limit, cursor, projectId, routeId, unloadingStationId, wasteFractionId, reviewStatus: status, from, to } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        if (routeId !== undefined) await requireRoute(tx, { companyId: principal.companyId, projectId: projectId ?? projectIdsOf(principal) }, routeId, "routeId", "query")
        const { review, query } = unloadsFrom(tx, principal.companyId)
        const rows = await query
          .where(
            and(
              unloadScope(principal),
              projectId === undefined ? undefined : eq(unload.projectId, projectId),
              routeId === undefined ? undefined : eq(unload.routeId, routeId),
              unloadingStationId === undefined ? undefined : eq(unload.unloadingStationId, unloadingStationId),
              wasteFractionId === undefined ? undefined : eq(unload.wasteFractionId, wasteFractionId),
              // The fold in SQL, so the filter and the reading cannot disagree.
              status === undefined ? undefined : eq(reviewStatus(review.decision), status),
              from === undefined ? undefined : gte(unload.occurredAt, new Date(from)),
              to === undefined ? undefined : lte(unload.occurredAt, new Date(to)),
              after === undefined ? undefined : gt(unload.id, after),
            ),
          )
          .orderBy(asc(unload.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(await unloadsAnswered(tx, principal.companyId, rows), limit))
      },
    )
    .get(
      "/unloads/:id",
      describeRoute({
        operationId: "getUnload",
        summary: "One unload",
        description:
          "One unload of a project the caller works in: the route and session it was recorded on, the station and the fraction, the weights, the station's ticket, who recorded it, and `weightReview` — weight control's reading, the latest review's decision or `captured`, with that review's id and the new unload a correction wrote. An unload of another company, or of a project this account does not work in, is an unload that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The unload.", Unload),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`view\` on \`${MODULE}\`.`),
          404: describeProblem("No unload with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await findUnload(tx, principal, id)
        if (row === undefined) throw noSuchUnload(id)
        return c.json(await unloadAnswered(tx, principal.companyId, row))
      },
    )
    .get(
      "/unloads/:id/transfer-note",
      describeRoute({
        operationId: "getUnloadTransferNote",
        summary: "One unload's waste transfer note as its PDF",
        description:
          "The waste transfer note that goes with the load (O18 of #290): one A4 page naming the company as the transferor and carrier with the vehicle and the driver the load came on (the session's, else the route's actual crew, else its planned one), the station as the transferee, the waste — the fraction, its European List of Waste code as the list prints it, whether it is hazardous, the net weight and the weighbridge's gross and tare where weighed, the station's ticket — and the day and time of the transfer on the project's clock, with lines for both parties to sign. In Danish for a Danish project, in English otherwise. Its number is the unload's id. The unload never changes, but the company, the station and the fraction are read as they stand, so the bytes' sha256 is the ETag; `If-None-Match` with it answers 304. A load the station refused was not transferred, and an unload a weight review corrected has its correction's note: both are refused (409). Inline, named by the unload's id.",
        security: BEARER_SECURITY,
        responses: {
          200: { description: "The PDF.", content: { "application/pdf": { schema: { type: "string" as const, format: "binary" } } } },
          304: { description: "The ETag named is the note's as it stands." },
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`view\` on \`${MODULE}\`.`),
          404: describeProblem("No unload with that id in the projects this account works in."),
          409: describeProblem("The station refused the load, or a weight review corrected the unload; the detail says which."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await findUnload(tx, principal, id)
        if (row === undefined) throw noSuchUnload(id)
        const refusal = noteRefusal(row)
        if (refusal !== null) throw refusal
        const model = transferNoteOf(await transferNoteInputOf(tx, principal.companyId, row))
        const { renderTransferNote } = await import("@waste/documents/transfer-note")
        const bytes = await renderTransferNote(model)
        const etag = `"${createHash("sha256").update(bytes).digest("hex")}"`
        if (c.req.header("If-None-Match") === etag) return c.body(null, 304, { etag })
        return c.body(bytes, 200, {
          "content-type": "application/pdf",
          "content-disposition": `inline; filename="transfer-note-${row.id}.pdf"`,
          etag,
          "cache-control": "private, no-cache",
        })
      },
    )
    .post(
      "/routes/:id/unloads",
      describeRoute({
        operationId: "recordRouteUnload",
        summary: "Capture an unload the office holds the ticket for",
        description:
          "The office's capture of a weighbridge ticket on a route that ran (`active` or `completed`; a route that has not is refused, 409, and a cancelled one does not change): appends one Unload with `source` dispatch, the caller as its recorder, no session, and a server-minted id. The station is one of this company's — any station, since a full truck unloads where it can — and the fraction one of this company's (400 at the field). `netKg` is what was tipped, whole kilograms; `grossKg` and `tareKg` come together or not at all (400 at `tareKg`), and where both are given net is gross less tare (400 at `netKg`). `occurredAt` is when the truck tipped, on the caller's word, and at most five minutes ahead of the request's clock (400). `refusal` says the station refused the load: a reason from the list, and a note, which `other` needs (400 at `refusal.note`). An accepted load's fraction is one the station takes — a station that names none takes nothing — and any other is a 400 at `wasteFractionId` naming the station; a refused load's fraction may be any. The answer carries `load`, the stops' weights of the fraction on board against the net, as every unload does. The `unload-recorded` event is written in the same transaction, carrying the unload as answered.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The unload as it was appended.", Unload),
          400: describeProblem(
            "The path does not hold an id, or the body is missing a field, names a member the server owns, gives one of gross and tare without the other or a net that is not gross less tare, dates the unload more than five minutes after the request, names a station or a fraction that is not this company's, refuses the load for another reason without a note, or names, for a load the station took, a fraction the station does not take.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`create\` on \`${MODULE}\`.`),
          404: describeProblem("No route with that id in the projects this account works in."),
          409: describeProblem("The route has not run, or is cancelled."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("param", IdParam),
      validate("json", UnloadCreate),
      async (c) => {
        const { id } = c.req.valid("param")
        const { unloadingStationId, wasteFractionId, netKg, grossKg, tareKg, weighbridgeTicket, occurredAt, note, refusal } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        // The route's lock, then the route: a cancellation and a capture on one route take turns, and the status is read under the lock.
        await lockRow(tx, route, { companyId: principal.companyId, id })
        const current = await findRoute(tx, principal, id)
        if (current === undefined) throw noSuchRoute(id)
        // The body's 400s before the state's 409, the order every route keeps.
        await requireUnloadingStation(tx, principal.companyId, unloadingStationId)
        await requireWasteFraction(tx, principal.companyId, wasteFractionId)
        // An accepted load is of a fraction the station takes (O9 of #290); a refused one may be of any.
        if (refusal === undefined) {
          const takes = await stationTakes(tx, principal.companyId, unloadingStationId, wasteFractionId)
          if (!takes.takes) throw invalidRequest("body", [{ path: "wasteFractionId", message: notTaken(takes) }])
        }
        const at = now()
        const tipped = new Date(occurredAt)
        requireNotAhead(tipped, at)
        requireRan(current)
        const row = await appendUnload(tx, principal.companyId, {
          projectId: current.projectId,
          routeId: current.id,
          unloadingStationId,
          wasteFractionId,
          occurredAt: tipped,
          recordedBy: principal.user.id,
          grossKg: grossKg ?? null,
          tareKg: tareKg ?? null,
          netKg,
          weighbridgeTicket: weighbridgeTicket ?? null,
          note: note ?? null,
          refusalReason: refusal?.reason ?? null,
          refusalNote: refusal?.note ?? null,
        })
        const answered = await unloadAnswered(tx, principal.companyId, row)
        await emit(tx, principal, { aggregate: "unload", aggregateId: row.id, kind: "unload-recorded", payload: answered, projectId: row.projectId, occurredAt: tipped })
        return created(c, "/unloads", answered)
      },
    )
}
