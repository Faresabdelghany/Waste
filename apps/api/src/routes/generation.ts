// The office's door to generation (Issue #97 part B, #128): the button that
// asks for a run, and the two reads that watch it. `POST
// /route-schemes/:id/generate` writes the scheme's `generation_run` —
// `queued`, `on-demand`, over the window the body names — and sends the
// worker's `planning.generate-routes` job for it in the request's
// transaction — `sendGenerateRoutes` (`@waste/db/jobs`), the spelling the
// nightly sweep uses, over pg-boss's `send` for a process that runs no
// pg-boss: a sender app.ts builds once over the probe pool and never starts
// (Issue #168) — so the run and its job commit together or not at all, and
// answers at once: 202 with the run before generation has begun.
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
// run whose job pg-boss still holds, 200, found by that job's state in
// pg-boss's own table (`jobHeld`, `@waste/db/jobs`) and not by the scheme's
// newest row: a run whose job died with a worker, or was cancelled by hand,
// is history, and the newest row is not always the held one. Two clicks, or
// a click beside the night's sweep, are one run. That run may cover another
// window; the 200 says it is not this request's. Its status reads `queued`
// while the job waits or runs and `failed` while a failed attempt waits for
// its retry. A refused send with no held run to show for it — the sweep's
// transaction not yet committed, a run removed by hand — is a 409 that says
// to ask again; and a database no worker has started on has no queue to
// send to, which is a 503 in so many words (`QueueMissing`), since the
// worker makes the queue at its boot and the deployment's order is what
// stands in the way, not the request.
// Sending first also keeps the request clear of the scheme's row lock:
// generation holds it `for update` for its whole transaction, and the
// run's key on the scheme would make an insert wait for it — here an insert
// happens only when no job of the scheme is queued or active, so no
// generation holds the lock. For the same reason the route takes no
// `lockRow` on the scheme before reading its status, against the API's rule
// for a row whose rule it holds: a click must never wait on a generation
// (#128), and the rule it would protect is held again by the worker.
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
import { jobHeld, QueueMissing, sendGenerateRoutes, type JobSender } from "@waste/db/jobs"
import { generationRun } from "@waste/db/schema/generation"
import { and, desc, eq, lt, sql, type SQL } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, problem, validate } from "../problem"
import { findScheme, MODULE, noSuchScheme } from "./scheme-groups"
import { describeJson, IdParam, instantOf, stampsOf } from "./shared"

const GenerationRunPage = Page(GenerationRun)

/** What a draft scheme's generate is refused with (#97 part B). */
export const DRAFT_GENERATES_NOTHING = "A draft scheme generates nothing; validate it first"

/** What a send pg-boss refused is told when no held run shows for it: a job of the scheme is queued or active that this transaction cannot see the run of. */
export const GENERATION_ALREADY_QUEUED = "A generation of this scheme is already queued or running; ask again in a moment"

/** What a database no worker has started on is told: the queue is the worker's to make, so the deployment's order is what stands in the way. */
export const WORKER_QUEUE_MISSING = "The worker has not started on this database yet, so its queue is not there; start it and ask again"

const noSuchRun = (id: string) => problem(404, { detail: `No generation run ${id} in the projects this account works in` })

export type GenerationOptions = {
  /** pg-boss's `send` for this process (app.ts builds one over the probe pool); the trigger sends through it inside the request's transaction. */
  jobs: JobSender
}

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

export function generationRoutes(guard: MiddlewareHandler<AuthEnv>, { jobs }: GenerationOptions) {
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
          409: describeProblem(
            `The scheme is a draft (${JSON.stringify(DRAFT_GENERATES_NOTHING)}), or the worker's queue holds a job of this scheme that no run this request can see is held by (${JSON.stringify(GENERATION_ALREADY_QUEUED)}).`,
          ),
          503: describeProblem(`No worker has started on this database yet, so the generation queue is not there to send to (${JSON.stringify(WORKER_QUEUE_MISSING)}); nothing was written.`),
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
        let jobId: string | null
        try {
          jobId = await sendGenerateRoutes(jobs.send, tx, { generationRunId: runId, companyId: principal.companyId, routeSchemeId: scheme.id })
        } catch (error) {
          if (error instanceof QueueMissing) throw problem(503, { detail: WORKER_QUEUE_MISSING })
          throw error
        }
        if (jobId === null) {
          // A job of the scheme is queued, active or waiting to retry: answer the run that job is held for — the one whose job pg-boss's table still shows live — newest should there be more than one.
          const [inFlight] = await tx
            .select(runColumns)
            .from(generationRun)
            .where(and(runScope(principal), eq(generationRun.routeSchemeId, scheme.id), jobHeld(sql`${generationRun.jobId}`)))
            .orderBy(desc(generationRun.id))
            .limit(1)
          if (inFlight === undefined) throw problem(409, { detail: GENERATION_ALREADY_QUEUED })
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
