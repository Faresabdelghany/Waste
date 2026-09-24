import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { mergeGrants, normaliseGrants, type Grant } from "../grants"

describe("normaliseGrants", () => {
  test("edit, create and delete each imply view", () => {
    assert.deepEqual(normaliseGrants([{ moduleKey: "fleet.vehicles", actions: ["edit"] }]), [
      { moduleKey: "fleet.vehicles", actions: ["view", "edit"] },
    ])
    assert.deepEqual(normaliseGrants([{ moduleKey: "fleet.vehicles", actions: ["create"] }]), [
      { moduleKey: "fleet.vehicles", actions: ["view", "create"] },
    ])
    assert.deepEqual(normaliseGrants([{ moduleKey: "fleet.vehicles", actions: ["delete"] }]), [
      { moduleKey: "fleet.vehicles", actions: ["view", "delete"] },
    ])
  })

  test("view on its own stays view", () => {
    assert.deepEqual(normaliseGrants([{ moduleKey: "fleet.vehicles", actions: ["view"] }]), [
      { moduleKey: "fleet.vehicles", actions: ["view"] },
    ])
  })

  test("actions come out in ACTIONS order, whatever order they went in, and never twice", () => {
    assert.deepEqual(normaliseGrants([{ moduleKey: "operate.tickets", actions: ["delete", "view", "create", "edit", "view"] }]), [
      { moduleKey: "operate.tickets", actions: ["view", "edit", "create", "delete"] },
    ])
  })

  test("a module key named twice is one grant, its actions merged", () => {
    assert.deepEqual(
      normaliseGrants([
        { moduleKey: "operate.tickets", actions: ["create"] },
        { moduleKey: "operate.tickets", actions: ["view"] },
      ]),
      [{ moduleKey: "operate.tickets", actions: ["view", "create"] }],
    )
  })

  test("grants come out sorted by module key", () => {
    const grants: Grant[] = [
      { moduleKey: "operate.tickets", actions: ["view"] },
      { moduleKey: "configure.access", actions: ["view"] },
      { moduleKey: "fleet.drivers", actions: ["view"] },
    ]
    assert.deepEqual(
      normaliseGrants(grants).map((grant) => grant.moduleKey),
      ["configure.access", "fleet.drivers", "operate.tickets"],
    )
  })

  test("a grant of no actions is not a grant", () => {
    assert.deepEqual(
      normaliseGrants([
        { moduleKey: "operate.tickets", actions: [] },
        { moduleKey: "fleet.drivers", actions: ["view"] },
      ]),
      [{ moduleKey: "fleet.drivers", actions: ["view"] }],
    )
    assert.deepEqual(normaliseGrants([]), [])
  })

  test("it is pure: the input is left alone and normalising twice changes nothing", () => {
    const grants: Grant[] = [{ moduleKey: "operate.tickets", actions: ["delete"] }]
    const once = normaliseGrants(grants)
    assert.deepEqual(grants, [{ moduleKey: "operate.tickets", actions: ["delete"] }])
    assert.notEqual(once, grants)
    assert.deepEqual(normaliseGrants(once), once)
  })
})

describe("mergeGrants", () => {
  test("tidies a grant set the same way but adds nothing: a charter that says edit means edit", () => {
    assert.deepEqual(
      mergeGrants([
        { moduleKey: "operate.tickets", actions: ["create", "view"] },
        { moduleKey: "fleet.drivers", actions: ["edit"] },
        { moduleKey: "operate.tickets", actions: ["delete"] },
        { moduleKey: "customers.groups", actions: [] },
      ]),
      [
        { moduleKey: "fleet.drivers", actions: ["edit"] },
        { moduleKey: "operate.tickets", actions: ["view", "create", "delete"] },
      ],
    )
  })
})
