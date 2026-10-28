// Settings › Integrations on the Pilot (#487): each service the deployment
// calls in a sentence — the routing provider and its quota, the address
// register or none, Storage set up or not — and the latest CSV import, never
// a vendor the deployment does not call.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { ImportRun } from "@waste/contracts/imports"
import type { Integrations } from "@waste/contracts/integrations"
import type { RoutingQuota } from "@waste/contracts/routing-quota"

import { importRow, integrationRowsOf } from "../integrations"

const NOW = new Date("2026-10-28T10:00:00Z")
const CONNECTED: Integrations = { routing: { provider: "openrouteservice" }, addressRegister: { provider: "dataforsyningen" }, proofStorage: { configured: true } }
const BARE: Integrations = { routing: { provider: "fake" }, addressRegister: null, proofStorage: { configured: false } }

const quota = (overrides: Partial<RoutingQuota["families"][number]> = {}): RoutingQuota => ({
  provider: "openrouteservice",
  families: [{ family: "directions", remaining: 1800, limit: 2000, resetAt: "2026-10-29T00:00:00Z", exhaustedAt: null, keyRefusedAt: null, updatedAt: "2026-10-28T09:00:00Z", ...overrides }],
})

const states = (integrations: Integrations, read: RoutingQuota | null = null) =>
  integrationRowsOf({ integrations, quota: read, now: NOW }).map((row) => [row.name, row.state, row.tone])

describe("the deployment's connections", () => {
  test("a deployment connected to all three says so, the quota read beside the provider", () => {
    assert.deepEqual(states(CONNECTED, quota()), [
      ["Routing · openrouteservice", "Connected · quota available", "healthy"],
      ["Danish Address Register (DAR) · Dataforsyningen", "Connected", "healthy"],
      ["Proof storage · Supabase Storage", "Connected", "healthy"],
    ])
  })

  test("a deployment that calls none says what that means for the office, never a vendor", () => {
    assert.deepEqual(states(BARE), [
      ["Routing · built-in estimate", "No provider · straight-line estimates", "neutral"],
      ["Address register", "Not set up · addresses are typed", "neutral"],
      ["Proof storage · Supabase Storage", "Not set up · photos and signatures are refused", "warning"],
    ])
  })

  test("the routing quota's key refused is a danger, its day spent a warning in the banner's own sentence", () => {
    assert.deepEqual(states(CONNECTED, quota({ keyRefusedAt: "2026-10-28T08:00:00Z" }))[0].slice(1), ["Routing unavailable: key refused", "danger"])
    const [, waiting, tone] = states(CONNECTED, quota({ exhaustedAt: "2026-10-28T08:00:00Z" }))[0]
    assert.match(waiting as string, /^Waiting for routing quota: /)
    assert.equal(tone, "warning")
  })
})

describe("the latest CSV import", () => {
  const run = (counts: ImportRun["counts"], rowCount = 10): ImportRun => ({
    id: "0199a000-0000-7000-8000-000000000001",
    createdAt: "2026-10-28T09:00:00Z",
    updatedAt: "2026-10-28T09:00:00Z",
    kind: "customers",
    projectId: null,
    fileName: "customers.csv",
    rowCount,
    counts,
    status: "completed",
    requestedBy: "0199a000-0000-7000-8000-0000000000aa",
  })

  test("none yet, every row imported, some refused, and a run not yet complete", () => {
    assert.deepEqual([importRow(null).state, importRow(null).tone], ["No import yet", "neutral"])
    assert.deepEqual([importRow(run({ created: 6, updated: 2, unchanged: 2, refused: 0 })).state, importRow(run({ created: 6, updated: 2, unchanged: 2, refused: 0 })).tone], ["customers.csv · 10 rows imported", "healthy"])
    assert.deepEqual([importRow(run({ created: 6, updated: 0, unchanged: 0, refused: 4 })).state, importRow(run({ created: 6, updated: 0, unchanged: 0, refused: 4 })).tone], ["customers.csv · 4 of 10 rows refused", "warning"])
    assert.equal(importRow(run({ created: 3, updated: 0, unchanged: 0, refused: 0 })).state, "customers.csv · 3 of 10 rows recorded")
  })
})
