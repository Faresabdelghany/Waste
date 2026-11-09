import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { formatArea, formatDistance, formatDuration, formatVolume, formatWeight, kilograms } from "../measures"

describe("formatArea", () => {
  test("small shapes read in square metres, larger ones in km² with two decimals", () => {
    assert.equal(formatArea(0), "0 m²")
    assert.equal(formatArea(8_432.6), "8,433 m²")
    assert.equal(formatArea(90_000), "0.09 km²")
    assert.equal(formatArea(1_234_567), "1.23 km²")
  })
})

describe("formatWeight and formatVolume", () => {
  test("weights switch to tonnes at a tonne, volumes read in m³", () => {
    assert.equal(formatWeight(0), "0 t")
    assert.equal(formatWeight(480), "480 kg")
    assert.equal(formatWeight(30_640), "30.6 t")
    assert.equal(formatVolume(0), "0 m³")
    assert.equal(formatVolume(112_400), "112.4 m³")
    assert.equal(formatVolume(240), "0.2 m³")
  })
})

describe("kilograms", () => {
  test("read whole, with thousands separators", () => {
    assert.equal(kilograms(480), "480 kg")
    assert.equal(kilograms(12_480), "12,480 kg")
  })
})

describe("formatDistance", () => {
  test("metres under a kilometre, kilometres with one decimal above", () => {
    assert.equal(formatDistance(850), "850 m")
    assert.equal(formatDistance(12_440), "12.4 km")
    assert.equal(formatDistance(0), "0 m")
  })
})

describe("formatDuration", () => {
  test("minutes under an hour, hours and minutes above", () => {
    assert.equal(formatDuration(38 * 60), "38 min")
    assert.equal(formatDuration(65 * 60 + 20), "1 h 05 min")
    assert.equal(formatDuration(30), "1 min")
  })
})
