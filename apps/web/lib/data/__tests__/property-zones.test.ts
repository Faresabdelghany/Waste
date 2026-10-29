// A property's zones as its details read them (O29 of #290, row 1.13): the
// path they are read under, the grant that reads them, and the sentence they
// are told in.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { PlanningAreasAt, type PlanningArea } from "@waste/contracts/planning-areas"

import type { ApiClient } from "../../api/client"
import { propertyZones, zonesReadable, zonesSentence } from "../property-zones"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const STAMP = "2026-01-01T00:00:00.000Z"

const zone = (code: string, name: string): PlanningArea => ({ id: ID, projectId: ID, code, name, purpose: "notification", createdAt: STAMP, updatedAt: STAMP })

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

  test("are the role's where it views the properties", () => {
    assert.equal(zonesReadable([{ moduleKey: "customers.properties", actions: ["view"] }]), true)
    assert.equal(zonesReadable([{ moduleKey: "configure.areas", actions: ["view"] }]), false, "the areas' grant alone does not read a property's")
    assert.equal(zonesReadable(undefined), false)
  })

  test("are told by name and code, one or several, or why there are none", () => {
    const on = "2026-05-15"
    assert.equal(zonesSentence({ on, items: [zone("Z-CITY", "City")] }, true), "Notification zone on 2026-05-15: City (Z-CITY).")
    assert.equal(zonesSentence({ on, items: [zone("Z-CITY", "City"), zone("Z-DISTRICT", "District")] }, true), "Notification zones on 2026-05-15: City (Z-CITY), District (Z-DISTRICT).")
    assert.equal(zonesSentence({ on, items: [] }, true), "No notification zone holds this property on 2026-05-15.")
    assert.equal(zonesSentence({ on, items: [] }, false), "No point yet: place the property to read its notification zone.")
  })
})
