import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../../prototype-record"
import { serviceAreasForSelection } from "../coverage"

function record(id: string, facts: Record<string, string> = {}, extra: Partial<BusinessRecord> = {}): BusinessRecord {
  return {
    id,
    name: id,
    context: "",
    status: "Available",
    owner: "",
    value: "",
    updated: "",
    description: "",
    facts,
    related: [],
    source: "",
    freshness: "",
    ...extra,
  }
}

const containers = [
  record("a", { "Planning area": "Østerbro Zone 2", "Route scheme": "Østerbro Organic B", "Next collection": "18 Sep 2026" }, { submittedValues: { planningAreaId: "area-osterbro-contract" } }),
  record("b", { "Planning area": "Østerbro Zone 2", "Route scheme": "Østerbro Organic B", "Next collection": "17 Sep 2026" }, { submittedValues: { planningAreaId: "area-osterbro-contract" } }),
  // Legacy shape: the display fact only.
  record("c", { "Planning area": "Amager Zone 1", "Route scheme": "RS-Central · Week A", "Next collection": "Not scheduled" }),
  record("d", { "Planning area": "Indre By Operations", "Route scheme": "—" }, { submittedValues: { planningAreaId: "area-indreby" } }),
]

const serviceAreas = [
  record("sa-osterbro", { "Service provider": "NordRen ApS", Services: "Organic · paper" }, {
    name: "CA-Ø-2 · Østerbro",
    status: "Active",
    submittedValues: { zoneIds: "area-osterbro-contract" },
    relationRefs: [{ fieldId: "zoneIds", workspaceId: "configure", moduleId: "areas", recordId: "area-osterbro-contract", label: "Østerbro Zone 2" }],
  }),
  record("sa-amager", { "Service provider": "CityHaul A/S", Services: "Glass · mixed" }, {
    name: "CA-AM-1 · Amager",
    status: "Expiring",
    submittedValues: { zoneIds: "area-amager-1" },
    relationRefs: [{ fieldId: "zoneIds", workspaceId: "configure", moduleId: "areas", recordId: "area-amager-1", label: "Amager Zone 1" }],
  }),
  record("sa-gone", {}, { name: "Gone", submittedValues: { zoneIds: "area-indreby" }, facts: { "Registry visibility": "Soft deleted" } }),
]

describe("serviceAreasForSelection", () => {
  test("lists the service areas whose zones hold the selected containers, busiest first", () => {
    const areas = serviceAreasForSelection(containers, serviceAreas)
    assert.deepEqual(
      areas.map((area) => [area.name, area.serviceProvider, area.status, area.containers]),
      [
        ["CA-Ø-2 · Østerbro", "NordRen ApS", "Active", 2],
        ["CA-AM-1 · Amager", "CityHaul A/S", "Expiring", 1],
      ],
    )
    assert.equal(areas[0].services, "Organic · paper")
  })

  test("nothing selected, nothing covered", () => {
    assert.deepEqual(serviceAreasForSelection([], serviceAreas), [])
  })
})

describe("serviceAreasForSelection with a drawn boundary", () => {
  test("a container inside a service area's stored polygon counts as covered without any planning-area link", () => {
    const copenhagen = [
      { lng: 12.4, lat: 55.6 },
      { lng: 12.7, lat: 55.6 },
      { lng: 12.7, lat: 55.75 },
      { lng: 12.4, lat: 55.75 },
    ]
    const drawn = record(
      "sa-drawn",
      { "Service provider": "CityHaul", Services: "Residual" },
      { name: "CA-Drawn", submittedValues: { boundaryPolygon: JSON.stringify(copenhagen) } },
    )
    const located = record("loc", { Address: "Parkvej 18, 2100 Copenhagen Ø", "Planning area": "Nowhere Zone" })
    const unlocated = record("unloc", { "Planning area": "Nowhere Zone" })
    const rows = serviceAreasForSelection([located, unlocated], [drawn])
    assert.deepEqual(rows.map((row) => [row.id, row.containers]), [["sa-drawn", 1]])
  })
})
