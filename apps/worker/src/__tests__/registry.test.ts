// The registry held to what the wiring assumes of it, without a database:
// every queue named once and spelled the way pg-boss accepts a queue name,
// every cron expression one pg-boss's scheduler parses, every scheduled job
// carrying the data its occurrences send, every job saying what it is for.
// A job file that breaks one of these fails here, where the message names
// the job, and not at the worker's start().
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { isCronExpression } from "../boss"
import { defineJob, JOBS } from "../jobs"
import { heartbeat } from "../jobs/heartbeat"

describe("the job registry", () => {
  test("names every queue once", () => {
    const queues = JOBS.map((job) => job.queue)
    assert.deepEqual([...new Set(queues)], queues)
    assert.ok(queues.length >= 1, "at least the heartbeat")
  })

  test("spells every queue <context>.<verb>, in pg-boss's alphabet: letters, digits, underscore, hyphen, period", () => {
    for (const job of JOBS) {
      assert.match(job.queue, /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/, job.queue)
    }
  })

  test("gives every job a description and a handler", () => {
    for (const job of JOBS) {
      assert.ok(job.description.length > 0, job.queue)
      assert.equal(typeof job.handler, "function", job.queue)
    }
  })

  test("schedules on cron expressions pg-boss accepts, each with its data", () => {
    for (const job of JOBS) {
      if (job.schedule === undefined) continue
      assert.ok(isCronExpression(job.schedule), `${job.queue}: "${job.schedule}" is not a cron expression pg-boss accepts`)
      assert.notEqual(job.scheduleData, undefined, `${job.queue}: a scheduled job says what its occurrences carry`)
    }
  })

  test("holds the heartbeat: every minute, UTC, no retry, kept a day, sent as the schedule's", () => {
    assert.ok(JOBS.includes(heartbeat))
    assert.equal(heartbeat.queue, "worker.heartbeat")
    assert.equal(heartbeat.schedule, "* * * * *")
    assert.deepEqual(heartbeat.scheduleData, { source: "schedule" })
    assert.deepEqual(heartbeat.scheduleOptions, { tz: "UTC", missed: "skip" })
    assert.deepEqual(heartbeat.queueOptions, { retryLimit: 0, deleteAfterSeconds: 86_400 })
  })
})

describe("isCronExpression", () => {
  test("accepts five-field cron and refuses the rest, without dialling anything", () => {
    for (const expression of ["* * * * *", "0 3 * * *", "*/5 * * * *", "30 2 1 * *", "0 0 * * 1-5"]) {
      assert.ok(isCronExpression(expression), expression)
    }
    for (const expression of ["", "not a cron", "61 * * * *", "* * * *", "0 3 * * * *"]) {
      assert.equal(isCronExpression(expression), false, expression)
    }
  })
})

describe("defineJob", () => {
  test("returns the definition it is given, typed by the handler's data", async () => {
    const lines: string[] = []
    const job = defineJob<{ n: number }>({
      queue: "test.echo",
      description: "Echoes.",
      handler: async (jobs, { log }) => {
        for (const item of jobs) log(`n=${item.data.n}`)
        return jobs.length
      },
    })
    assert.equal(job.queue, "test.echo")
    const context = { log: (line: string) => void lines.push(line) } as unknown as Parameters<typeof job.handler>[1]
    assert.equal(await job.handler([{ id: "1", name: "test.echo", data: { n: 7 }, expireInSeconds: 1, heartbeatSeconds: null, signal: AbortSignal.abort() }], context), 1)
    assert.deepEqual(lines, ["n=7"])
  })
})
