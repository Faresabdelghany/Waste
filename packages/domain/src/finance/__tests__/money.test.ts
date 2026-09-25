// Money in minor units and the one rounding: half away from zero, as
// Postgres's `round(numeric)` rounds, which packages/db's finance test holds
// the `_vat_shape` checks to by writing rows these cases computed.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { indexedFee, PAYMENT_TERMS_DAYS, roundHalfAwayFromZero, vatOf } from "../money"

/** Odd amounts of both signs at 25 %, with what Postgres's `round(net * 25 / 100.0)` answers for each. */
export const VAT_CASES: readonly [netMinor: number, vatPercent: number, vatMinor: number][] = [
  [0, 25, 0],
  [1, 25, 0],
  [2, 25, 1],
  [3, 25, 1],
  [6, 25, 2],
  [10, 25, 3],
  [14, 25, 4],
  [18, 25, 5],
  [-1, 25, 0],
  [-2, 25, -1],
  [-6, 25, -2],
  [-10, 25, -3],
  [-14, 25, -4],
  [-18, 25, -5],
  [12_345, 25, 3_086],
  [-12_345, 25, -3_086],
  [999, 7, 70],
  [-999, 7, -70],
  [1_000, 0, 0],
  [1_000, 100, 1_000],
  [2_500_000, 25, 625_000],
]

describe("roundHalfAwayFromZero", () => {
  test("rounds a half away from zero on both sides, and never answers -0", () => {
    assert.equal(roundHalfAwayFromZero(0.5), 1)
    assert.equal(roundHalfAwayFromZero(-0.5), -1)
    assert.equal(roundHalfAwayFromZero(1.5), 2)
    assert.equal(roundHalfAwayFromZero(-1.5), -2)
    assert.equal(roundHalfAwayFromZero(2.4), 2)
    assert.equal(roundHalfAwayFromZero(-2.4), -2)
    assert.ok(Object.is(roundHalfAwayFromZero(-0.4), 0), "a small negative rounds to 0, not -0")
    assert.ok(Object.is(roundHalfAwayFromZero(-0), 0))
    assert.equal(Math.round(-0.5), -0, "which is why Math.round alone would not do")
  })
})

describe("vatOf", () => {
  test("is round(net × percent / 100) half away from zero, over odd amounts of both signs: a reversal's VAT is its original's negated", () => {
    for (const [netMinor, vatPercent, vatMinor] of VAT_CASES) {
      assert.ok(Object.is(vatOf(netMinor, vatPercent), vatMinor), `${netMinor} at ${vatPercent} % gives ${vatOf(netMinor, vatPercent)}, not ${vatMinor}`)
    }
    for (const [netMinor, vatPercent] of VAT_CASES) assert.equal(vatOf(-netMinor, vatPercent), -vatOf(netMinor, vatPercent) || 0, `${netMinor}`)
  })

  test("takes whole numbers of minor units and whole percents, and refuses anything else as a bug", () => {
    assert.throws(() => vatOf(10.5, 25), /netMinor is 10.5; money is a whole number of minor units/)
    assert.throws(() => vatOf(10, 25.5), /vatPercent is 25.5; money is a whole number of minor units/)
    assert.throws(() => vatOf(Number.NaN, 25), /netMinor is NaN/)
  })
})

describe("indexedFee", () => {
  test("multiplies a base by one plus the basis points, rounded half away from zero: 500 is +5 %, a negative figure a deflator", () => {
    assert.equal(indexedFee(10_000, 500), 10_500)
    assert.equal(indexedFee(10_000, -200), 9_800)
    assert.equal(indexedFee(10_000, 0), 10_000)
    assert.equal(indexedFee(1, 500), 1, "1.05 rounds to 1")
    assert.equal(indexedFee(10, 500), 11, "10.5 rounds up, away from zero")
    assert.equal(indexedFee(30, 250), 31, "30.75")
    assert.equal(indexedFee(1_234_567, 315), 1_273_456, "1 273 455.86…")
    assert.throws(() => indexedFee(10.5, 500), /baseMinor is 10.5/)
    assert.throws(() => indexedFee(10, 5.5), /basisPoints is 5.5/)
  })
})

describe("PAYMENT_TERMS_DAYS", () => {
  test("is thirty days until configure.finance lands", () => {
    assert.equal(PAYMENT_TERMS_DAYS, 30)
  })
})
