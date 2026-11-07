import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { MESSAGE_TOO_LONG, ROUTE_MESSAGE_BODY_MAX, SAY_SOMETHING } from "@waste/domain/execution/route-messages"

import { draftRefusal, messageLine } from "../records/route-messages"

describe("a route's messages in its details (O24 of #290)", () => {
  test("a draft is refused empty or past the bound, as the API would", () => {
    assert.equal(draftRefusal("   "), SAY_SOMETHING)
    assert.equal(draftRefusal("x".repeat(ROUTE_MESSAGE_BODY_MAX + 1)), MESSAGE_TOO_LONG)
    assert.equal(draftRefusal(" Gate code 4711 "), null)
  })

  test("a line names the driver as the driver, on the project's clock", () => {
    const message = { id: "m", projectId: "p", routeId: "r", author: "driver", sentBy: "u", senderName: "Mads Jensen", driverId: "d", body: "On my way", recordedAt: "2026-10-05T05:30:00.000Z" } as const
    assert.deepEqual(messageLine(message, "Europe/Copenhagen"), { who: "Mads Jensen (driver)", when: "2026-10-05 07:30", body: "On my way", fromDriver: true })
    assert.equal(messageLine({ ...message, author: "office", senderName: "Olivia Larsen", driverId: null }, "Europe/Copenhagen").who, "Olivia Larsen")
  })
})
