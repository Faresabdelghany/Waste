// The one job this skeleton ships: the proof the wiring works, end to end. A
// heartbeat is scheduled every minute, handled by writing one line with the
// process's clock and the count pg-boss handed it, and its rows then show in
// pg-boss's tables like any other job's — completed within the minute, or
// failed and counted on /readyz. Nothing of the domain is touched: the
// context's pools go unused here, on purpose, and the first real job
// (Planning's generation, #97 part B) is the one that shows the fenced write.
//
// Every minute, not every few seconds: pg-boss's cron pass runs once a minute
// and a job is retained seven days once done, so a faster beat would only
// fill the table. The retry policy is none — a heartbeat that failed is not
// worth a second try, and a failed row is exactly what the readiness count is
// for. `missed: "skip"` (pg-boss's default, restated) means a worker that was
// down for an hour beats once when it is back, not sixty times.
import { defineJob } from "./definition"

export type HeartbeatData = {
  /** Where the beat came from: the schedule, or a caller who sent one by hand. */
  source: "schedule" | "manual"
}

export const heartbeat = defineJob<HeartbeatData>({
  queue: "worker.heartbeat",
  description: "Beats once a minute, so a stopped worker is a schedule that stopped firing and a broken one a queue that fails.",
  schedule: "* * * * *",
  scheduleData: { source: "schedule" },
  scheduleOptions: { tz: "UTC", missed: "skip" },
  queueOptions: { retryLimit: 0, deleteAfterSeconds: 60 * 60 * 24 },
  handler: async (jobs, { now, log }) => {
    for (const job of jobs) {
      log(`worker.heartbeat: ${now().toISOString()} (${job.data.source}, job ${job.id})`)
    }
    // PROTOTYPE (#134 gate 4): the self-ping of #128 Q4 — each beat fetches KEEP_ALIVE_URL's /readyz when set, so the prototype can see whether Render counts it as inbound traffic. #149 writes it properly.
    const keepAlive = process.env.KEEP_ALIVE_URL
    if (keepAlive) {
      const started = Date.now()
      try {
        const response = await fetch(`${keepAlive}/readyz`, { signal: AbortSignal.timeout(10_000) })
        await response.text()
        log(`worker.heartbeat: keep-alive ${response.status} in ${Date.now() - started} ms`)
      } catch (error) {
        log(`worker.heartbeat: keep-alive failed after ${Date.now() - started} ms: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { beats: jobs.length }
  },
})
