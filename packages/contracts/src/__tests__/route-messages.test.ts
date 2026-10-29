// Route Messages on the wire (O24 of #290): a body trimmed and bounded, the
// office's without an id, the driver's with the one their device minted.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { DriverRouteMessageCreate, ROUTE_MESSAGE_BODY_MAX, RouteMessageCreate } from "../route-messages"
import { refusal } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"

describe("a route message", () => {
  test("is a body of a few words, trimmed, never empty, never past the bound", () => {
    assert.deepEqual(RouteMessageCreate.parse({ body: "  Gate code is 4711  " }), { body: "Gate code is 4711" })
    assert.deepEqual(refusal(RouteMessageCreate.safeParse({ body: "   " })), [{ path: "body", message: "Say something" }])
    assert.deepEqual(refusal(RouteMessageCreate.safeParse({ body: "x".repeat(ROUTE_MESSAGE_BODY_MAX + 1) })), [{ path: "body", message: `A message is at most ${ROUTE_MESSAGE_BODY_MAX} characters` }])
  })

  test("is the office's without an id and the driver's with the one their device minted", () => {
    assert.equal(RouteMessageCreate.safeParse({ id: ID, body: "Hi" }).success, false, "the server mints the office's")
    assert.deepEqual(DriverRouteMessageCreate.parse({ id: ID, body: "Running late" }), { id: ID, body: "Running late" })
    assert.deepEqual(refusal(DriverRouteMessageCreate.safeParse({ body: "Running late" })).map(({ path }) => path), ["id"])
  })
})
