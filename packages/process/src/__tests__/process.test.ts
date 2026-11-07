import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { withoutEmpty } from "../environment"
import { API_PORT, WORKER_PORT } from "../ports"
import { JOB_STOP_MS, KILL_AFTER_MS, POOL_END_MS, SHUTDOWN_GRACE_MS } from "../shutdown"

describe("the processes' facts", () => {
  test("the API on 3001 and the worker's probes one above it", () => {
    assert.deepEqual([API_PORT, WORKER_PORT], [3001, 3002])
  })

  test("the shutdown budget: five seconds for a listener's grace and a pool's end, ten for a job, and the supervisor's kill after twenty", () => {
    assert.deepEqual([SHUTDOWN_GRACE_MS, POOL_END_MS, JOB_STOP_MS, KILL_AFTER_MS], [5_000, 5_000, 10_000, 20_000])
  })

  test("a set-but-empty variable is not set", () => {
    assert.deepEqual(withoutEmpty({ HOST: "", PORT: "3001", PATH: undefined }), { PORT: "3001" })
  })
})
