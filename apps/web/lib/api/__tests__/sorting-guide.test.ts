import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { SortingGuideItemCreate, SortingGuideItemPatch, type SortingGuideItem } from "@waste/contracts/sorting-guide"

import type { BusinessRecord } from "../../data/business-modules"
import { sortingGuideFormOf, sortingGuideRecordOf } from "../../data/sorting-guide"
import type { MappingContext, Resolver } from "../records/adapter"
import { isServerBacked, SERVER_MODULE_KEYS } from "../records/modules"
import { NO_FRACTION, sortingGuideItemAdapter } from "../records/sorting-guide"

const NOW = new Date("2026-10-24T12:00:00Z")
const PROJECT = "01a0d2a4-a280-7002-8000-000000000001"
const GLASS = "01a0d2a4-a280-7007-8000-000000000005"
const PAPER = "01a0d2a4-a280-7007-8000-000000000003"
const ITEM = "01a16d43-97f9-79bb-8071-20871ff91277"

const loaded: Record<string, { record: Pick<BusinessRecord, "id" | "name">; serverId: string }> = {
  "project-copenhagen": { record: { id: "project-copenhagen", name: "Copenhagen Central" }, serverId: PROJECT },
  "fraction-glass": { record: { id: "fraction-glass", name: "Glass" }, serverId: GLASS },
  "fraction-paper": { record: { id: "fraction-paper", name: "Paper" }, serverId: PAPER },
}
const resolve: Resolver = {
  byServerId: (serverId) => Object.values(loaded).find((entry) => entry.serverId === serverId)?.record as BusinessRecord | undefined,
  serverIdOf: (webId) => loaded[webId]?.serverId,
  find: () => undefined,
  filter: () => [],
}
const context: MappingContext = { fixtures: [], resolve, now: NOW }

const item: SortingGuideItem = {
  id: ITEM,
  projectId: PROJECT,
  name: "Glasflaske",
  synonyms: ["vinflaske", "syltetøjsglas"],
  wasteFractionId: GLASS,
  instructions: "Skyl den.",
  status: "published",
  createdAt: "2026-10-24T09:00:00.000Z",
  updatedAt: "2026-10-24T09:30:00.000Z",
}

describe("the Sorting Guide's adapter", () => {
  test("is a switched module, read after the projects and the fractions it names", () => {
    assert.ok(isServerBacked("configure", "sorting-guide"))
    const at = (key: string) => SERVER_MODULE_KEYS.indexOf(key)
    assert.ok(at("configure.sorting-guide") > at("configure.organization"))
    assert.ok(at("configure.sorting-guide") > at("configure.master"))
  })

  test("reads an item as a record naming its project and fraction by web id, the synonyms as one line", () => {
    const record = sortingGuideItemAdapter.toRecord(item, context)
    assert.equal(record.id, `guide-item-${ITEM}`)
    assert.equal(record.name, "Glasflaske")
    assert.equal(record.status, "Published")
    assert.equal(record.context, "Glass · Copenhagen Central")
    assert.deepEqual(record.projectIds, ["project-copenhagen"])
    assert.deepEqual(record.submittedValues, { projectId: "project-copenhagen", name: "Glasflaske", synonyms: "vinflaske, syltetøjsglas", status: "published", wasteFractionId: "fraction-glass", instructions: "Skyl den." })
    const bare = sortingGuideItemAdapter.toRecord({ ...item, wasteFractionId: null, instructions: null, synonyms: [] }, context)
    assert.equal(bare.facts.Fraction, NO_FRACTION)
    assert.equal(bare.submittedValues?.wasteFractionId, undefined)
  })

  test("writes the form's record as a create body the contracts take, server ids for web ids", () => {
    const form = { ...sortingGuideFormOf(null, "project-copenhagen"), name: "Pizzabakke", synonyms: "pizza box, Pizza box", wasteFractionId: "fraction-paper", status: "published" }
    const body = sortingGuideItemAdapter.toCreateBody?.(sortingGuideRecordOf(form, null, 1), context)
    assert.deepEqual(body, { projectId: PROJECT, name: "Pizzabakke", synonyms: ["pizza box"], wasteFractionId: PAPER, status: "published" })
    assert.equal(SortingGuideItemCreate.safeParse(body).success, true)
  })

  test("refuses a fraction the store does not hold, at the field, before the API sees it", () => {
    const form = { ...sortingGuideFormOf(null, "project-copenhagen"), name: "Ukendt", wasteFractionId: "fraction-unknown" }
    assert.deepEqual(sortingGuideItemAdapter.toCreateBody?.(sortingGuideRecordOf(form, null, 1), context), { path: "wasteFractionId", message: "Pick a waste fraction the API holds" })
  })

  test("patches only what moved, a moved fraction as its server id and a cleared one as null; an unmoved record patches nothing", () => {
    const before = sortingGuideItemAdapter.toRecord(item, context)
    const moved = sortingGuideRecordOf({ ...sortingGuideFormOf(before, "project-copenhagen"), synonyms: "vinflaske", wasteFractionId: "fraction-paper" }, before, 1)
    const patch = sortingGuideItemAdapter.toPatchBody(before, moved, context)
    assert.deepEqual(patch, { synonyms: ["vinflaske"], wasteFractionId: PAPER })
    assert.equal(SortingGuideItemPatch.safeParse(patch).success, true)
    const cleared = sortingGuideRecordOf({ ...sortingGuideFormOf(before, "project-copenhagen"), wasteFractionId: "", status: "withdrawn" }, before, 1)
    assert.deepEqual(sortingGuideItemAdapter.toPatchBody(before, cleared, context), { wasteFractionId: null, status: "withdrawn" })
    const same = sortingGuideRecordOf(sortingGuideFormOf(before, "project-copenhagen"), before, 1)
    assert.equal(sortingGuideItemAdapter.toPatchBody(before, same, context), null)
  })
})
