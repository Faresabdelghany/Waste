import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { ID_RANDOM_BYTES, MAX_UNIX_MILLIS, mintId, nextId } from "../ids"

/**
 * The shape RFC 9562 prints: 8-4-4-4-12 lowercase hex, `7` where the version
 * nibble goes and one of `8 9 a b` where the variant bits go. The contracts'
 * `Id` is the same check on the wire; the domain may not import it (the purity
 * gate), so an API test parses a minted id with it.
 */
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** The 48 bits the id leads with, back as milliseconds. */
const millisOf = (id: string) => parseInt(id.slice(0, 8) + id.slice(9, 13), 16)

const bytes = (fill: number) => new Uint8Array(ID_RANDOM_BYTES).fill(fill)

describe("mintId", () => {
  test("lays the clock out big-endian in the first 48 bits, and says so in both directions", () => {
    const at = Date.UTC(2026, 8, 24, 13, 41, 0)
    const id = mintId(at, bytes(0))
    assert.match(id, UUID_V7)
    assert.equal(millisOf(id), at)
    assert.equal(id.slice(0, 13), "01a0d3a5-e5e0")
    assert.equal(millisOf(mintId(0, bytes(0))), 0)
    assert.equal(millisOf(mintId(MAX_UNIX_MILLIS, bytes(0))), MAX_UNIX_MILLIS)
    assert.equal(mintId(MAX_UNIX_MILLIS, bytes(0)).slice(0, 13), "ffffffff-ffff")
  })

  test("sets the version nibble to 7 and the variant bits to 10, whatever the random bytes say", () => {
    for (const fill of [0x00, 0x0f, 0x55, 0xaa, 0xff]) {
      const id = mintId(1, bytes(fill))
      assert.match(id, UUID_V7, `fill ${fill}`)
      assert.equal(id[14], "7", `fill ${fill}: the version nibble`)
      assert.ok("89ab".includes(id[19]), `fill ${fill}: the variant bits`)
    }
  })

  test("keeps every other bit of the random bytes exactly as given", () => {
    const random = Uint8Array.from([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0xfe, 0xdc])
    // Bytes 6..15: the version nibble replaces the high nibble of the first,
    // the variant bits the top two of the third; nothing else moves.
    assert.equal(mintId(0, random), "00000000-0000-7123-8567-89abcdeffedc")
  })

  test("is lowercase", () => {
    const id = mintId(Date.UTC(2026, 8, 24), bytes(0xab))
    assert.equal(id, id.toLowerCase())
  })

  test("refuses a clock that is not a whole, non-negative number of milliseconds inside 48 bits", () => {
    for (const at of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, MAX_UNIX_MILLIS + 1]) {
      assert.throws(() => mintId(at, bytes(0)), /millisecond/i, String(at))
    }
  })

  test("refuses random input of the wrong length", () => {
    assert.equal(ID_RANDOM_BYTES, 10)
    for (const length of [0, 9, 11, 16]) {
      assert.throws(() => mintId(0, new Uint8Array(length)), /10 random bytes/, `${length} bytes`)
    }
  })
})

describe("nextId", () => {
  const at = Date.UTC(2026, 8, 24, 13, 41, 0)

  test("mints afresh when the clock has moved on", () => {
    const previous = mintId(at, bytes(0xff))
    const later = nextId(previous, at + 1, bytes(0x00))
    assert.equal(millisOf(later), at + 1)
    assert.equal(later, mintId(at + 1, bytes(0x00)), "the fresh id is mintId's, random bytes and all")
    assert.ok(later > previous)
  })

  test("counts the random field up when the clock has not moved, and keeps the timestamp", () => {
    const previous = mintId(at, bytes(0x00))
    const next = nextId(previous, at, bytes(0xff))
    assert.equal(next, "01a0d3a5-e5e0-7000-8000-000000000001")
    assert.equal(millisOf(next), at, "the same millisecond")
    assert.ok(next > previous)
    assert.match(next, UUID_V7)
  })

  test("counts up a clock that ran backwards too: an id is never smaller than the one before it", () => {
    const previous = mintId(at, bytes(0x00))
    const next = nextId(previous, at - 5_000, bytes(0xff))
    assert.ok(next > previous)
    assert.equal(millisOf(next), at)
  })

  test("carries across the random field's bytes, over the variant bits and into the timestamp when it is full", () => {
    // Every random bit set: the counter has nowhere to go but the clock, and
    // the version and variant bits are not part of the count.
    const full = mintId(at, bytes(0xff))
    assert.equal(full, "01a0d3a5-e5e0-7fff-bfff-ffffffffffff")
    const carried = nextId(full, at, bytes(0x00))
    assert.equal(carried, "01a0d3a5-e5e1-7000-8000-000000000000")
    assert.ok(carried > full)
    // A byte boundary, and the six bits under the variant.
    assert.equal(nextId("01a0d3a5-e5e0-7000-8000-0000000000ff", at, bytes(0)), "01a0d3a5-e5e0-7000-8000-000000000100")
    assert.equal(nextId("01a0d3a5-e5e0-7000-bfff-ffffffffffff", at, bytes(0)), "01a0d3a5-e5e0-7001-8000-000000000000")
  })

  test("refuses anything that is not a version 7 id, and an impossible clock", () => {
    for (const previous of ["", "nonsense", "01a0d3a5-e5e0-4000-8000-000000000000", "01a0d3a5-e5e0-7000-c000-000000000000", "01a0c9e51a807000800000000000000"]) {
      assert.throws(() => nextId(previous, at, bytes(0)), /version 7/, JSON.stringify(previous))
    }
    assert.throws(() => nextId(mintId(at, bytes(0)), -1, bytes(0)), /millisecond/i)
    assert.throws(() => nextId(mintId(at, bytes(0)), at, new Uint8Array(4)), /10 random bytes/)
  })

  test("an uppercase id is read and answered in lowercase", () => {
    assert.equal(nextId("01A0D3A5-E5E0-7000-8000-000000000000", at, bytes(0)), "01a0d3a5-e5e0-7000-8000-000000000001")
  })

  test("a million ids on one fixed clock are strictly increasing and all distinct", () => {
    const seen = new Set<string>()
    let previous = mintId(at, bytes(0x00))
    seen.add(previous)
    for (let i = 0; i < 1_000_000; i += 1) {
      const next = nextId(previous, at, bytes(0x00))
      if (!(next > previous)) assert.fail(`id ${i} did not grow: ${previous} → ${next}`)
      previous = next
      seen.add(next)
    }
    assert.equal(seen.size, 1_000_001)
    assert.match(previous, UUID_V7)
    assert.equal(millisOf(previous), at, "a million ids fit in one millisecond's random field")
  })
})
