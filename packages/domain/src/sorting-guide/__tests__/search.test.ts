import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { allowedDistance, editDistance, normalise, searchGuide, type GuideEntry } from "../search"

const entry = (id: string, name: string, synonyms: string[] = []): GuideEntry => ({ id, name, synonyms })

const GUIDE: GuideEntry[] = [
  entry("1", "Pizzabakke", ["pizza box", "pizzaæske"]),
  entry("2", "Batterier", ["batteri", "knapcelle"]),
  entry("3", "Glasflaske", ["vinflaske", "glas"]),
  entry("4", "Mælkekarton", ["juicekarton", "karton"]),
  entry("5", "Kaffegrums"),
  entry("6", "Ål og fiskeben", ["fiskeskind"]),
  entry("7", "Malingrester", ["maling", "lak"]),
]

const ids = (query: string, limit?: number) => searchGuide(GUIDE, query, limit).map((match) => match.entry.id)

describe("normalise", () => {
  test("lowercases and folds Danish letters onto their two-letter spellings", () => {
    assert.equal(normalise("Æble Øl Ål"), "aeble oel aal")
  })

  test("drops other diacritics, and collapses punctuation and runs of space", () => {
    assert.equal(normalise("  Crème-brûlée,  café!  "), "creme brulee cafe")
  })

  test("folds a decomposed letter, a base and a combining mark, like the composed one", () => {
    assert.equal(normalise("Ål".normalize("NFD")), "aal")
    assert.equal(normalise("Æble".normalize("NFD")), normalise("Æble"))
  })

  test("is empty for a query of punctuation alone", () => {
    assert.equal(normalise(" -- , "), "")
  })
})

describe("editDistance", () => {
  test("counts substitutions, insertions, deletions and one adjacent transposition", () => {
    assert.equal(editDistance("glas", "glas"), 0)
    assert.equal(editDistance("glas", "gls"), 1)
    assert.equal(editDistance("glas", "galss"), 2)
    assert.equal(editDistance("batteri", "bateri"), 1)
    assert.equal(editDistance("karton", "katron"), 1)
  })

  test("stops at the bound, answering one past it", () => {
    assert.equal(editDistance("abcdefgh", "zzzzzzzz", 2), 3)
  })
})

describe("allowedDistance", () => {
  test("allows no typo in a short word, one from four letters and two from eight", () => {
    assert.deepEqual([3, 4, 7, 8, 12].map(allowedDistance), [0, 1, 1, 2, 2])
  })
})

describe("searchGuide", () => {
  test("an empty query finds nothing", () => {
    assert.deepEqual(ids(""), [])
    assert.deepEqual(ids("  ,"), [])
  })

  test("an exact name ranks first", () => {
    assert.equal(ids("batterier")[0], "2")
  })

  test("a synonym finds its item, and says which spelling matched", () => {
    const [first] = searchGuide(GUIDE, "knapcelle")
    assert.equal(first?.entry.id, "2")
    assert.equal(first?.matched, "knapcelle")
  })

  test("the start of a name finds it", () => {
    assert.deepEqual(ids("kaffe"), ["5"])
  })

  test("the start of a later word finds it", () => {
    assert.deepEqual(ids("fiskeb"), ["6"])
  })

  test("a spelling with aa, ae or oe finds a name spelled with å, æ or ø, and back", () => {
    assert.equal(ids("aal")[0], "6")
    assert.equal(ids("maelk")[0], "4")
    assert.equal(ids("Ål")[0], "6")
  })

  test("a compound typed as two words finds the compound", () => {
    assert.equal(ids("pizza bakke")[0], "1")
  })

  test("one typo in a word of four letters or more still finds it", () => {
    assert.equal(ids("batteir")[0], "2")
    assert.equal(ids("glasflakse")[0], "3")
  })

  test("a typo in a short word is not forgiven", () => {
    assert.deepEqual(ids("lsk"), [])
  })

  test("every word of a query of several must match", () => {
    assert.deepEqual(ids("vin flaske"), ["3"])
    assert.deepEqual(ids("vin batteri"), [])
  })

  test("a name outranks a synonym that matches as well", () => {
    const guide = [entry("a", "Karton"), entry("b", "Mælkekarton", ["karton"])]
    assert.deepEqual(searchGuide(guide, "karton").map((match) => match.entry.id), ["a", "b"])
  })

  test("a name saved decomposed is found by its two-letter spelling, and a decomposed query finds a composed name", () => {
    assert.deepEqual(searchGuide([entry("x", "Ål".normalize("NFD"))], "aal").map((match) => match.entry.id), ["x"])
    assert.deepEqual(searchGuide([entry("x", "Ål")], "Ål".normalize("NFD")).map((match) => match.entry.id), ["x"])
  })

  test("a query of many words, each at its allowance of typos, stops matching once the typos outweigh the words, however many it adds", () => {
    const letters = ["a", "b", "c", "d", "e", "f", "g"]
    const guide = [entry("x", letters.map((letter) => letter.repeat(8)).join(" "))]
    // Two typos in an eight-letter word: the most one word may carry.
    const typoed = (count: number) =>
      letters
        .slice(0, count)
        .map((letter) => `${letter.repeat(6)}xx`)
        .join(" ")
    assert.deepEqual(searchGuide(guide, typoed(5)).map((match) => match.score), [5], "ten typos over five words: still a match")
    assert.deepEqual(searchGuide(guide, typoed(6)), [], "twelve: no longer")
    assert.deepEqual(searchGuide(guide, typoed(7)), [], "fourteen: a seventh word does not bring it back")
  })

  test("ties keep the names in alphabetical order", () => {
    const guide = [entry("b", "Glas, farvet"), entry("a", "Glas, klart")]
    assert.deepEqual(searchGuide(guide, "glas").map((match) => match.entry.id), ["b", "a"])
  })

  test("stops at the limit", () => {
    const guide = Array.from({ length: 30 }, (_, n) => entry(String(n), `Plast ${String(n).padStart(2, "0")}`))
    assert.equal(searchGuide(guide, "plast", 5).length, 5)
    assert.equal(searchGuide(guide, "plast").length, 10)
  })
})
