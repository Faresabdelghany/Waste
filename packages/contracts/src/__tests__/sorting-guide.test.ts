import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { SORTING_GUIDE_ITEM_STATUSES } from "@waste/domain/sorting-guide/vocabulary"

import { PublicSlugParam, PublishedProject } from "../public"
import {
  SEARCH_LIMIT,
  SEARCH_MAX,
  SortingGuideAnswer,
  SortingGuideItem,
  SortingGuideItemCreate,
  SortingGuideItemListQuery,
  SortingGuideItemPatch,
  SortingGuideSearch,
  SYNONYMS_MAX,
} from "../sorting-guide"
import { refusal, refusesAnEmptyPatch, refusesWhatTheServerOwns } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const STAMPS = { createdAt: "2026-10-24T09:00:00.000Z", updatedAt: "2026-10-24T09:00:00.000Z" }

const item = {
  id: ID,
  projectId: ID,
  name: "Pizzabakke",
  synonyms: ["pizza box", "pizzaæske"],
  wasteFractionId: ID,
  instructions: "Skrab madrester af. Rene bakker i pap.",
  status: "published",
  ...STAMPS,
}

describe("SortingGuideItem", () => {
  test("is the row on the wire, its status one of the guide's three", () => {
    assert.deepEqual(SortingGuideItem.parse(item), item)
    assert.deepEqual(SortingGuideItem.parse({ ...item, wasteFractionId: null, instructions: null, synonyms: [] }).synonyms, [])
    for (const status of SORTING_GUIDE_ITEM_STATUSES) assert.equal(SortingGuideItem.parse({ ...item, status }).status, status)
    assert.equal(SortingGuideItem.safeParse({ ...item, status: "archived" }).success, false)
  })
})

describe("SortingGuideItemCreate", () => {
  const { id: _id, createdAt: _created, updatedAt: _updated, ...body } = item

  test("takes an item for one project and mints nothing", () => {
    assert.deepEqual(SortingGuideItemCreate.parse(body), body)
    refusesWhatTheServerOwns(SortingGuideItemCreate, body)
  })

  test("defaults to a draft with no synonyms, and says so", () => {
    assert.deepEqual(SortingGuideItemCreate.parse({ projectId: ID, name: "Kaffegrums" }), { projectId: ID, name: "Kaffegrums", synonyms: [], status: "draft" })
  })

  test("names each synonym once, at most thirty, none blank", () => {
    for (const twice of [["glas", "glas"], ["Pizza box", "pizza box"], ["æske", "aeske"], ["pizza-box", "pizza box"]]) {
      assert.deepEqual(refusal(SortingGuideItemCreate.safeParse({ ...body, synonyms: twice })), [
        { path: "synonyms", message: "Name each synonym once: a word is searched once however it is spelled or cased" },
      ], JSON.stringify(twice))
    }
    assert.equal(SortingGuideItemCreate.safeParse({ ...body, synonyms: Array.from({ length: SYNONYMS_MAX + 1 }, (_, n) => `word ${n}`) }).success, false)
    assert.equal(SortingGuideItemCreate.safeParse({ ...body, synonyms: ["  "] }).success, false)
  })
})

describe("SortingGuideItemPatch", () => {
  test("changes anything but the project, and refuses an empty patch", () => {
    assert.deepEqual(SortingGuideItemPatch.parse({ status: "withdrawn", wasteFractionId: null }), { status: "withdrawn", wasteFractionId: null })
    assert.equal(SortingGuideItemPatch.safeParse({ projectId: ID }).success, false)
    refusesAnEmptyPatch(SortingGuideItemPatch)
  })
})

describe("SortingGuideItemListQuery", () => {
  test("narrows by project and status", () => {
    assert.deepEqual(SortingGuideItemListQuery.parse({ projectId: ID, status: "draft" }), { limit: 50, projectId: ID, status: "draft" })
  })
})

describe("the public door's shapes", () => {
  test("a search is what was typed, up to a hundred characters, and a limit of 1..20 that defaults to 10, from the query string", () => {
    assert.deepEqual(SortingGuideSearch.parse({ q: "pizza" }), { q: "pizza", limit: SEARCH_LIMIT.default })
    assert.deepEqual(SortingGuideSearch.parse({ q: "pizza", limit: "3" }), { q: "pizza", limit: 3 })
    for (const query of [{}, { q: "" }, { q: "x".repeat(SEARCH_MAX + 1) }, { q: "pizza", limit: "21" }, { q: "pizza", limit: "0" }]) {
      assert.equal(SortingGuideSearch.safeParse(query).success, false, JSON.stringify(query))
    }
  })

  test("an answer carries what a resident reads: no status, no stamps, no project", () => {
    const answer = {
      project: { slug: "kystbyen", name: "Kystbyen", language: "da", timezone: "Europe/Copenhagen" },
      query: "pizza",
      matches: [{ id: ID, name: "Pizzabakke", synonyms: ["pizza box"], matched: "Pizzabakke", fraction: { key: "cardboard", name: "Pap" }, instructions: null }],
    }
    assert.deepEqual(SortingGuideAnswer.parse(answer), answer)
    assert.deepEqual(Object.keys(SortingGuideAnswer.shape.matches.element.shape).sort(), ["fraction", "id", "instructions", "matched", "name", "synonyms"])
  })

  test("a published project is named by its slug, never its ids", () => {
    assert.deepEqual(Object.keys(PublishedProject.shape).sort(), ["language", "name", "slug", "timezone"])
    assert.deepEqual(PublicSlugParam.parse({ slug: "kystbyen" }), { slug: "kystbyen" })
    assert.equal(PublicSlugParam.safeParse({ slug: "Kystbyen" }).success, false)
  })
})
