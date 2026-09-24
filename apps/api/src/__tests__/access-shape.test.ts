import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Grant } from "@waste/contracts/permissions"

import { accessColumns, accessOf, grantsOfRows, normalisedGrants, uniqueIds, userStatus } from "../access-shape"

const PROJECT = "01a0d3a5-e5e0-7000-8000-000000000003"
const OTHER_PROJECT = "01a0d3a5-e5e0-7000-8000-000000000004"
const PROVIDER = "01a0d3a5-e5e0-7000-8000-000000000005"
const LOGIN = "6f9619ff-8b86-d011-b42d-00c04fc964ff"
const WHEN = new Date("2026-09-24T13:41:00.000Z")

describe("userStatus", () => {
  test("is invited until a login is bound, and active once one is", () => {
    assert.equal(userStatus({ authUserId: null, deactivatedAt: null }), "invited")
    assert.equal(userStatus({ authUserId: LOGIN, deactivatedAt: null }), "active")
  })

  test("is deactivated whenever the account is switched off, bound or not", () => {
    assert.equal(userStatus({ authUserId: LOGIN, deactivatedAt: WHEN }), "deactivated")
    assert.equal(
      userStatus({ authUserId: null, deactivatedAt: WHEN }),
      "deactivated",
      "deactivated wins over invited: a switched-off account must not look like a pending invitation",
    )
  })
})

describe("accessOf", () => {
  test("reads the one way the body named", () => {
    assert.deepEqual(accessOf({ allProjects: true }), { kind: "all-projects" })
    assert.deepEqual(accessOf({ projectIds: [PROJECT, OTHER_PROJECT] }), { kind: "projects", projectIds: [PROJECT, OTHER_PROJECT] })
    assert.deepEqual(accessOf({ serviceProviderId: PROVIDER }), { kind: "provider", serviceProviderId: PROVIDER })
  })

  test("keeps the project list as the body spelled it, repeats included: a refusal names one by its place in it", () => {
    assert.deepEqual(accessOf({ projectIds: [PROJECT, OTHER_PROJECT, PROJECT] }), {
      kind: "projects",
      projectIds: [PROJECT, OTHER_PROJECT, PROJECT],
    })
    const body = [PROJECT]
    const shape = accessOf({ projectIds: body })
    assert.notEqual(shape?.kind === "projects" ? shape.projectIds : body, body, "and it is a copy, not the body's own array")
  })

  test("is undefined when the body names none: a patch may leave the access alone", () => {
    assert.equal(accessOf({}), undefined)
  })

  test("refuses two ways at once as the bug it is: the contracts' one-of rule should have answered 400", () => {
    assert.throws(() => accessOf({ allProjects: true, serviceProviderId: PROVIDER }), /one of/)
    assert.throws(() => accessOf({ projectIds: [PROJECT], serviceProviderId: PROVIDER }), /one of/)
  })
})

describe("accessColumns", () => {
  test("is what the account's own row says: the rest is the access rows beside it", () => {
    assert.deepEqual(accessColumns({ kind: "all-projects" }), { allProjects: true, serviceProviderId: null })
    assert.deepEqual(accessColumns({ kind: "projects", projectIds: [PROJECT] }), { allProjects: false, serviceProviderId: null })
    assert.deepEqual(accessColumns({ kind: "provider", serviceProviderId: PROVIDER }), { allProjects: false, serviceProviderId: PROVIDER })
  })
})

describe("uniqueIds", () => {
  test("keeps the first of each, in the order they came", () => {
    assert.deepEqual(uniqueIds([PROJECT, OTHER_PROJECT, PROJECT, OTHER_PROJECT]), [PROJECT, OTHER_PROJECT])
    assert.deepEqual(uniqueIds([]), [])
  })
})

describe("normalisedGrants", () => {
  test("is the grant set as the system stores it: view implied, a module named twice merged, sorted", () => {
    assert.deepEqual(
      normalisedGrants([
        { moduleKey: "operate.tickets", actions: ["delete"] },
        { moduleKey: "fleet.drivers", actions: ["edit"] },
        { moduleKey: "operate.tickets", actions: ["create"] },
      ]),
      [
        { moduleKey: "fleet.drivers", actions: ["view", "edit"] },
        { moduleKey: "operate.tickets", actions: ["view", "create", "delete"] },
      ],
    )
  })

  test("drops a module granted nothing", () => {
    assert.deepEqual(normalisedGrants([{ moduleKey: "operate.tickets", actions: [] }]), [])
  })

  test("copies the actions: what a caller gets is its own to hold, and the body it came from is untouched", () => {
    const body: Grant[] = [{ moduleKey: "operate.tickets", actions: ["view"] }]
    const grants = normalisedGrants(body)
    grants[0].actions.push("edit")
    assert.deepEqual(body[0].actions, ["view"])
  })
})

describe("grantsOfRows", () => {
  test("turns the role's rows into the set it grants", () => {
    assert.deepEqual(
      grantsOfRows([
        { moduleKey: "operate.tickets", action: "edit" },
        { moduleKey: "operate.tickets", action: "view" },
        { moduleKey: "configure.access", action: "delete" },
      ]),
      [
        { moduleKey: "configure.access", actions: ["view", "delete"] },
        { moduleKey: "operate.tickets", actions: ["view", "edit"] },
      ],
    )
    assert.deepEqual(grantsOfRows([]), [])
  })

  test("drops a row outside the vocabulary: there is no surface with that key to reach", () => {
    assert.deepEqual(
      grantsOfRows([
        { moduleKey: "configure.retired", action: "view" },
        { moduleKey: "operate.tickets", action: "approve" },
        { moduleKey: "operate.tickets", action: "view" },
      ]),
      [{ moduleKey: "operate.tickets", actions: ["view"] }],
    )
  })
})
