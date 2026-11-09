// What a property's details ask the client themselves: the paths its zones
// (O29 of #290) and a place's Pickup Exceptions (M5 of #293) are read under,
// each answered as the one row its section reads.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { PickupExceptionHistory, type PickupException } from "@waste/contracts/pickup-exceptions"
import { PlanningAreasAt, type PlanningArea } from "@waste/contracts/planning-areas"

import type { ApiClient } from "../client"
import { placePickupExceptions, propertyZones } from "../property-details"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const FEE = "01a0d3a5-e5e0-7000-8000-0000000000f1"
const RULE = "01a0d3a5-e5e0-7000-8000-0000000000a1"
const STAMP = "2026-01-01T00:00:00.000Z"

const zone = (code: string, name: string): PlanningArea => ({ id: ID, projectId: ID, code, name, purpose: "notification", createdAt: STAMP, updatedAt: STAMP })

const item = (): PickupException => ({
  pickupId: ID,
  routeId: ID,
  projectId: ID,
  serviceDate: "2026-03-04",
  status: "skipped",
  reason: "contamination",
  contaminantCodeId: null,
  origin: "generation",
  service: "empty",
  propertyId: ID,
  sharedCollectionPointId: null,
  evidenceProofId: null,
  judgement: { ruleId: RULE, index: 1, free: false, productId: FEE },
})

describe("a property's zones", () => {
  test("are read from the property's zones and answered as one row", async () => {
    const asked: string[] = []
    const answer: PlanningAreasAt = { on: "2026-05-15", purpose: "notification", items: [zone("Z-CITY", "City")] }
    const client: ApiClient = {
      baseUrl: "http://api.test",
      token: "t",
      fetch: (async (url: string | URL | Request) => {
        asked.push(String(url))
        return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } })
      }) as typeof fetch,
    }
    assert.deepEqual(await propertyZones(client, ID), [answer])
    assert.deepEqual(asked.map((url) => new URL(url).pathname), [`/properties/${ID}/zones`])
    assert.equal(PlanningAreasAt.safeParse(answer).success, true)
  })
})

describe("a place's Pickup Exceptions", () => {
  test("asks the property's and the shared point's history under their own paths, and answers it as one row", async () => {
    const asked: string[] = []
    const history: PickupExceptionHistory = { items: [item()], truncated: false }
    const client: ApiClient = {
      baseUrl: "http://api.test",
      token: "t",
      fetch: (async (url: string | URL | Request) => {
        asked.push(String(url))
        return new Response(JSON.stringify(history), { status: 200, headers: { "content-type": "application/json" } })
      }) as typeof fetch,
    }
    assert.deepEqual(await placePickupExceptions("property")(client, ID), [history])
    await placePickupExceptions("shared-point")(client, ID)
    assert.deepEqual(asked.map((url) => new URL(url).pathname), [`/properties/${ID}/pickup-exceptions`, `/shared-collection-points/${ID}/pickup-exceptions`])
    assert.equal(PickupExceptionHistory.safeParse(history).success, true)
  })
})
