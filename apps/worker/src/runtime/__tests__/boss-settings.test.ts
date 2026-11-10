// The Pilot's knobs (#149, from #134's gate 2) applied to pg-boss's
// settings, as pure derivations: an interval is raised to the polling knob
// where pg-boss's own default polls more often, never lowered, and capped
// where pg-boss caps it; the supervise, queue-cache and idle-timeout knobs
// pass straight through; an option a caller names (a test's 1 s cron pass)
// wins over the knob. No knob set means pg-boss's defaults, untouched.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { bossIntervals, workOptionsUnder } from "../boss"

describe("bossIntervals", () => {
  test("names nothing when no knob and no option is set: pg-boss's defaults stand", () => {
    assert.deepEqual(bossIntervals({}), {})
  })

  test("raises pg-boss's cron pass (30), cron worker (5) and flow poll (5) to the polling knob where they poll more often, the cron two capped at pg-boss's 45", () => {
    assert.deepEqual(bossIntervals({ pollingIntervalSeconds: 30 }), { cronMonitorIntervalSeconds: 30, cronWorkerIntervalSeconds: 30, flowIntervalSeconds: 30 })
    assert.deepEqual(bossIntervals({ pollingIntervalSeconds: 60 }), { cronMonitorIntervalSeconds: 45, cronWorkerIntervalSeconds: 45, flowIntervalSeconds: 60 })
  })

  test("never lowers an interval below pg-boss's default", () => {
    assert.deepEqual(bossIntervals({ pollingIntervalSeconds: 1 }), { cronMonitorIntervalSeconds: 30, cronWorkerIntervalSeconds: 5, flowIntervalSeconds: 5 })
  })

  test("an interval a caller names wins over the knob, the others still follow it", () => {
    assert.deepEqual(bossIntervals({ pollingIntervalSeconds: 30, cronWorkerIntervalSeconds: 1, cronMonitorIntervalSeconds: 1 }), { cronMonitorIntervalSeconds: 1, cronWorkerIntervalSeconds: 1, flowIntervalSeconds: 30 })
  })

  test("the supervise knob sets pg-boss's supervise pass and, unless the monitor interval is named, its monitor pass with it; the queue-cache knob its cache refresh", () => {
    assert.deepEqual(bossIntervals({ superviseIntervalSeconds: 300 }), { superviseIntervalSeconds: 300, monitorIntervalSeconds: 300 })
    assert.deepEqual(bossIntervals({ superviseIntervalSeconds: 300, monitorIntervalSeconds: 1 }), { superviseIntervalSeconds: 300, monitorIntervalSeconds: 1 })
    assert.deepEqual(bossIntervals({ monitorIntervalSeconds: 1 }), { monitorIntervalSeconds: 1 })
    assert.deepEqual(bossIntervals({ queueCacheIntervalSeconds: 300 }), { queueCacheIntervalSeconds: 300 })
  })

  test("the idle-timeout knob is pg-pool's idleTimeoutMillis, in milliseconds, 0 meaning never", () => {
    assert.deepEqual(bossIntervals({ idleTimeoutSeconds: 600 }), { idleTimeoutMillis: 600_000 })
    assert.deepEqual(bossIntervals({ idleTimeoutSeconds: 0 }), { idleTimeoutMillis: 0 })
  })
})

describe("workOptionsUnder", () => {
  test("leaves a job's work options alone without the knob", () => {
    assert.deepEqual(workOptionsUnder(undefined, undefined), {})
    assert.deepEqual(workOptionsUnder({ pollingIntervalSeconds: 1, batchSize: 5 }, undefined), { pollingIntervalSeconds: 1, batchSize: 5 })
  })

  test("raises a queue's poll to the knob — pg-boss's 2 s where the job names none, the relay's 1 s — and keeps a poll already longer", () => {
    assert.deepEqual(workOptionsUnder(undefined, 30), { pollingIntervalSeconds: 30 })
    assert.deepEqual(workOptionsUnder({ pollingIntervalSeconds: 1, batchSize: 5 }, 30), { pollingIntervalSeconds: 30, batchSize: 5 })
    assert.deepEqual(workOptionsUnder({ pollingIntervalSeconds: 60 }, 30), { pollingIntervalSeconds: 60 })
    assert.deepEqual(workOptionsUnder(undefined, 1), { pollingIntervalSeconds: 2 })
  })
})
