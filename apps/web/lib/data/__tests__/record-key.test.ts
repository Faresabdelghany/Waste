// What a record's details show as its key (#261): the prototype's own
// reference, never a handle — the adapter's id or one minted this session.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { readableKey } from "../record-key"

describe("readableKey", () => {
  test("is the prototype's own reference, as fixture mode shows it", () => {
    for (const id of ["route-1042", "scheme-central-weekly", "agreement-2408", "T-8831"]) assert.equal(readableKey(id), id)
  })

  test("is nothing for a handle: the adapter's id, or one the workspace minted this session", () => {
    for (const id of [
      "scheme-01a16adc-606b-763e-a8bf-8bec45516ce6",
      "schemes-route-scheme-1792809048385",
      "operate-alert-1792809048385",
      "settlements-settlement-1792809048385",
      "access-user-5f0c2a0e-9a3b-4c1d-8e2f-1a2b3c4d5e6f",
      "access-user-1792809048385-k3j9x2a",
    ]) {
      assert.equal(readableKey(id), undefined, id)
    }
  })
})
