// The order routing jobs run in (#132 §1): the class first — a reorder's
// measurement, an Optimise click or a preview before anything the horizon
// asked for — then batch by the nearest operating date. pg-boss runs the
// highest priority first, so the number is the rule: every interactive job
// above the whole batch scale, and a batch job one step lower per day of its
// operating date, counted from the date alone. Among the jobs waiting, the
// earliest date is the nearest, so no sender's clock enters it — nor the
// question of whose day "today" is — and a deferred job, re-sent with the
// same date, keeps its place.
import type { RoutingJobClass } from "./vocabulary"

/** Where the batch scale starts: a batch job's priority is this less its operating date's day of the Unix epoch. */
const BATCH_CEILING = 1_000_000

/** Above every batch job. */
const INTERACTIVE = 2_000_000

const MS_PER_DAY = 86_400_000

export function routingJobPriority({ class: jobClass, operatingDate }: { class: RoutingJobClass; operatingDate: string }): number {
  if (jobClass === "interactive") return INTERACTIVE
  return BATCH_CEILING - Math.round(Date.parse(`${operatingDate}T00:00:00Z`) / MS_PER_DAY)
}
