// A resource's two write bodies from one list of fields (resource.ts): the
// create strict, the patch each field optional and at least one given, the
// keys the create's alone, and what the patch spells otherwise given as data.
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { SOMETHING_TO_CHANGE } from "@waste/domain/requests"
import * as z from "zod"

import { Id } from "../ids"
import { resourceBodies } from "../resource"
import { Label, Paragraph } from "../text"
import { refusal, refusesWhatTheServerOwns } from "./expect"

const PROJECT = "01a0d3a5-e5e0-7000-8000-000000000001"

const { create, patch } = resourceBodies(
  {
    projectId: Id,
    name: Label,
    notes: Paragraph.nullable().optional().describe("Null or absent is none."),
    status: z.enum(["draft", "active"]).default("draft").describe("Defaults to draft when absent."),
    code: Label.describe("The reference a person quotes."),
  },
  { createOnly: { projectId: true }, patch: { notes: Paragraph.nullable().optional(), retired: z.boolean().optional() } },
)

describe("resourceBodies", () => {
  test("the create is the fields as given, strict, its defaults filled in", () => {
    assert.deepEqual(create.parse({ projectId: PROJECT, name: "A", code: "A-1" }), { projectId: PROJECT, name: "A", code: "A-1", status: "draft" })
    refusesWhatTheServerOwns(create, { projectId: PROJECT, name: "A", code: "A-1" })
    assert.deepEqual(refusal(create.safeParse({ projectId: PROJECT, name: "A", code: "A-1", retired: true })).map((issue) => issue.path), [""], "a field only the patch takes")
  })

  test("the patch takes every field but the keys, each optional, a default dropped, and the fields only it takes after them", () => {
    assert.deepEqual(Object.keys(patch.shape), ["name", "notes", "status", "code", "retired"])
    assert.deepEqual(patch.parse({ name: "B" }), { name: "B" }, "an absent status stays absent: a patch keeps what is stored")
    assert.deepEqual(patch.parse({ notes: null, retired: true }), { notes: null, retired: true })
    assert.deepEqual(refusal(patch.safeParse({ name: "B", projectId: PROJECT })).map((issue) => issue.path), [""], "a key is the create's alone")
  })

  test("the patch refuses a body with nothing to change", () => {
    assert.deepEqual(refusal(patch.safeParse({})), [{ path: "", message: SOMETHING_TO_CHANGE }])
  })

  test("the patch carries none of the create's descriptions, which say what an absent field means there", () => {
    const properties = (schema: z.ZodType) => (z.toJSONSchema(schema, { io: "input" }) as { properties: Record<string, { description?: string }> }).properties
    assert.equal(properties(create).code.description, "The reference a person quotes.")
    assert.equal(properties(create).status.description, "Defaults to draft when absent.")
    for (const [name, field] of Object.entries(properties(patch))) assert.equal(field.description, undefined, name)
  })
})
