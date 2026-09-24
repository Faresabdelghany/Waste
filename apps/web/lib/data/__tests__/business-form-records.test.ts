// The generic edit path merges the submitted facts over the record's, and
// deriveFormRecord writes no fact for an empty value — so before issue #22
// a field a person emptied kept its old fact (a condition, an Effective to,
// a scheduled change could not be cancelled through Edit). clearedFactKeys
// is the rule that tells a deliberate clearing apart from a field the form
// never showed with a value: only a field the form opened with a value and
// received back empty clears its fact.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { clearedFactKeys, deriveFormRecord } from "../business-form-records"
import type { BusinessFormSchema, BusinessFormValues } from "../business-form-types"

const schema: BusinessFormSchema = {
  key: "commercial.price-rows",
  mode: "create",
  recordKind: "Price row",
  title: "Add price",
  description: "",
  submitLabel: "Add price",
  sections: [
    {
      id: "row",
      title: "Row",
      fields: [
        { id: "amount", label: "Amount", type: "number", required: true },
        { id: "zone", label: "Zone", type: "select", options: [{ value: "Harbor", label: "Harbor" }] },
        { id: "effectiveTo", label: "Effective to", type: "date" },
        { id: "scheduledFrom", label: "Scheduled from", type: "date" },
        { id: "serviceLevels", label: "Service levels", type: "multiselect", options: [] },
        { id: "negotiated", label: "Negotiated", type: "checkbox" },
        { id: "note", label: "Note", type: "text", visibleWhen: { fieldId: "negotiated", equals: true } },
      ],
    },
  ],
}

const omit = (values: BusinessFormValues, fieldId: string): BusinessFormValues => {
  const rest = { ...values }
  delete rest[fieldId]
  return rest
}

const initial: BusinessFormValues = {
  amount: "18.50",
  zone: "Harbor",
  effectiveTo: "2026-12-31",
  scheduledFrom: "",
  serviceLevels: "Standard kerbside, Next-day",
  negotiated: true,
  note: "Ends with the season",
}

describe("clearedFactKeys", () => {
  test("a field the form opened with a value and received back empty clears its fact", () => {
    assert.deepEqual(
      clearedFactKeys(schema, { ...initial, zone: "", effectiveTo: "   " }, initial),
      ["Zone", "Effective to"],
    )
  })

  test("a field that was empty already is not a clearing", () => {
    assert.deepEqual(clearedFactKeys(schema, { ...initial, scheduledFrom: "" }, initial), [])
  })

  test("a field the form did not submit — hidden, or not on this form — is not a clearing", () => {
    // The dialog submits visible fields only; a conditional field hidden by
    // its controlling checkbox is absent from the values altogether.
    assert.deepEqual(clearedFactKeys(schema, omit({ ...initial, negotiated: false }, "note"), initial), [])
    // A record fact with no field on the form is never on the list either.
    assert.deepEqual(clearedFactKeys(schema, omit(initial, "amount"), initial), [])
  })

  test("an emptied multiselect clears its fact, an unticked checkbox does not", () => {
    assert.deepEqual(
      clearedFactKeys(schema, { ...initial, serviceLevels: "", negotiated: false }, initial),
      ["Service levels"],
    )
  })

  test("a value the form was seeded with but the record never stored still counts as shown", () => {
    // The seed is what the person saw: a schema default they emptied is a
    // clearing of that default, whatever the record held before.
    assert.deepEqual(
      clearedFactKeys(schema, { ...initial, effectiveTo: "" }, { ...initial, effectiveTo: "2026-08-20" }),
      ["Effective to"],
    )
  })
})

describe("deriveFormRecord beside it", () => {
  test("writes no fact for an empty value, which is why the edit path needs the cleared keys", () => {
    const { facts } = deriveFormRecord(schema, { ...initial, zone: "", effectiveTo: "" })
    assert.equal(facts.Zone, undefined)
    assert.equal(facts["Effective to"], undefined)
    assert.equal(facts.Amount, "18.50")
  })
})
