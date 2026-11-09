// A project's clock as a mapping reads it (Issue #181): the project's day
// through the load's clock, and the timezone of the project a record is in,
// from the organisation the store loaded. How an instant and a day read on
// that clock is lib/format/clock.ts.
import type { BusinessRecord } from "@/lib/data/business-modules"
import { dayIn } from "@/lib/format/clock"
import { typed } from "@/lib/records/fields"

import { type MappingContext } from "./adapter"

/**
 * The project's day as a mapping reads it: through the load's clock where the
 * mapping is a load's, which notes the read so the store reads the module
 * again once that day turns (server-records.ts), else off the context's `now`.
 */
export function todayIn(context: MappingContext, timezone: string | undefined): string {
  return context.today?.(timezone) ?? dayIn(context.now ?? new Date(), timezone)
}

/** The timezone of the project a record is in — its typed `projectId`, else its scope — from the organisation the store loaded; undefined when the store holds no such project. */
export function projectTimezoneOf(record: Pick<BusinessRecord, "submittedValues" | "projectIds">, context: MappingContext): string | undefined {
  const webId = typed(record, "projectId") ?? record.projectIds?.[0]
  const serverId = webId === undefined ? undefined : context.resolve.serverIdOf(webId)
  const project = serverId === undefined ? undefined : context.resolve.byServerId(serverId)
  return project === undefined ? undefined : typed(project, "timezone")
}
