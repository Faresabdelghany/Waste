// The pickers the Pilot's forms name a place-bound row by (#184): a
// subscription named with the place it is delivered at, since a placement
// serves where its subscription is; a customer or a property with its status
// beside its name, since a status gates a new reference and the picker hides
// no row (#79); and a value the form opens with kept as an option, each pick
// of a multiselect on its own, so an existing reference is never refused.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessFormField } from "../business-form-types"
import type { BusinessRecord } from "../business-modules"
import { keptOptions, rowOptions, subscriptionOptions } from "../place-pickers"

const row = (id: string, name: string, status: string, over: Partial<BusinessRecord> = {}): BusinessRecord => ({
  id,
  name,
  context: "",
  status,
  owner: "",
  value: "",
  updated: "",
  description: "",
  facts: {},
  related: [],
  source: "Waste API",
  freshness: "",
  ...over,
})

describe("the subscription picker", () => {
  const atParkvej = row("subscription-1", "AGR-2408 · Residual 240 L", "Active", { recordKind: "Subscription", projectIds: ["project-copenhagen"], facts: { Property: "Parkvej 18" } })
  const atPoint = row("subscription-2", "AGR-2408 · Cardboard 660 L", "Pending", { recordKind: "Subscription", projectIds: ["project-copenhagen"], facts: { "Shared collection point": "Kongens Nytorv Shared Point" } })
  const elsewhere = row("subscription-3", "AGR-2512 · Residual 240 L", "Active", { recordKind: "Subscription", projectIds: ["project-harbor"], facts: { Property: "Dock 4" } })
  const agreement = row("agreement-2408", "AGR-2408 · Østerbro Housing", "Active", { recordKind: "Agreement", projectIds: ["project-copenhagen"] })

  test("offers the project's subscriptions alone, each with its place, and its status where it is not in force", () => {
    assert.deepEqual(subscriptionOptions([agreement, atParkvej, atPoint, elsewhere], "project-copenhagen"), [
      { value: "subscription-1", label: "AGR-2408 · Residual 240 L · Parkvej 18" },
      { value: "subscription-2", label: "AGR-2408 · Cardboard 660 L · Kongens Nytorv Shared Point · Pending" },
    ])
  })

  test("offers every subscription where the form names no project", () => {
    assert.equal(subscriptionOptions([atParkvej, elsewhere], undefined).length, 2)
  })
})

describe("a row picker", () => {
  test("names a row, and its status beside it where it is not Active", () => {
    assert.deepEqual(rowOptions([row("property-1", "Parkvej 18", "Active"), row("property-2", "Dock 4", "Inactive")]), [
      { value: "property-1", label: "Parkvej 18" },
      { value: "property-2", label: "Dock 4 · Inactive" },
    ])
  })
})

describe("the value a form opens with", () => {
  const offered = [{ value: "contact-mikkel", label: "Mikkel Sørensen" }]
  const select: BusinessFormField = { id: "responsibleCustomerId", label: "Responsible customer", type: "select" }
  const multiselect: BusinessFormField = { id: "ownerIds", label: "Owners", type: "multiselect" }

  test("stays offered as its id chip where no loaded row holds it", () => {
    assert.deepEqual(keptOptions(select, offered, "customer-01a0d2a4-a280-700b-8000-000000000009"), [...offered, { value: "customer-01a0d2a4-a280-700b-8000-000000000009", label: "customer-01a0d2a4-a280-700b-8000-000000000009" }])
    assert.deepEqual(keptOptions(select, offered, "contact-mikkel"), offered)
    assert.deepEqual(keptOptions(select, offered, ""), offered)
  })

  test("keeps each pick of a multiselect on its own", () => {
    assert.deepEqual(keptOptions(multiselect, offered, "contact-mikkel, customer-01a0d2a4-a280-700b-8000-000000000009"), [...offered, { value: "customer-01a0d2a4-a280-700b-8000-000000000009", label: "customer-01a0d2a4-a280-700b-8000-000000000009" }])
  })
})
