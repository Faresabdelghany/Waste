// A vehicle maintenance plan's due state as a statement reads it (O20 of
// #290): `maintenanceDue` (@waste/domain/resources/maintenance) in SQL,
// judged against the last service's own readings, since nothing reads a
// vehicle's odometer or engine hours between services — what the worker's
// `maintenance-due` rule raises its alert on, and what the API's plans answer
// in TypeScript. `maintenance-due.test.ts` holds the two to each other over
// the same plans and days.
import { MAINTENANCE_WARNING_DAYS, MAINTENANCE_WARNING_HOURS, MAINTENANCE_WARNING_KM, type MaintenanceDueState } from "@waste/domain/resources/maintenance"
import { sql, type SQL, type SQLWrapper } from "drizzle-orm"

/** A plan's columns as the statement names them: its intervals and the last service's day and readings. */
export type MaintenancePlanColumns = {
  intervalDays: SQLWrapper
  intervalKm: SQLWrapper
  intervalHours: SQLWrapper
  lastDoneOn: SQLWrapper
  lastDoneKm: SQLWrapper
  lastDoneHours: SQLWrapper
}

/** The plan's next limits: the last service's day and readings plus each interval, null where it has no such interval or no reading to count from — `maintenanceDue`'s `nextDueOn`, `nextDueKm` and `nextDueHours`. */
export const nextDue = (plan: MaintenancePlanColumns): { on: SQL<string | null>; km: SQL<number | null>; hours: SQL<number | null> } => ({
  on: sql<string | null>`(${plan.lastDoneOn} + ${plan.intervalDays})`,
  km: sql<number | null>`(${plan.lastDoneKm} + ${plan.intervalKm})`,
  hours: sql<number | null>`(${plan.lastDoneHours} + ${plan.intervalHours})`,
})

/** Where the plan stands on `today` (a `date`): `overdue` past a limit, `due-soon` within a margin of one, else `ok` — `maintenanceDue`'s state with no newer reading than the last service's. */
export function maintenanceDueState(plan: MaintenancePlanColumns, today: SQLWrapper): SQL<MaintenanceDueState> {
  const next = nextDue(plan)
  return sql<MaintenanceDueState>`(case
    when coalesce(${today} >= ${next.on} or ${plan.lastDoneKm} >= ${next.km} or ${plan.lastDoneHours} >= ${next.hours}, false) then 'overdue'
    when coalesce(${today} >= ${next.on} - ${MAINTENANCE_WARNING_DAYS}::int or ${plan.lastDoneKm} >= ${next.km} - ${MAINTENANCE_WARNING_KM}::int or ${plan.lastDoneHours} >= ${next.hours} - ${MAINTENANCE_WARNING_HOURS}::int, false) then 'due-soon'
    else 'ok'
  end)`
}
