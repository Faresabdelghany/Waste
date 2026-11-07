// A project's working week: the days it rests on, never all seven. The
// holiday policy shifts a collection to the next working day, and a project
// with none would send it two months out, so a weekend leaves a working day;
// the database holds the same rule as `project_weekend_not_every_day`.
import { SERVICE_DAYS } from "../days"

/** The most days a project may rest on: one short of the week. */
export const WEEKEND_MAX = SERVICE_DAYS.length - 1

/** What a weekend of all seven days is told. */
export const A_WORKING_DAY = "A project rests on at most six days: it has to have a working day"
