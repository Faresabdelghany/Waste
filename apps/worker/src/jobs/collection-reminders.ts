// The collection reminders (C18 of #291): every hour, each project with a
// `collection-reminder` notification rule whose template is active, once its
// clock has passed `REMINDER_HOUR`, reminds the customers of the next day's
// scheduled collections — the emptyings generation planned on routes
// `planned` or `ready` operating that day (`remindersDue`,
// @waste/db/query/stop-customers) — with the day as `{{collectionDate}}`.
//
// Bounded, the coordinator's guard on #380: one run queues at most
// `REMINDER_BATCH` customers of a project, and a day at most
// `REMINDER_DAILY_CAP`, the first in customer-id order; the hourly runs of the
// afternoon reach the cap, and a customer beyond it is counted and logged,
// never reminded. A customer with no address on the template's channel is
// never counted, since `queueMessage` would refuse them on every run.
//
// A customer is reminded of a day once: the message's `source_event_id` is
// the reminder's fixed key for the customer and the day (`reminderKey`), so a
// run that overlaps another, or a day's later runs, queue nothing twice
// (`message_source_event_id_customer_id_idx`). The sweep for the projects
// reads across companies as `wms_worker`; each project's reminders are read
// and queued as `wms_api` under `withCompany`, each customer in a savepoint.
import { queueMessage } from "@waste/db/commands/messaging"
import { Refused } from "@waste/db/commands/shared"
import { newId } from "@waste/db/ids"
import { remindersDue } from "@waste/db/query/stop-customers"
import { withCompany } from "@waste/db/tenant"
import type { MessageChannel } from "@waste/domain/messaging/vocabulary"
import { REMINDER_BATCH, REMINDER_DAILY_CAP, reminderDayAt } from "@waste/domain/notifications/notices"
import { sql } from "drizzle-orm"

import { defineJob, type JobContext } from "./definition"

export const COLLECTION_REMINDERS_QUEUE = "messaging.collection-reminders"

/** The customers one transaction queues, each a savepoint: below the 64 subtransactions Postgres caches per transaction. */
export const REMINDER_CHUNK = 50

export type CollectionRemindersData = {
  /** Where the run came from: the schedule, or a caller who sent one by hand. */
  source: "schedule" | "manual"
}

/** A project that sends the reminder, with its template and its clock now. */
export type RemindingProject = { companyId: string; projectId: string; templateId: string; channel: MessageChannel; today: string; hour: number }

/** The projects whose rule names an active reminder template, across companies, as the worker role, with the day and the hour on each one's clock. */
export async function remindingProjects(worker: JobContext["worker"], at: Date): Promise<RemindingProject[]> {
  const now = sql`${at.toISOString()}::timestamptz`
  const rows = await worker.db.execute<{ company_id: string; project_id: string; template_id: string; channel: MessageChannel; today: string; hour: number }>(sql`
    select r.company_id, r.project_id, r.template_id, t.channel,
           to_char(${now} at time zone p.timezone, 'YYYY-MM-DD') as today,
           extract(hour from ${now} at time zone p.timezone)::int as hour
      from wms.notification_rule r
      join wms.project p on p.company_id = r.company_id and p.id = r.project_id
      join wms.message_template t on t.company_id = r.company_id and t.id = r.template_id
     where r.event = 'collection-reminder' and t.status = 'active'
     order by r.company_id, r.project_id
  `)
  return rows.map((row) => ({ companyId: row.company_id, projectId: row.project_id, templateId: row.template_id, channel: row.channel, today: row.today, hour: Number(row.hour) }))
}

/** What one project's run came to. */
export type ProjectReminded = { companyId: string; projectId: string; day: string; queued: number; refused: number; beyondCap: number }

/** One project's due reminders of `day`, at most `batch` of the day's first `cap`, queued in fenced transactions of `REMINDER_CHUNK` customers. */
export async function remindProject(
  project: Pick<RemindingProject, "companyId" | "projectId" | "templateId" | "channel">,
  day: string,
  { api, send, log }: Pick<JobContext, "api" | "send" | "log">,
  bounds: { cap: number; batch: number } = { cap: REMINDER_DAILY_CAP, batch: REMINDER_BATCH },
): Promise<ProjectReminded> {
  const outcome: ProjectReminded = { companyId: project.companyId, projectId: project.projectId, day, queued: 0, refused: 0, beyondCap: 0 }
  for (let left = bounds.batch; left > 0; ) {
    const size = Math.min(REMINDER_CHUNK, left)
    const read = await withCompany(api.db, project.companyId, async (tx) => {
      const { due, beyondCap } = await remindersDue(tx, project, day, { channel: project.channel, cap: bounds.cap, batch: size })
      outcome.beyondCap = Math.max(outcome.beyondCap, beyondCap)
      for (const { customerId, sourceEventId } of due) {
        try {
          // In a savepoint, so a refusal leaves the transaction whole.
          await tx.transaction((savepoint) =>
            queueMessage(savepoint, send, { id: newId(), companyId: project.companyId, templateId: project.templateId, customerId, contactId: null, sourceEventId, values: { collectionDate: day } }),
          )
          outcome.queued += 1
        } catch (error) {
          if (!(error instanceof Refused)) throw error
          outcome.refused += 1
          log(`collection-reminders: project ${project.projectId}, customer ${customerId} not reminded of ${day}: ${error.message}`)
        }
      }
      return due.length
    })
    // A refused customer is read again by the next chunk, so the run is bounded by what it read, not by what it queued.
    left -= read
    if (read < size) break
  }
  if (outcome.queued > 0) log(`collection-reminders: project ${project.projectId} → ${outcome.queued} reminded of ${day}`)
  if (outcome.beyondCap > 0) log(`collection-reminders: project ${project.projectId} has ${outcome.beyondCap} customers beyond the day's cap of ${bounds.cap} for ${day}, not reminded`)
  return outcome
}

/** One run: every reminding project past its hour, its next day's reminders, project by project. */
export async function runCollectionReminders(context: Pick<JobContext, "api" | "worker" | "send" | "log" | "now">): Promise<ProjectReminded[]> {
  const outcomes: ProjectReminded[] = []
  for (const project of await remindingProjects(context.worker, context.now())) {
    const day = reminderDayAt(project.today, project.hour)
    if (day === null) continue
    outcomes.push(await remindProject(project, day, context))
  }
  return outcomes
}

export const collectionRemindersJob = defineJob<CollectionRemindersData>({
  queue: COLLECTION_REMINDERS_QUEUE,
  description: "Reminds the customers of the next day's scheduled collections, where a project's notification rule names a reminder, once the project's clock passes two in the afternoon; at most 200 a project a run and 2,000 a day, each customer once a day (C18 of #291).",
  handler: async (_jobs, context) => {
    await runCollectionReminders(context)
  },
  // Hourly, at seven past, off the hour every other schedule meets on.
  schedule: "7 * * * *",
  scheduleData: { source: "schedule" },
  scheduleOptions: { tz: "UTC", missed: "skip" },
  // No retry: the next hour is the retry, reading the same.
  queueOptions: { retryLimit: 0, deleteAfterSeconds: 86_400 },
})
