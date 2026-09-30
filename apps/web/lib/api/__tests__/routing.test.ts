// The routing calls (#173) against a scripted `fetch`: each asks the path
// and method the API answers, the preview's body is the one its contract
// takes, and an answer comes back as the API wrote it.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { RoutingPreviewRequest } from "@waste/contracts/routing-preview"

import { optimiseRoute, planDetail, previewRoad, routingQuota } from "../routing"
import { bodyOf, clientOver, json, scripted } from "./scripted-fetch"

const PLAN = "01a0d3a5-e5e0-7000-8000-000000000011"
const ROUTE = "01a0d3a5-e5e0-7000-8000-000000000012"

describe("the routing calls", () => {
  test("the preview posts the points in order, a body its contract takes, and answers what the API said", async () => {
    const answer = { basis: "estimate", provider: "openrouteservice", resumesAt: "2026-10-01T03:00:00.000Z", reason: "the routing provider's directions quota is spent" }
    const { fetch, calls } = scripted([() => json(answer)])
    const points: [number, number][] = [
      [12.5683, 55.6761],
      [12.61, 55.71],
    ]
    assert.deepEqual(await previewRoad(clientOver(fetch), points), answer)
    assert.equal(calls[0].url, "http://api.test/routing/preview")
    assert.equal(calls[0].init.method, "POST")
    assert.deepEqual(RoutingPreviewRequest.parse(bodyOf(calls[0])), { points })
  })

  test("the preview hands its signal to the request, so a road nobody holds any more is not waited for", async () => {
    const controller = new AbortController()
    const { fetch, calls } = scripted([() => json({ basis: "road", provider: "fake", legs: [], distanceMetres: 0, durationSeconds: 0 })])
    await previewRoad(clientOver(fetch), [[12.5, 55.7], [12.6, 55.7]], controller.signal)
    assert.equal(calls[0].init.signal, controller.signal)
  })

  test("the quota, a Plan and the optimise door ask the paths the API answers", async () => {
    const { fetch, calls } = scripted([() => json({ provider: "fake", families: [] }), () => json({ id: PLAN, legs: [] }), () => json({ id: PLAN, fallback: null }, 202)])
    const client = clientOver(fetch)
    assert.deepEqual(await routingQuota(client), { provider: "fake", families: [] })
    await planDetail(client, PLAN)
    await optimiseRoute(client, ROUTE)
    assert.deepEqual(
      calls.map((call) => `${call.init.method} ${call.url}`),
      [`GET http://api.test/routing/quota`, `GET http://api.test/plans/${PLAN}`, `POST http://api.test/routes/${ROUTE}/optimise`],
    )
    assert.equal(calls[2].init.body, undefined, "optimise takes no body")
  })
})
