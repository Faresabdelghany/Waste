// What the worker's sweeps across companies share: the read a sweep over
// projects starts from — every active project of every company, as the worker
// role (`wms_worker`, BYPASSRLS), each with today on its own clock at the
// sweep's instant, read only when the project's own work asks, so a clock the
// runtime refuses fails that project alone — and the loop over what a sweep
// found, each item's fenced writes in turn as `wms_api`, a failure told and
// collected rather than ending the sweep, so one company's trouble never holds
// the others back and the job fails at the end on what was collected.
import { dayInTimezone } from "@waste/domain/clock"
import { and, asc, eq } from "drizzle-orm"

import type { Database } from "./client"
import { project } from "./schema/organisation"

/** An active project, with its clock and today on it at the sweep's instant. */
export type ProjectToday = { companyId: string; projectId: string; timezone: string; today: () => string }

/** Every active project across companies, in id order, with today on its clock at `at`; `projectId` narrows it to that one. Read on the worker role's pool. */
export async function projectsWithToday(worker: Database, at: Date, projectId: string | null = null): Promise<ProjectToday[]> {
  const rows = await worker.db
    .select({ companyId: project.companyId, projectId: project.id, timezone: project.timezone })
    .from(project)
    .where(and(eq(project.status, "active"), projectId === null ? undefined : eq(project.id, projectId)))
    .orderBy(asc(project.id))
  return rows.map((row) => ({ ...row, today: () => dayInTimezone(at, row.timezone) }))
}

/**
 * Runs `work` over each item in turn, and answers the items whose work
 * threw, each told to `failed` as it failed; the items after a failure still
 * run.
 */
export async function sweepEach<T>(items: Iterable<T>, work: (item: T) => Promise<void>, failed: (item: T, error: unknown) => void): Promise<T[]> {
  const failures: T[] = []
  for (const item of items) {
    try {
      await work(item)
    } catch (error) {
      failed(item, error)
      failures.push(item)
    }
  }
  return failures
}
