import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { Id } from "@waste/contracts/ids"

import { createIdMinter, newId } from "../ids"

/** The 48 bits an id leads with, back as milliseconds. */
const millisOf = (id: string) => parseInt(id.slice(0, 8) + id.slice(9, 13), 16)

describe("newId", () => {
  test("mints an id the contracts accept, stamped with the clock it was minted at", () => {
    const before = Date.now()
    const id = newId()
    const after = Date.now()
    assert.equal(Id.parse(id), id, "a UUID version 7, lowercase")
    assert.ok(millisOf(id) >= before && millisOf(id) <= after, `${millisOf(id)} is not between ${before} and ${after}`)
  })

  test("never repeats itself and never goes backwards, however fast it is called", () => {
    const ids = Array.from({ length: 10_000 }, () => newId())
    for (let i = 1; i < ids.length; i += 1) {
      if (!(ids[i] > ids[i - 1])) assert.fail(`id ${i} did not grow: ${ids[i - 1]} → ${ids[i]}`)
    }
    assert.equal(new Set(ids).size, ids.length)
    for (const id of [ids[0], ids[ids.length - 1]]) assert.equal(Id.parse(id), id)
  })
})

describe("createIdMinter", () => {
  /** A clock and a randomness that give the minter nothing to work with. */
  const still = (millis: number) => createIdMinter(() => millis, (bytes) => bytes.fill(0))

  test("keeps the order even with a clock that never ticks and randomness that never changes", () => {
    const mint = still(Date.UTC(2026, 8, 24, 13, 41, 0))
    const ids = Array.from({ length: 1_000 }, () => mint())
    assert.deepEqual(ids, [...ids].sort(), "sorted as strings is the order they were minted in")
    assert.equal(new Set(ids).size, ids.length)
    assert.equal(ids[0], "01a0d3a5-e5e0-7000-8000-000000000000")
    assert.equal(ids[1], "01a0d3a5-e5e0-7000-8000-000000000001")
  })

  test("keeps the order across a clock that jumps backwards, as a host's clock does", () => {
    let millis = Date.UTC(2026, 8, 24, 13, 41, 0)
    const mint = createIdMinter(() => millis, (bytes) => bytes.fill(0))
    const first = mint()
    millis -= 60_000
    const second = mint()
    assert.ok(second > first, `${second} must be after ${first}`)
    assert.equal(Id.parse(second), second)
  })

  test("moves the id on with the clock when the clock moves", () => {
    let millis = Date.UTC(2026, 8, 24, 13, 41, 0)
    const mint = createIdMinter(() => millis, (bytes) => bytes.fill(0))
    const first = mint()
    millis += 1_000
    const second = mint()
    assert.equal(millisOf(second), millis)
    assert.ok(second > first)
  })

  test("two minters are two sequences: the process has one, and it is `newId`", () => {
    const at = Date.UTC(2026, 8, 24, 13, 41, 0)
    assert.equal(still(at)(), still(at)(), "each starts its own count")
    assert.notEqual(newId(), newId())
  })
})
