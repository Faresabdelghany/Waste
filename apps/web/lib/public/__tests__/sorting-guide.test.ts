import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { SEARCH_MAX as WIRE_SEARCH_MAX, type SortingGuideMatch } from "@waste/contracts/sorting-guide"

import { pageViewOf, queryOf, SEARCH_MAX } from "../sorting-guide"

const match: SortingGuideMatch = { id: "01a0d2a4-a280-7040-8000-000000000001", name: "Pizzabakke", synonyms: ["pizza box"], matched: "pizza box", fraction: { key: "cardboard", name: "Pap" }, instructions: null }

describe("queryOf", () => {
  test("reads the first q, trimmed; none or blank asks nothing", () => {
    assert.equal(queryOf("  pizza "), "pizza")
    assert.equal(queryOf(["glas", "pap"]), "glas")
    assert.equal(queryOf(undefined), null)
    assert.equal(queryOf("   "), null)
    assert.equal(queryOf([]), null)
  })

  test("cuts a long query to the door's length rather than asking it to refuse", () => {
    assert.equal(SEARCH_MAX, WIRE_SEARCH_MAX, "spelled again here: the web imports the contracts as types only")
    assert.equal(queryOf("x".repeat(SEARCH_MAX + 20))?.length, SEARCH_MAX)
  })
})

const project = { slug: "kystbyen", name: "Kystbyen", language: "da", timezone: "Europe/Copenhagen", branding: { brandColor: null, logoUrl: null, accessibilityStatementUrl: null } }

describe("pageViewOf", () => {
  test("a page that asks nothing shows the project and the prompt", () => {
    assert.deepEqual(pageViewOf({ query: null, answer: { kind: "ok", body: project } }), { kind: "published", project, guide: { kind: "prompt" } })
  })

  test("a search names its project and lists the matches, or says nothing matched", () => {
    assert.deepEqual(pageViewOf({ query: "pizza", answer: { kind: "ok", body: { project, query: "pizza", matches: [match] } } }), { kind: "published", project, guide: { kind: "matches", query: "pizza", matches: [match] } })
    assert.deepEqual(pageViewOf({ query: "xyz", answer: { kind: "ok", body: { project, query: "xyz", matches: [] } } }), { kind: "published", project, guide: { kind: "nothing", query: "xyz" } })
  })

  test("is not published, the allowance's wait or unavailable as the door said, whether it searched or not", () => {
    assert.deepEqual(pageViewOf({ query: "pizza", answer: { kind: "not-published" } }), { kind: "not-published" })
    assert.deepEqual(pageViewOf({ query: null, answer: { kind: "not-published" } }), { kind: "not-published" })
    assert.deepEqual(pageViewOf({ query: "pizza", answer: { kind: "too-many", retryAfterSeconds: 12 } }), { kind: "too-many", retryAfterSeconds: 12 })
    assert.deepEqual(pageViewOf({ query: null, answer: { kind: "unavailable" } }), { kind: "unavailable" })
  })
})
