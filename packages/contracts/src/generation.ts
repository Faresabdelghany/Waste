// Generation on the wire (Issue #97 part B, ADR-0002): the office's request
// for a run and the run it gets back. `GenerationRequest` is the body of
// `POST /route-schemes/:id/generate`: the window of days to plan, held to the
// occurrence read's two rules in the same words (route-schemes.ts), both ends
// inclusive and at most 366 days — the generation job's walk cap. It is a
// write body, so the trigger, the status and the scheme, which the server
// decides, are refused by name.
//
// `GenerationRun` is the `generation_run` row as a client reads it: the
// window asked for, what started it (`on-demand` for the office's button,
// `cron` for the nightly sweep), where it stands and the two instants its
// status moved. The worker marks a run `running` inside the one transaction
// that generates it, so a reader sees `queued` until that transaction ends
// and then `succeeded`, with its counts and the warnings it wants read beside
// them, or `failed`, with the `loggable` projection of the error. pg-boss's
// job id stays on the row: it is the worker's bookkeeping, not the office's.
// The route answers the run at once and never waits for it (#128's worker
// shape), so a client reads it again, `GET /generation-runs/:id`, to watch it.
// `GenerationRunListQuery` is a scheme's runs, newest first, by status.
import * as z from "zod"

import { IsoDate, IsoDateTime } from "./dates"
import { Id } from "./ids"
import { PageRequest } from "./pagination"
import { GenerationRunStatus, GenerationTrigger } from "./planning"
import { NonNegativeInt, stamped } from "./resource"
import { windowAtMostAYear, windowAtMostAYearIssue, windowOrdered, windowOrderedIssue } from "./route-schemes"

/** `POST /route-schemes/:id/generate`: the days to plan, both inclusive, `to` on or after `from`, at most 366 days. */
export const GenerationRequest = z
  .strictObject({
    from: IsoDate,
    to: IsoDate,
  })
  .refine(windowOrdered, windowOrderedIssue)
  .refine(windowAtMostAYear, windowAtMostAYearIssue)
export type GenerationRequest = z.infer<typeof GenerationRequest>

/** A count of what a run did: whole, zero or more. */
const Count = NonNegativeInt

/** One run of generation over one scheme and one window, as the job leaves it at each step. */
export const GenerationRun = z.object({
  ...stamped,
  projectId: Id,
  routeSchemeId: Id,
  trigger: GenerationTrigger,
  /** The window asked for, both days inclusive; the job walks at most 366 days past `windowFrom`. */
  windowFrom: IsoDate,
  windowTo: IsoDate,
  status: GenerationRunStatus,
  /** When the worker took the run; null while it is queued. */
  startedAt: IsoDateTime.nullable(),
  /** When it succeeded or failed; null until then. */
  finishedAt: IsoDateTime.nullable(),
  routesCreated: Count,
  routesRefreshed: Count,
  routesCancelled: Count,
  pickupsWritten: Count,
  holidaysSkipped: Count,
  /** Containers the run could not place on a service date. */
  unlocated: Count,
  /** Sentences the run wants read beside its counts, never a failure. */
  warnings: z.array(z.string()),
  /** The `loggable` projection of what failed, as the worker wrote it; null unless the run failed. */
  error: z.string().nullable(),
})
export type GenerationRun = z.infer<typeof GenerationRun>

/** A page of one scheme's runs, newest first, of one status. */
export const GenerationRunListQuery = PageRequest.extend({
  status: GenerationRunStatus.optional(),
})
export type GenerationRunListQuery = z.infer<typeof GenerationRunListQuery>
