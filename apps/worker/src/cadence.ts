// A cadence in seconds as a cron can run it evenly: whole minutes that divide
// an hour, or whole hours that divide a day, since `*/N` starts again at every
// hour or day and any other N leaves a short gap at the turn. The environment
// refuses any other (env.ts), and the alert rules' schedule is built from one
// (jobs/alert-rules.ts).

const MINUTES_IN_AN_HOUR = 60
const HOURS_IN_A_DAY = 24

/** Whether the seconds run evenly on a cron. */
export function isEvenCadence(seconds: number): boolean {
  if (!Number.isInteger(seconds) || seconds < 60 || seconds % 60 !== 0) return false
  const minutes = seconds / 60
  if (minutes < MINUTES_IN_AN_HOUR) return MINUTES_IN_AN_HOUR % minutes === 0
  return minutes % MINUTES_IN_AN_HOUR === 0 && HOURS_IN_A_DAY % (minutes / MINUTES_IN_AN_HOUR) === 0
}

/** The cron an even cadence runs on: every N minutes, every N hours, or once a day at midnight UTC. */
export function cronEvery(seconds: number): string {
  if (!isEvenCadence(seconds)) throw new Error(`${seconds} s is no even cadence: whole minutes that divide an hour, or whole hours that divide a day`)
  const minutes = seconds / 60
  if (minutes < MINUTES_IN_AN_HOUR) return minutes === 1 ? "* * * * *" : `*/${minutes} * * * *`
  const hours = minutes / MINUTES_IN_AN_HOUR
  return hours === 1 ? "0 * * * *" : hours === HOURS_IN_A_DAY ? "0 0 * * *" : `0 */${hours} * * *`
}

/** What the environment says of a cadence it refuses. */
export const EVEN_CADENCE = "must be whole minutes that divide an hour (60, 120, 300, 900, 1800…) or whole hours that divide a day (3600, 7200, 21600…), in seconds"
