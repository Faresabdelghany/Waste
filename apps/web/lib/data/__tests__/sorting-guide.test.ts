import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { isPublicSlug } from "@waste/domain/access/public-slug"

import { getBusinessModuleHref } from "../business-links"
import { slugRefusalOf, slugSuggestionOf, sortingGuideFormOf, sortingGuidePathOf, sortingGuideRecordOf, synonymsOf } from "../sorting-guide"

describe("synonymsOf", () => {
  test("splits a line on commas and new lines, trims, drops blanks, and keeps each word once whatever its case", () => {
    assert.deepEqual(synonymsOf(" pizza box, pizzaæske\nPizza Box,, "), ["pizza box", "pizzaæske"])
    assert.deepEqual(synonymsOf(""), [])
  })
})

describe("the item form and the record it writes", () => {
  test("a new item opens as a draft on the project given, and writes a record on that project under the guide's prefix", () => {
    const form = sortingGuideFormOf(null, "project-copenhagen")
    assert.deepEqual(form, { projectId: "project-copenhagen", name: "", synonyms: "", wasteFractionId: "", instructions: "", status: "draft" })
    const record = sortingGuideRecordOf({ ...form, name: " Pizzabakke ", synonyms: "pizza box, pizza box", wasteFractionId: "fraction-cardboard", instructions: " Skrab madrester af. " }, null, 1_761_300_000_000)
    assert.equal(record.id, "guide-item-1761300000000")
    assert.equal(record.name, "Pizzabakke")
    assert.equal(record.status, "Draft")
    assert.deepEqual(record.projectIds, ["project-copenhagen"])
    assert.deepEqual(record.submittedValues, { name: "Pizzabakke", synonyms: "pizza box", status: "draft", wasteFractionId: "fraction-cardboard", instructions: "Skrab madrester af." })
  })

  test("an edited item keeps its id and stamps, and an emptied fraction or instruction is no longer said", () => {
    const existing = sortingGuideRecordOf({ projectId: "project-copenhagen", name: "Glas", synonyms: "", wasteFractionId: "fraction-glass", instructions: "Skyl", status: "published" }, null, 1)
    const form = sortingGuideFormOf(existing, "project-elsewhere")
    assert.equal(form.projectId, "project-copenhagen", "an item keeps its project")
    assert.equal(form.status, "published")
    const edited = sortingGuideRecordOf({ ...form, wasteFractionId: "", instructions: " " , status: "withdrawn" }, existing, 2)
    assert.equal(edited.id, existing.id)
    assert.equal(edited.status, "Withdrawn")
    assert.deepEqual(edited.submittedValues, { name: "Glas", synonyms: "", status: "withdrawn" })
  })
})

describe("a project's public address", () => {
  test("a name suggests a slug the API takes, the Danish letters folded", () => {
    for (const [name, slug] of [["Copenhagen Central", "copenhagen-central"], ["Kystbyen Østerbro", "kystbyen-oesterbro"], ["  Århus / Nord  ", "aarhus-nord"]] as const) {
      assert.equal(slugSuggestionOf(name), slug)
      assert.ok(isPublicSlug(slug), slug)
    }
    assert.ok(slugSuggestionOf("x".repeat(80)).length <= 63)
  })

  test("a slug the API would refuse is refused before it is sent, by the same rule", () => {
    for (const slug of ["kystbyen", "kystbyen-nord", "k2b"]) assert.equal(slugRefusalOf(slug), null, slug)
    for (const slug of ["ab", "Kystbyen", "kyst byen", "kyst--byen", "-kyst", "a".repeat(64)]) {
      assert.notEqual(slugRefusalOf(slug), null, slug)
      assert.equal(isPublicSlug(slug), false, slug)
    }
  })

  test("a published guide is read at /p/<slug>/sorting", () => {
    assert.equal(sortingGuidePathOf("kystbyen"), "/p/kystbyen/sorting")
  })
})

describe("a link to the guide", () => {
  test("opens Settings › Sorting guide, for the module and for an item", () => {
    assert.match(getBusinessModuleHref("configure", "sorting-guide"), /^\/settings\?pane=sorting-guide/)
    assert.match(getBusinessModuleHref("configure", "sorting-guide", "guide-item-x"), /^\/settings\?pane=sorting-guide/)
  })
})

