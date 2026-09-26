// The project as a command reads it (lifted from `apps/api/src/routes/
// fleet-lookups.ts` with the commands the worker runs, Issue #112 part B):
// its timezone, what an instant is rendered as a day in (days.ts); its
// currency, ISO 4217 as the contracts checked it; and today on its clock. The
// project is the caller's — proved under the request's scope a moment ago, or
// the one a job's event names — so its absence here is a bug and is thrown.
import { and, eq } from "drizzle-orm"

import type { Tx } from "../client"
import { project } from "../schema/organisation"
import { dayInTimezone } from "./days"

/** A company and one of its projects: what every project-scoped statement is bounded by. */
export type Scope = { companyId: string; projectId: string }

/** The project's timezone, an IANA name the contracts checked on the way in. */
export async function projectTimezone(tx: Tx, companyId: string, projectId: string): Promise<string> {
  const [row] = await tx
    .select({ timezone: project.timezone })
    .from(project)
    .where(and(eq(project.companyId, companyId), eq(project.id, projectId)))
    .limit(1)
  if (row === undefined) throw new Error(`projectTimezone: no project ${projectId} in company ${companyId}`)
  return row.timezone
}

/** The project's currency: what a price list defaults to and a default list must be in, and what a provider price is quoted in. */
export async function projectCurrency(tx: Tx, companyId: string, projectId: string): Promise<string> {
  const [row] = await tx
    .select({ currency: project.currency })
    .from(project)
    .where(and(eq(project.companyId, companyId), eq(project.id, projectId)))
    .limit(1)
  if (row === undefined) throw new Error(`projectCurrency: no project ${projectId} in company ${companyId}`)
  return row.currency
}

/** Today on a project's clock, asked for at most once per request or job. */
export type Today = () => Promise<string>

/**
 * Today on the project's clock — the caller's `now` rendered as a day in
 * `project.timezone` — read once, however many times it is asked, and not at
 * all when nobody asks: a Collection Group's licence day, a billing run's
 * `issuedOn`, a credit note's. The clock is the caller's and never
 * `new Date()` here, so a test pins the day.
 */
export function projectToday(tx: Tx, scope: Scope, now: () => Date): Today {
  let today: Promise<string> | undefined
  return () => (today ??= projectTimezone(tx, scope.companyId, scope.projectId).then((timezone) => dayInTimezone(now(), timezone)))
}
