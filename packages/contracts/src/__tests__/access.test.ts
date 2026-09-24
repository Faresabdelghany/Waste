import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { Role, RoleCreate, RoleGrants, RolePatch, User, UserInvite, UserPatch, UserStatus } from "../access"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const ROLE_ID = "01a0d3a5-e5e0-7000-8000-000000000002"
const PROJECT_ID = "01a0d3a5-e5e0-7000-8000-000000000003"
const PROVIDER_ID = "01a0d3a5-e5e0-7000-8000-000000000004"
const STAMPS = { createdAt: "2026-09-24T13:41:00.000Z", updatedAt: "2026-09-24T13:41:00.000Z" }

const user = {
  id: ID,
  email: "olivia.larsen@kystbyen.example",
  fullName: "Olivia Larsen",
  status: "active",
  roleId: ROLE_ID,
  allProjects: true,
  projectIds: [],
  serviceProviderId: null,
  primaryAdministrator: true,
  deactivatedAt: null,
  ...STAMPS,
}

const role = {
  id: ID,
  key: "company-administrator",
  name: "Company Administrator",
  scope: "Company",
  description: "Company, projects, users, and settings",
  system: true,
  grants: [{ moduleKey: "configure.access", actions: ["view", "edit"] }],
  ...STAMPS,
}

/** The issues a failed parse produced, as the API's 400 would spell them. */
const refusal = (result: { success: boolean; error?: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } }) => {
  assert.equal(result.success, false)
  return (result.error?.issues ?? []).map((issue) => ({ path: issue.path.join("."), message: issue.message }))
}

describe("UserStatus", () => {
  test("is the three a user can be in, and it is derived: no column holds it", () => {
    assert.deepEqual(UserStatus.options, ["invited", "active", "deactivated"])
    for (const status of ["pending", "Active", "", "disabled"]) {
      assert.equal(UserStatus.safeParse(status).success, false, JSON.stringify(status))
    }
  })
})

describe("User", () => {
  test("is the account on the wire: the derived status, the role, and what the account reaches", () => {
    assert.deepEqual(User.parse(user), user)
    assert.deepEqual(
      User.parse({ ...user, allProjects: false, projectIds: [PROJECT_ID], status: "invited", primaryAdministrator: false }).projectIds,
      [PROJECT_ID],
    )
  })

  test("carries a provider account: the provider it belongs to, deactivated or not", () => {
    const provider = User.parse({
      ...user,
      allProjects: false,
      serviceProviderId: PROVIDER_ID,
      primaryAdministrator: false,
      status: "deactivated",
      deactivatedAt: "2026-09-24T14:00:00.000Z",
    })
    assert.equal(provider.serviceProviderId, PROVIDER_ID)
    assert.equal(provider.deactivatedAt, "2026-09-24T14:00:00.000Z")
  })

  test("lowercases the ids and refuses ones of another version, a bad instant and an unknown status", () => {
    assert.equal(User.parse({ ...user, id: ID.toUpperCase() }).id, ID)
    assert.equal(User.parse({ ...user, projectIds: [PROJECT_ID.toUpperCase()] }).projectIds[0], PROJECT_ID)
    assert.equal(User.safeParse({ ...user, roleId: "01a0d3a5-e5e0-4000-8000-000000000002" }).success, false)
    assert.equal(User.safeParse({ ...user, deactivatedAt: "2026-09-24" }).success, false)
    assert.equal(User.safeParse({ ...user, status: "pending" }).success, false)
    assert.equal(User.safeParse({ ...user, email: "olivia" }).success, false)
  })

  test("needs every member: nothing here is optional, and the two nullable ones are still present", () => {
    for (const key of Object.keys(user)) {
      const { [key]: _dropped, ...without } = user as Record<string, unknown>
      assert.equal(User.safeParse(without).success, false, key)
    }
  })
})

describe("UserInvite", () => {
  const invite = { email: "new.colleague@kystbyen.example", fullName: "New Colleague", roleId: ROLE_ID }

  test("takes exactly one of the three ways to reach something", () => {
    assert.deepEqual(UserInvite.parse({ ...invite, allProjects: true }), { ...invite, allProjects: true })
    assert.deepEqual(UserInvite.parse({ ...invite, projectIds: [PROJECT_ID] }), { ...invite, projectIds: [PROJECT_ID] })
    assert.deepEqual(UserInvite.parse({ ...invite, serviceProviderId: PROVIDER_ID }), { ...invite, serviceProviderId: PROVIDER_ID })
  })

  test("refuses none of the three, two of them, and all three", () => {
    for (const access of [
      {},
      { allProjects: true, projectIds: [PROJECT_ID] },
      { allProjects: true, serviceProviderId: PROVIDER_ID },
      { projectIds: [PROJECT_ID], serviceProviderId: PROVIDER_ID },
      { allProjects: true, projectIds: [PROJECT_ID], serviceProviderId: PROVIDER_ID },
    ]) {
      const issues = refusal(UserInvite.safeParse({ ...invite, ...access }))
      assert.deepEqual(issues.map((issue) => issue.path), [""], JSON.stringify(access))
      assert.match(issues[0].message, /exactly one/, JSON.stringify(access))
      assert.match(issues[0].message, /allProjects/, JSON.stringify(access))
    }
  })

  test("refuses `allProjects: false`, naming it: absent is how a caller says no", () => {
    const issues = refusal(UserInvite.safeParse({ ...invite, allProjects: false, projectIds: [PROJECT_ID] }))
    assert.deepEqual(issues.map((issue) => issue.path), ["allProjects"])
  })

  test("refuses an empty project list: a company user works in at least one project", () => {
    assert.deepEqual(refusal(UserInvite.safeParse({ ...invite, projectIds: [] })).map((issue) => issue.path), ["projectIds"])
    assert.deepEqual(refusal(UserInvite.safeParse({ ...invite, projectIds: [PROJECT_ID, "nope"] })).map((issue) => issue.path), ["projectIds.1"])
  })

  test("needs the e-mail, the name and the role, and refuses a member the server owns", () => {
    for (const key of ["email", "fullName", "roleId"]) {
      const { [key]: _dropped, ...without } = { ...invite, allProjects: true } as Record<string, unknown>
      assert.deepEqual(refusal(UserInvite.safeParse(without)).map((issue) => issue.path), [key])
    }
    assert.equal(UserInvite.safeParse({ ...invite, allProjects: true, email: "colleague" }).success, false)
    assert.equal(UserInvite.safeParse({ ...invite, allProjects: true, fullName: "" }).success, false)
    for (const owned of ["id", "status", "primaryAdministrator", "createdAt"]) {
      assert.match(refusal(UserInvite.safeParse({ ...invite, allProjects: true, [owned]: ID }))[0].message, new RegExp(owned))
    }
  })

  test("keeps the e-mail as it was typed: lowercasing is the route's, before the database sees it", () => {
    assert.equal(UserInvite.parse({ ...invite, email: "New.Colleague@Kystbyen.example", allProjects: true }).email, "New.Colleague@Kystbyen.example")
  })
})

describe("UserPatch", () => {
  test("changes the name, the role, or the access, one or several at a time", () => {
    assert.deepEqual(UserPatch.parse({ fullName: "Olivia L. Larsen" }), { fullName: "Olivia L. Larsen" })
    assert.deepEqual(UserPatch.parse({ roleId: ROLE_ID, allProjects: true }), { roleId: ROLE_ID, allProjects: true })
    assert.deepEqual(UserPatch.parse({ projectIds: [PROJECT_ID] }), { projectIds: [PROJECT_ID] })
    assert.deepEqual(UserPatch.parse({ serviceProviderId: PROVIDER_ID }), { serviceProviderId: PROVIDER_ID })
  })

  test("refuses an empty patch, and refuses two ways of reaching something at once", () => {
    assert.deepEqual(refusal(UserPatch.safeParse({})), [{ path: "", message: "Give at least one field to change" }])
    const issues = refusal(UserPatch.safeParse({ projectIds: [PROJECT_ID], serviceProviderId: PROVIDER_ID }))
    assert.deepEqual(issues.map((issue) => issue.path), [""])
    assert.match(issues[0].message, /at most one/)
  })

  test("refuses a member it does not own: the status is derived and the e-mail is the invitation's", () => {
    for (const owned of ["status", "email", "primaryAdministrator", "deactivatedAt", "id"]) {
      assert.match(refusal(UserPatch.safeParse({ fullName: "x", [owned]: ID }))[0].message, new RegExp(owned))
    }
    assert.equal(UserPatch.safeParse({ fullName: "" }).success, false)
    assert.equal(UserPatch.safeParse({ allProjects: false }).success, false)
    assert.equal(UserPatch.safeParse({ projectIds: [] }).success, false)
  })
})

describe("Role", () => {
  test("is the role and its whole matrix: a seeded role's key, or none for a custom one", () => {
    assert.deepEqual(Role.parse(role), role)
    assert.equal(Role.parse({ ...role, key: null, system: false }).key, null)
    assert.deepEqual(Role.parse({ ...role, grants: [] }).grants, [])
  })

  test("holds the grants to the vocabulary, naming the one it refused", () => {
    const issues = refusal(Role.safeParse({ ...role, grants: [{ moduleKey: "configure.nope", actions: ["view"] }] }))
    assert.deepEqual(issues.map((issue) => issue.path), ["grants.0.moduleKey"])
    assert.deepEqual(
      refusal(Role.safeParse({ ...role, grants: [{ moduleKey: "configure.access", actions: ["approve"] }] })).map((issue) => issue.path),
      ["grants.0.actions.0"],
    )
  })

  test("needs every member", () => {
    for (const key of Object.keys(role)) {
      const { [key]: _dropped, ...without } = role as Record<string, unknown>
      assert.equal(Role.safeParse(without).success, false, key)
    }
  })
})

describe("RoleCreate", () => {
  test("takes the copy and an optional matrix: a created role is custom, so it names neither key nor system", () => {
    assert.deepEqual(RoleCreate.parse({ name: "Weekend Dispatcher", scope: "Assigned projects", description: "Weekends only" }), {
      name: "Weekend Dispatcher",
      scope: "Assigned projects",
      description: "Weekends only",
      grants: [],
    })
    assert.deepEqual(
      RoleCreate.parse({ name: "n", scope: "s", description: "d", grants: [{ moduleKey: "operate.tickets", actions: ["view"] }] }).grants,
      [{ moduleKey: "operate.tickets", actions: ["view"] }],
    )
    for (const owned of ["key", "system", "id", "createdAt"]) {
      assert.match(refusal(RoleCreate.safeParse({ name: "n", scope: "s", description: "d", [owned]: "x" }))[0].message, new RegExp(owned))
    }
  })

  test("needs the name, the scope and the description: the prototype shows all three", () => {
    for (const key of ["name", "scope", "description"]) {
      const { [key]: _dropped, ...without } = { name: "n", scope: "s", description: "d" } as Record<string, unknown>
      assert.deepEqual(refusal(RoleCreate.safeParse(without)).map((issue) => issue.path), [key])
    }
    assert.equal(RoleCreate.safeParse({ name: "", scope: "s", description: "d" }).success, false)
  })
})

describe("RolePatch", () => {
  test("changes the copy and nothing else: a key and the system flag are the role's for life", () => {
    assert.deepEqual(RolePatch.parse({ name: "Weekend Dispatcher" }), { name: "Weekend Dispatcher" })
    assert.deepEqual(RolePatch.parse({ scope: "Company", description: "d" }), { scope: "Company", description: "d" })
    assert.deepEqual(refusal(RolePatch.safeParse({})), [{ path: "", message: "Give at least one field to change" }])
    for (const owned of ["key", "system", "grants", "id"]) {
      assert.match(refusal(RolePatch.safeParse({ name: "x", [owned]: "y" }))[0].message, new RegExp(owned))
    }
  })
})

describe("RoleGrants", () => {
  test("is the whole matrix in one body, and an empty one is a role that may do nothing", () => {
    const grants = [
      { moduleKey: "configure.access", actions: ["view", "edit"] },
      { moduleKey: "operate.tickets", actions: [] },
    ]
    assert.deepEqual(RoleGrants.parse({ grants }), { grants })
    assert.deepEqual(RoleGrants.parse({ grants: [] }), { grants: [] })
  })

  test("needs the member and refuses anything else, and holds every grant to the vocabulary", () => {
    assert.equal(RoleGrants.safeParse({}).success, false)
    assert.match(refusal(RoleGrants.safeParse({ grants: [], roleId: ROLE_ID }))[0].message, /roleId/)
    assert.deepEqual(
      refusal(RoleGrants.safeParse({ grants: [{ moduleKey: "nope", actions: ["view"] }] })).map((issue) => issue.path),
      ["grants.0.moduleKey"],
    )
  })
})
