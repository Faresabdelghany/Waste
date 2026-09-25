// Weight control (Issue #112, §3 "Weight control", §5): the review of an
// Unload's weight, the workflow over weighbridge evidence Execution deferred
// here (#104: "a review workflow over weighbridge evidence whose outcome is
// Billable Event readiness"). A review is a row appended to `weight_review`
// — a ledger, `recorded` and `appendOnly`, one row per decision — and the
// unload's status is the latest row's decision, or `captured` when nobody has
// looked: the reading every `Unload` carries as `weightReview`
// (routes/execution-shapes.ts, over @waste/db/query/weight-review) and the
// list filters by. Nothing here is updated: an approval is taken back by a
// rejection appended after it, a wrong weight by a correction.
//
// Three decisions, under `route-studio.weights` `edit` — the module that owns
// the Unload rows and the prototype's Weight Control, whose `edit` the
// Operations Manager, the Dispatcher and the Route Planner hold (#112 §7.23)
// — and one read under `view`. `POST /unloads/:id/approve` and `/reject`
// append `approved` or `rejected` (the rejection with the note that says
// why); `POST /unloads/:id/correct` is the correction as a new row, as #104
// §2 said ("a wrong unload is corrected there by a new row naming the old,
// the way `adjust` corrects a movement, and nothing here is updated"): it
// appends a new `unload` — the same route, station, fraction and instant,
// `source = dispatch`, the caller as its recorder, no session, the body's
// weights, ticket and note — through the statements the office's capture
// runs (routes/unload-writes.ts), and then a `corrected` review naming both;
// the new row is `captured` and may be reviewed and corrected in its turn.
// The correction emits no `unload-recorded` (#112 §7.26): the outbox carries
// what another context acts on, and the reader of a weight is Finance itself.
// `GET /unloads/:id/reviews` is the unload's reviews, oldest first.
//
// The machine is the domain's (`weightReviewTransition`,
// @waste/domain/finance/transitions): the same decision again is `stay`,
// answered 200 with the review that already said it and no write; anything
// on a corrected unload is a refusal naming the row to review, "This unload
// was corrected by unload <id>; review that one" (409). Each command answers
// 201 with the `WeightReview` and no `Location` (#109 §7.22's precedent, the
// ticket's comment: a review is read on the unload's list and has no address
// of its own).
//
// The lock. §3 says "the unload's row lock (`select … for update` on the
// ledger row)", and that statement is one the API role cannot run: Postgres
// asks UPDATE privilege of a `FOR UPDATE`, and `appendOnly` revoked it from
// `wms_api` on every ledger (42501, proved against the local database). So
// each command takes the row lock of the unload's route — the record the
// unload hangs off, which the API role may update — before it reads the
// reading again under it, and two reviews of one unload take turns on the
// route; two reviews of two unloads on one route take turns too, which is
// coarser than the sentence asked for and still correct, and the fold never
// forks. The unload is read once unlocked, to learn its route and answer its
// 404, and once more under the lock, since the reading may have moved while
// the lock was waited for.
import { Page } from "@waste/contracts/pagination"
import { WeightApprove, WeightCorrect, WeightReject, WeightReview, WeightReviewListQuery } from "@waste/contracts/weight-control"
import type { Tx } from "@waste/db/client"
import { route } from "@waste/db/schema/execution"
import { weightReview } from "@waste/db/schema/finance"
import { weightReviewTransition } from "@waste/domain/finance/transitions"
import type { WeightReviewDecision } from "@waste/domain/finance/vocabulary"
import { and, asc, eq, gt } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, problem, validate } from "../problem"
import { findUnload, noSuchUnload, type UnloadRow } from "./execution-shapes"
import { describeJson, IdParam, lockRow } from "./shared"
import { appendUnload } from "./unload-writes"

const MODULE = "route-studio.weights"

const ReviewPage = Page(WeightReview)

const reviewColumns = {
  id: weightReview.id,
  recordedAt: weightReview.recordedAt,
  projectId: weightReview.projectId,
  unloadId: weightReview.unloadId,
  decision: weightReview.decision,
  note: weightReview.note,
  correctionUnloadId: weightReview.correctionUnloadId,
  reviewedBy: weightReview.reviewedBy,
}

type ReviewRow = Pick<typeof weightReview.$inferSelect, keyof typeof reviewColumns>

/** The review on the wire. The decision is text with a CHECK in the database and an enum here. */
function reviewOf(row: ReviewRow): WeightReview {
  return {
    id: row.id,
    recordedAt: row.recordedAt.toISOString(),
    projectId: row.projectId,
    unloadId: row.unloadId,
    decision: row.decision as WeightReviewDecision,
    note: row.note,
    correctionUnloadId: row.correctionUnloadId,
    reviewedBy: row.reviewedBy,
  }
}

/**
 * The unload the path names, locked and read: once unlocked, to learn its
 * route and answer the family's 404, then its route's row lock (the ledger
 * row itself cannot be locked by the API role, see the header), then read
 * again under the lock, since the reading is what the machine judges and it
 * may have moved while the lock was waited for.
 */
async function lockedUnload(tx: Tx, principal: Principal, id: string): Promise<UnloadRow> {
  const found = await findUnload(tx, principal, id)
  if (found === undefined) throw noSuchUnload(id)
  await lockRow(tx, route, { companyId: principal.companyId, id: found.routeId })
  const current = await findUnload(tx, principal, id)
  if (current === undefined) throw noSuchUnload(id)
  return current
}

/** The review the reading names, for a decision already taken: the row is there, since a status other than `captured` is a review's decision. */
async function latestReview(tx: Tx, companyId: string, current: UnloadRow): Promise<ReviewRow> {
  if (current.reviewId === null) throw new Error(`unload ${current.id} reads ${current.reviewStatus} with no review to have said so`)
  const [row] = await tx
    .select(reviewColumns)
    .from(weightReview)
    .where(and(eq(weightReview.companyId, companyId), eq(weightReview.id, current.reviewId)))
    .limit(1)
  if (row === undefined) throw new Error(`weight_review ${current.reviewId} named by the reading of unload ${current.id} is not there`)
  return row
}

/** What a decision writes beside itself: the note, and on a correction the new unload. */
type Decided = { note: string | null; correctionUnloadId: string | null }

/**
 * One decision: the lock, the read, the machine, and on a move the review
 * row appended with what the decision carries. `stay` answers the review
 * that already said it, without a write; `refuse` is the 409 in the machine's
 * words. `beyond` runs after the machine and before the row, and answers what
 * the row is written with — the correction appends its unload there.
 */
async function decided(tx: Tx, principal: Principal, id: string, decision: WeightReviewDecision, beyond: (current: UnloadRow) => Promise<Decided>): Promise<{ review: ReviewRow; wrote: boolean }> {
  const current = await lockedUnload(tx, principal, id)
  const transition = weightReviewTransition(current.reviewStatus, decision, current.reviewCorrectionUnloadId)
  if (transition.kind === "refuse") throw problem(409, { detail: transition.sentence })
  if (transition.kind === "stay") return { review: await latestReview(tx, principal.companyId, current), wrote: false }
  const beside = await beyond(current)
  const [review] = await tx
    .insert(weightReview)
    .values({
      id: newId(),
      companyId: principal.companyId,
      projectId: current.projectId,
      unloadId: current.id,
      decision: transition.to,
      note: beside.note,
      correctionUnloadId: beside.correctionUnloadId,
      reviewedBy: principal.user.id,
    })
    .returning(reviewColumns)
  return { review, wrote: true }
}

const commandProblems = {
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(`No active account here, or the caller's role does not allow \`edit\` on \`${MODULE}\`.`),
  404: describeProblem("No unload with that id in the projects this account works in."),
  409: describeProblem("The unload was corrected; the detail names the unload to review instead."),
}

const APPENDED = "Answers 201 with the review and no `Location`, like the ledger's commands: a review is read on `GET /unloads/{id}/reviews`, a list, and has no address of its own."
const CORRECTED = "An unload that was corrected is refused (409, `This unload was corrected by unload <id>; review that one`): the correction is the row to review."
const LOCKED = "Runs under the unload's route's row lock — a ledger row cannot be locked by the API role, which may not update it — with the reading read again under it, so two reviews take turns and the fold never forks."

export function weightControlRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .post(
      "/unloads/:id/approve",
      describeRoute({
        operationId: "approveUnloadWeight",
        summary: "Approve an unload's weight",
        description:
          "The `approved` decision: appends an `approved` review of the unload's weight, with a note if any; the unload then reads `approved` on every list and read. An unload already approved answers 200 with the review that approved it, without a write; a rejected or a captured one takes the approval. " +
          CORRECTED +
          " " +
          LOCKED +
          " " +
          APPENDED +
          " An unload of another company, or of a project this account does not work in, is an unload that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The unload was already approved: the review that approved it, as it stands.", WeightReview),
          201: describeJson("The review as it was appended.", WeightReview),
          400: describeProblem("The path does not hold an id, or the body names a member the command does not take."),
          ...commandProblems,
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", WeightApprove),
      async (c) => {
        const { id } = c.req.valid("param")
        const { note } = c.req.valid("json")
        const { review, wrote } = await decided(c.get("tx"), c.get("principal"), id, "approved", async () => ({ note: note ?? null, correctionUnloadId: null }))
        return c.json(reviewOf(review), wrote ? 201 : 200)
      },
    )
    .post(
      "/unloads/:id/reject",
      describeRoute({
        operationId: "rejectUnloadWeight",
        summary: "Reject an unload's weight",
        description:
          "The `rejected` decision: appends a `rejected` review with the note that says why (required); the unload then reads `rejected`. An unload already rejected answers 200 with the review that rejected it, without a write; an approved or a captured one takes the rejection. " +
          CORRECTED +
          " " +
          LOCKED +
          " " +
          APPENDED +
          " An unload of another company, or of a project this account does not work in, is an unload that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The unload was already rejected: the review that rejected it, as it stands.", WeightReview),
          201: describeJson("The review as it was appended.", WeightReview),
          400: describeProblem("The path does not hold an id, or the body has no note or names a member the command does not take."),
          ...commandProblems,
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", WeightReject),
      async (c) => {
        const { id } = c.req.valid("param")
        const { note } = c.req.valid("json")
        const { review, wrote } = await decided(c.get("tx"), c.get("principal"), id, "rejected", async () => ({ note, correctionUnloadId: null }))
        return c.json(reviewOf(review), wrote ? 201 : 200)
      },
    )
    .post(
      "/unloads/:id/correct",
      describeRoute({
        operationId: "correctUnloadWeight",
        summary: "Correct an unload's weight with a new unload",
        description:
          "The `corrected` decision: the correction as a new row, never an update. Appends a new Unload on the same route, station, fraction and instant as the one corrected — `source` dispatch, the caller as its recorder, no session, the body's `netKg`, `grossKg` and `tareKg` (together or neither, 400 at `tareKg`; net is gross less tare where both are given, 400 at `netKg`), `weighbridgeTicket` and `note` — through the statements the office's capture runs, and then a `corrected` review naming both, whose `correctionUnloadId` is where the new weight is read; the corrected unload reads `corrected` from here on and takes no further decision, and the new unload is `captured` and may be reviewed and corrected in its turn. No `unload-recorded` event is written for the correction: the outbox carries what another context acts on, and the reader of a weight is Finance itself. " +
          CORRECTED +
          " " +
          LOCKED +
          " " +
          APPENDED +
          " An unload of another company, or of a project this account does not work in, is an unload that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          201: describeJson("The review as it was appended, naming the new unload.", WeightReview),
          400: describeProblem("The path does not hold an id, or the body is missing the net weight or the note, names a member the command does not take, gives one of gross and tare without the other, or a net that is not gross less tare."),
          ...commandProblems,
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", WeightCorrect),
      async (c) => {
        const { id } = c.req.valid("param")
        const { netKg, grossKg, tareKg, weighbridgeTicket, note } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const { review } = await decided(tx, principal, id, "corrected", async (current) => {
          const correction = await appendUnload(tx, principal.companyId, {
            projectId: current.projectId,
            routeId: current.routeId,
            unloadingStationId: current.unloadingStationId,
            wasteFractionId: current.wasteFractionId,
            occurredAt: current.occurredAt,
            recordedBy: principal.user.id,
            grossKg: grossKg ?? null,
            tareKg: tareKg ?? null,
            netKg,
            weighbridgeTicket: weighbridgeTicket ?? null,
            note,
          })
          return { note, correctionUnloadId: correction.id }
        })
        return c.json(reviewOf(review), 201)
      },
    )
    .get(
      "/unloads/:id/reviews",
      describeRoute({
        operationId: "listUnloadWeightReviews",
        summary: "One unload's weight reviews",
        description:
          "One page of the unload's reviews, oldest first — a cursor over time-ordered ids is a cursor over recording order — each carrying the decision, the note, the new unload a correction wrote, and who decided. The ledger is append-only: nothing here is ever updated or removed, and the unload's `weightReview` is the last row of this list folded. An unload of another company, or of a project this account does not work in, is an unload that does not exist here. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of the unload's reviews, oldest first.", ReviewPage),
          400: describeProblem("The path does not hold an id, the page size is outside 1..200, or the cursor is not one this API wrote."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`view\` on \`${MODULE}\`.`),
          404: describeProblem("No unload with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      validate("query", WeightReviewListQuery),
      async (c) => {
        const { id } = c.req.valid("param")
        const { limit, cursor } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if ((await findUnload(tx, principal, id)) === undefined) throw noSuchUnload(id)
        const rows = await tx
          .select(reviewColumns)
          .from(weightReview)
          .where(and(eq(weightReview.companyId, principal.companyId), eq(weightReview.unloadId, id), after === undefined ? undefined : gt(weightReview.id, after)))
          .orderBy(asc(weightReview.id))
          .limit(fetchLimit(limit))
        const { items, nextCursor } = pageOf(rows, limit)
        return c.json({ items: items.map(reviewOf), nextCursor })
      },
    )
}
