import { request } from "@playwright/test"

import { expect, test } from "./fixtures"
import { E2E } from "./env"

// Scenario 5: both processes are up against the stack the browser tests use.
// The worker's /readyz answering 200 proves pg-boss's schema (migration
// 0011), the wms_worker login, the migrations and the worker's composition
// boot on this database, before any generation scenario exists; the API's
// proves its pool. The CI job waits for both before Playwright starts, so
// here the answers are read for what they say.
test("the API and the worker answer ready on the stack", async () => {
  const probes = await request.newContext()
  try {
    const api = await probes.get(`${E2E.apiUrl}/readyz`)
    expect(api.status()).toBe(200)
    expect(await api.json()).toMatchObject({ status: "ok", checks: { database: "ok" } })
    expect(api.headers()["cache-control"]).toBe("no-store")

    const worker = await probes.get(`${E2E.workerUrl}/readyz`)
    expect(worker.status()).toBe(200)
    const body = (await worker.json()) as { status: string; checks: { database: string; boss: string }; failedJobs: number }
    expect(body).toMatchObject({ status: "ok", checks: { database: "ok", boss: "ok" } })
    expect(body.failedJobs).toBe(0)
  } finally {
    await probes.dispose()
  }
})
