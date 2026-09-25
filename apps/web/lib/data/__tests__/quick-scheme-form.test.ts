// The quick form (route-studio.schemes) is a web schema; the draft it maps
// onto, the service types it offers and the container types each allows are
// the domain's (issue #43). The domain cannot see a form field id, so this
// test is the bridge: the form's fields are the ones the draft consumes, the
// Service type select is SCHEME_SERVICE_TYPES, and the container types the
// form offers under a service type are exactly allowedContainerTypes — the
// same restriction the Guided Setup group editor applies.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  DEFAULT_SCHEME_EDIT_POLICY,
  SCHEME_EDIT_POLICIES,
  SCHEME_EDIT_POLICY_LABELS,
  type SchemeEditPolicy,
} from "@waste/domain/route-schemes/creation"
import { CONTAINER_TYPE_VOCABULARY } from "@waste/domain/route-schemes/matching"
import {
  GROUP_OWNED_SCHEME_FIELD_IDS,
  QUICK_SCHEME_DRAFT_FIELD_IDS,
} from "@waste/domain/route-schemes/quick-create"
import { SCHEME_SERVICE_TYPES, allowedContainerTypes } from "@waste/domain/route-schemes/scope"

import { getBusinessFormSchema } from "../business-form-schemas"

const schema = getBusinessFormSchema("route-studio", "schemes")
if (!schema) throw new Error("route-studio.schemes has no form schema")
const fields = schema.sections.flatMap((section) => section.fields)
const fieldById = new Map(fields.map((field) => [field.id, field]))
const field = (id: string) => {
  const found = fieldById.get(id)
  assert.ok(found, `${id} is not a field of route-studio.schemes`)
  return found
}
const values = (options: readonly { value: string }[] | undefined) =>
  (options ?? []).map((option) => option.value)

describe("route-studio.schemes is in step with Guided Setup step 1", () => {
  test("Service type is a required select over the domain's service types", () => {
    const serviceType = field("serviceType")
    assert.equal(serviceType.type, "select")
    assert.equal(serviceType.required, true)
    assert.deepEqual(values(serviceType.options), [...SCHEME_SERVICE_TYPES])
    for (const option of serviceType.options ?? []) assert.equal(option.label, option.value)
  })

  test("Waste fraction is one select, required for a rule, and the multiselect is gone", () => {
    const wasteFraction = field("wasteFraction")
    assert.equal(wasteFraction.type, "select")
    assert.equal(wasteFraction.visibleWhen, undefined)
    assert.deepEqual(wasteFraction.requiredWhen, { fieldId: "stopSelection", equals: "rule" })
    assert.ok((wasteFraction.options ?? []).length > 0)
    assert.equal(fieldById.has("matchFractions"), false)
  })

  test("the two sit in the first section right after the planning area, in step 1's order", () => {
    const first = schema.sections[0].fields.map((candidate) => candidate.id)
    const area = first.indexOf("planningAreaId")
    assert.ok(area >= 0)
    assert.deepEqual(first.slice(area + 1, area + 3), ["wasteFraction", "serviceType"])
  })

  test("the container types follow the service type: exactly allowedContainerTypes, the vocabulary when none", () => {
    const containerTypes = field("matchContainerTypes")
    assert.equal(containerTypes.type, "multiselect")
    assert.deepEqual(values(containerTypes.options), [...CONTAINER_TYPE_VOCABULARY])
    assert.equal(containerTypes.optionsBy?.fieldId, "serviceType")
    assert.deepEqual(Object.keys(containerTypes.optionsBy?.options ?? {}), [...SCHEME_SERVICE_TYPES])
    for (const serviceType of SCHEME_SERVICE_TYPES) {
      assert.deepEqual(
        values(containerTypes.optionsBy?.options[serviceType]),
        allowedContainerTypes(serviceType),
        serviceType,
      )
    }
  })

  test("every field id the domain names is a field of the form", () => {
    // The draft defaults the holiday policy and Validated-vs-Effective for a
    // quick scheme (quickSchemeDraftFromValues), so those two ids are named
    // for the wizard and are deliberately not on the quick form.
    const defaulted = new Set(["holidayPolicy", "createAs"])
    for (const id of QUICK_SCHEME_DRAFT_FIELD_IDS) {
      if (defaulted.has(id)) continue
      assert.ok(fieldById.has(id), `${id} is consumed by the draft but is not on the form`)
    }
    for (const id of GROUP_OWNED_SCHEME_FIELD_IDS) {
      assert.ok(fieldById.has(id), `${id} is hidden for a multi-group scheme but is not on the form`)
    }
  })

  test("Changes to a running scheme is a required select over the domain's edit policies, asking by default (issue #38)", () => {
    const editPolicy = field("editPolicy")
    assert.equal(editPolicy.type, "select")
    assert.equal(editPolicy.required, true)
    assert.equal(editPolicy.defaultValue, DEFAULT_SCHEME_EDIT_POLICY)
    assert.deepEqual(values(editPolicy.options), [...SCHEME_EDIT_POLICIES])
    for (const option of editPolicy.options ?? []) {
      assert.equal(option.label, SCHEME_EDIT_POLICY_LABELS[option.value as SchemeEditPolicy])
    }
    // The scheme's, not a group's: the edit dialog of a multi-group scheme keeps it.
    assert.equal(GROUP_OWNED_SCHEME_FIELD_IDS.has("editPolicy"), false)
  })
})
