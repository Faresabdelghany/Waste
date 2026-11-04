import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { DriverRouteMessageCreate, ROUTE_MESSAGE_BODY_MAX } from "@waste/contracts/route-messages"

import { authorLine, DRIVER_MESSAGE_MAX, mintMessageId, sendable } from "../route-messages"

describe("a route's messages on the Driver App (O24 of #290)", () => {
  test("the bound is the contracts', spelled again", () => {
    assert.equal(DRIVER_MESSAGE_MAX, ROUTE_MESSAGE_BODY_MAX)
  })

  test("a message's id is minted on the device as the API takes it", () => {
    const id = mintMessageId(Date.UTC(2026, 9, 29, 6, 0), (bytes) => bytes.fill(7))
    assert.ok(DriverRouteMessageCreate.safeParse({ id, body: "Running late" }).success, id)
    assert.notEqual(mintMessageId(), mintMessageId())
  })

  test("a text is sent when it says something within the bound, and the thread names the office's and the driver's own", () => {
    assert.equal(sendable("   "), false)
    assert.equal(sendable("x".repeat(DRIVER_MESSAGE_MAX + 1)), false)
    assert.equal(sendable(" On my way "), true)
    assert.equal(authorLine({ author: "driver", senderName: "Mads Jensen" }), "You")
    assert.equal(authorLine({ author: "office", senderName: "Olivia Larsen" }), "Office · Olivia Larsen")
  })
})
