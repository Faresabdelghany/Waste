import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { ROUTE_MESSAGE_BODY_MAX } from "@waste/contracts/route-messages"

import { draftRefusal, messageLine, ROUTE_MESSAGE_MAX } from "../records/route-messages"

describe("a route's messages in its details (O24 of #290)", () => {
  test("the bound is the contracts', spelled again", () => {
    assert.equal(ROUTE_MESSAGE_MAX, ROUTE_MESSAGE_BODY_MAX)
  })

  test("a draft is refused empty or past the bound, as the API would", () => {
    assert.equal(draftRefusal("   "), "Say something")
    assert.equal(draftRefusal("x".repeat(ROUTE_MESSAGE_MAX + 1)), `A message is at most ${ROUTE_MESSAGE_MAX} characters`)
    assert.equal(draftRefusal(" Gate code 4711 "), null)
  })

  test("a line names the driver as the driver, on the project's clock", () => {
    const message = { id: "m", projectId: "p", routeId: "r", author: "driver", sentBy: "u", senderName: "Mads Jensen", driverId: "d", body: "On my way", recordedAt: "2026-10-05T05:30:00.000Z" } as const
    assert.deepEqual(messageLine(message, "Europe/Copenhagen"), { who: "Mads Jensen (driver)", when: "2026-10-05 07:30", body: "On my way", fromDriver: true })
    assert.equal(messageLine({ ...message, author: "office", senderName: "Olivia Larsen", driverId: null }, "Europe/Copenhagen").who, "Olivia Larsen")
  })
})
