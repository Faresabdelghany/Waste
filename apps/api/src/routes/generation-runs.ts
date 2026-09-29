// The office's door to generation (Issue #97 part B, #128): the button that
// asks for a run, and the two reads that watch it. `POST
// /route-schemes/:id/generate` writes the scheme's `generation_run` —
// `queued`, `on-demand`, over the window the body names — and sends the
// worker's `planning.generate-routes` job for it in the request's
// transaction (queue.ts), so the run and its job commit together or not at
// all, and answers at once: 202 with the run before generation has begun.
// Generation is the worker's (apps/worker/src/jobs/generate-routes.ts), never
// the request's; a client reads `GET /generation-runs/:id` to watch the run
// finish, and `GET /route-schemes/:id/generation-runs` for a scheme's runs,
// newest first.
//
// One run of a scheme is queued or in flight at a time. The queue is
// `exclusive` and the send carries the scheme's id as `singletonKey`, so
// while a job of the scheme is queued, active or waiting to retry, the send
// answers null. The send therefore goes first, under an id minted for the
// run, and the run is written only once pg-boss has taken its job: a null
// writes nothing — no row to roll back, no savepoint — and the answer is the
// scheme's newest run, 200, which is the one the job pg-boss holds belongs
// to, since a run is only ever written beside a job that was taken (here and
// in the nightly sweep, plan-ahead.ts): two clicks, or a click beside the
// night's sweep, are one run. That run may cover another window; the 200
// says it is not this request's. Its status reads `queued` while the job
// waits or runs and `failed` while a failed attempt waits for its retry.
// Sending first also keeps the request clear of the scheme's row lock:
// generation holds it `for update` for its whole transaction, and the
// run's key on the scheme would make an insert wait for it — here an insert
// happens only when no job of the scheme is active, which is when nothing
// holds the lock.
//
// A draft scheme generates nothing and is refused (409) in the issue's
// words; the worker holds the same rule again when it runs, since a scheme
// may become a draft between the click and the run. A validated scheme
// plans the collections of its period inside the window, and a window beyond
// the period plans nothing there and cancels the planned routes an earlier
// run left in it — which is how a shortened scheme's routes go, so it is not
// refused. The window is the occurrence read's: both ends inclusive, at most
// 366 days, the job's walk cap (@waste/contracts/generation).
//
// The list is the API's first to read newest first: ordered by `id`
// descending, the cursor is still the last item's id (pagination.ts), and the
// next page is the rows below it. The grant is `route-studio.schemes`
// throughout, `edit` to generate and `view` to read, and a run is fenced like
// its scheme: a run of a project the caller does not work in is a run that
// does not exist here.
import { GenerationRequest, GenerationRun, GenerationRunListQuery } from "@waste/contracts/generation"
import { Page } from "@waste/contracts/pagination"
import type { GenerationRunStatus, GenerationTrigger } from "@waste/contracts/planning"
import { GENERATE_ROUTES_QUEUE, type GenerateRoutesData } from "@waste/db/commands/generation"
import { generationRun } from "@waste/db/schema/generation"
import { and, desc, eq, lt, type SQL } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, problem, validate } from "../problem"
import { sendInTransaction } from "../queue"
import { findScheme, MODULE, noSuchScheme } from "./scheme-groups"
import { describeJson, IdParam, instantOf, stampsOf } from "./shared"

const GenerationRunPage = Page(GenerationRun)

/** What a draft scheme's generate is refused with (#97 part B). */
export const DRAFT_GENERATES_NOTHING = "A draft scheme generates nothing; validate it first"

const noSuchRun = (id: string) => problem(404, { detail: `No generation run ${id} in the projects this account works in` })

/** The columns a run is read with: everything but the tenant and pg-boss's job id, which is the worker's bookkeeping. */
const runColumns = {
  id: generationRun.id,
  createdAt: generationRun.createdAt,
  updatedAt: generationRun.updatedAt,
  projectId: generationRun.projectId,
  routeSchemeId: generationRun.routeSchemeId,
  trigger: generationRun.trigger,
  windowFrom: generationRun.windowFrom,
  windowTo: generationRun.windowTo,
  status: generationRun.status,
  startedAt: generationRun.startedAt,
  finishedAt: generationRun.finishedAt,
  routesCreated: generationRun.routesCreated,
  routesRefreshed: generationRun.routesRefreshed,
  routesCancelled: generationRun.routesCancelled,
  pickupsWritten: generationRun.pickupsWritten,
  holidaysSkipped: generationRun.holidaysSkipped,
  unlocated: generationRun.unlocated,
  warnings: generationRun.warnings,
  error: generationRun.error,
}
type RunRow = Pick<typeof generationRun.$inferSelect, keyof typeof runColumns>

/** One run on the wire. */
const runOf = (row: RunRow): GenerationRun => ({
  ...row,
  ...stampsOf(row),
  trigger: row.trigger as GenerationTrigger,
  status: row.status as GenerationRunStatus,
  startedAt: instantOf(row.startedAt),
  finishedAt: instantOf(row.finishedAt),
})

/** The runs of this company, in the projects the caller works in. */
const runScope = (principal: Principal): SQL | undefined => and(eq(generationRun.companyId, principal.companyId), inProjects(generationRun.projectId, principal))

export function generationRunRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .post(
      "/route-schemes/:id/generate",
      describeRoute({
        operationId: "generateRouteScheme",
        summary: "Start a generation run of a route scheme",
        description:
          "Starts a generation run over the window and answers at once, before generation has begun: the scheme's run is written `queued` and `on-demand` and the worker's job for it is queued in the same transaction, and the 202 carries the run. Generation happens on the worker, never on the request; read `GET /generation-runs/{id}` to watch the run move from `queued` to `succeeded`, with its counts and warnings, or `failed`, with its error. One run of a scheme is queued or in flight at a time: while one is, nothing new is started and that run is answered instead, 200, whatever window it covers — so two clicks are one run. A draft scheme generates nothing (409). A validated scheme plans the collections of its period inside the window, and a window beyond the period plans nothing there and cancels the planned routes an earlier run left in it, which is how a shortened scheme's routes go. `from` and `to` are both inclusive, `to` on or after `from`, the window at most 366 days — the job's walk cap.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("A run of this scheme was already queued or in flight: that run, which this request did not start.", GenerationRun),
          202: describeJson("The run this request started, queued for the worker; nothing is generated yet.", GenerationRun),
          400: describeProblem("The path does not hold an id, `from` or `to` is not a calendar day, `to` comes before `from`, the window spans more than 366 days, or the body carries a member the server decides."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `route-studio.schemes`."),
          404: describeProblem("No route scheme with that id in the projects this account works in."),
          409: describeProblem("The scheme is a draft: a draft scheme generates nothing; validate it first."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", GenerationRequest),
      async (c) => {
        const { id } = c.req.valid("param")
        const window = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const scheme = await findScheme(tx, principal, id)
        if (scheme === undefined) throw noSuchScheme(id)
        if (scheme.status !== "validated") throw problem(409, { detail: DRAFT_GENERATES_NOTHING })

        const runId = newId()
        const data: GenerateRoutesData = { generationRunId: runId, companyId: principal.companyId }
        const jobId = await sendInTransaction(tx, GENERATE_ROUTES_QUEUE, data, { singletonKey: scheme.id })
        if (jobId === null) {
          // A job of the scheme is queued, active or waiting to retry, and it is the newest run's: answer that run.
          const [inFlight] = await tx
            .select(runColumns)
            .from(generationRun)
            .where(and(runScope(principal), eq(generationRun.routeSchemeId, scheme.id)))
            .orderBy(desc(generationRun.id))
            .limit(1)
          if (inFlight === undefined) throw new Error(`a generation job of route scheme ${scheme.id} is queued or active, and the scheme has no run`)
          return c.json(runOf(inFlight), 200)
        }
        const [row] = await tx
          .insert(generationRun)
          .values({
            id: runId,
            companyId: principal.companyId,
            projectId: scheme.projectId,
            routeSchemeId: scheme.id,
            trigger: "on-demand",
            windowFrom: window.from,
            windowTo: window.to,
            status: "queued",
            jobId,
          })
          .returning(runColumns)
        return c.json(runOf(row), 202)
      },
    )
    .get(
      "/route-schemes/:id/generation-runs",
      describeRoute({
        operationId: "listRouteSchemeGenerationRuns",
        summary: "One route scheme's generation runs, newest first",
        description:
          "One page of the scheme's generation runs, newest first — the office's button's and the nightly plan-ahead's alike (`trigger`) — each with its window, where it stands, its counts, its warnings and, when it failed, its error. `status` answers the runs in one status. A scheme of another company, or of a project this account does not work in, is a scheme that does not exist here. Hand `nextCursor` back as `cursor` for the next, older page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of the scheme's generation runs, newest first.", GenerationRunPage),
          400: describeProblem("The path does not hold an id, the page size is outside 1..200, the cursor is not one this API wrote, or `status` is not a run's status."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `route-studio.schemes`."),
          404: describeProblem("No route scheme with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      validate("query", GenerationRunListQuery),
      async (c) => {
        const { id } = c.req.valid("param")
        const { limit, cursor, status } = c.req.valid("query")
        // The cursor is the last run of the page before; newest first, so the next page is the runs below it.
        const below = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if ((await findScheme(tx, principal, id)) === undefined) throw noSuchScheme(id)
        const rows = await tx
          .select(runColumns)
          .from(generationRun)
          .where(
            and(
              runScope(principal),
              eq(generationRun.routeSchemeId, id),
              status === undefined ? undefined : eq(generationRun.status, status),
              below === undefined ? undefined : lt(generationRun.id, below),
            ),
          )
          .orderBy(desc(generationRun.id))
          .limit(fetchLimit(limit))
        const { items, nextCursor } = pageOf(rows, limit)
        return c.json({ items: items.map(runOf), nextCursor })
      },
    )
    .get(
      "/generation-runs/:id",
      describeRoute({
        operationId: "getGenerationRun",
        summary: "One generation run",
        description:
          "One generation run, as the worker has left it: `queued` until the worker has finished it, then `succeeded` with what it did — routes created, refreshed and cancelled, pickups written, holidays skipped, containers it could not place — and the warnings it wants read beside its counts, or `failed` with its error. This is what the office polls after `POST /route-schemes/{id}/generate`.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The generation run.", GenerationRun),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `route-studio.schemes`."),
          404: describeProblem("No generation run with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const [row] = await tx
          .select(runColumns)
          .from(generationRun)
          .where(and(runScope(principal), eq(generationRun.id, id)))
          .limit(1)
        if (row === undefined) throw noSuchRun(id)
        return c.json(runOf(row))
      },
    )
}
