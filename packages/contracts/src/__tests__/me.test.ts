import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { Me } from "../me"

const olivia = {
  user: {
    id: "01a0d2a4-a280-7005-8000-000000000001",
    email: "olivia.larsen@kystbyen.example",
    fullName: "Olivia Larsen",
    status: "active",
    allProjects: true,
    primaryAdministrator: true,
  },
  company: { id: "01a0d2a4-a280-7001-8000-000000000001", name: "Kystbyen Renovation" },
  role: {
    id: "01a0d2a4-a280-7004-8000-000000000001",
    key: "company-administrator",
    name: "Company Administrator",
    scope: "Company",
    system: true,
    grants: [{ moduleKey: "configure.access", actions: ["view", "edit", "create", "delete"] }],
  },
  projects: [
    { id: "01a0d2a4-a280-7002-8000-000000000003", name: "Cairo Operations" },
    { id: "01a0d2a4-a280-7002-8000-000000000001", name: "Copenhagen Central" },
    { id: "01a0d2a4-a280-7002-8000-000000000002", name: "Harbor Commercial" },
  ],
  serviceProvider: null,
  driver: null,
}

const lars = {
  user: {
    id: "01a0d2a4-a280-7005-8000-000000000002",
    email: "lars.mikkelsen@nordren.dk",
    fullName: "Lars Mikkelsen",
    status: "active",
    allProjects: false,
    primaryAdministrator: false,
  },
  company: { id: "01a0d2a4-a280-7001-8000-000000000001", name: "Kystbyen Renovation" },
  role: {
    id: "01a0d2a4-a280-7004-8000-000000000008",
    key: "service-provider-manager",
    name: "Service Provider Manager",
    scope: "Own service provider",
    system: true,
    grants: [{ moduleKey: "service-providers.service-provider-workspace", actions: ["view", "edit"] }],
  },
  projects: [],
  serviceProvider: { id: "01a0d2a4-a280-7003-8000-000000000001", legalName: "NordRen ApS" },
  driver: null,
}

describe("Me", () => {
  test("is the caller's account, company, role with its grants, projects and service provider", () => {
    assert.deepEqual(Me.parse(olivia), olivia)
    assert.deepEqual(Me.parse(lars), lars)
  })

  test("a custom role has no key, and a company user no service provider", () => {
    const custom = { ...olivia, role: { ...olivia.role, key: null, system: false } }
    assert.deepEqual(Me.parse(custom).role, custom.role)
    assert.equal(Me.parse(olivia).serviceProvider, null)
  })

  test("names the active driver profile bound to the account by its id, and nothing else of it", () => {
    const driving = { ...olivia, driver: { id: "01a0d2a4-a280-7019-8000-000000000001" } }
    assert.deepEqual(Me.parse(driving).driver, { id: "01a0d2a4-a280-7019-8000-000000000001" })
    assert.deepEqual(Me.parse({ ...olivia, driver: { id: "01a0d2a4-a280-7019-8000-000000000001", name: "Mads Jensen" } }).driver, {
      id: "01a0d2a4-a280-7019-8000-000000000001",
    })
    assert.equal(Me.safeParse({ ...olivia, driver: { id: "550e8400-e29b-41d4-a716-446655440000" } }).success, false, "a version 4 id")
  })

  test("the caller is always active: an invited account has no token and a deactivated one is refused before this body", () => {
    assert.equal(Me.safeParse({ ...olivia, user: { ...olivia.user, status: "invited" } }).success, false)
    assert.equal(Me.safeParse({ ...olivia, user: { ...olivia.user, status: "deactivated" } }).success, false)
  })

  test("ids are UUIDv7, grants name a known module and action, and every member is required", () => {
    assert.equal(Me.safeParse({ ...olivia, user: { ...olivia.user, id: "550e8400-e29b-41d4-a716-446655440000" } }).success, false, "a version 4 id")
    assert.equal(Me.safeParse({ ...olivia, role: { ...olivia.role, grants: [{ moduleKey: "configure.nothing", actions: ["view"] }] } }).success, false)
    assert.equal(Me.safeParse({ ...olivia, role: { ...olivia.role, grants: [{ moduleKey: "configure.access", actions: ["approve"] } ] } }).success, false)
    assert.equal(Me.safeParse({ ...olivia, user: { ...olivia.user, email: "not an address" } }).success, false)
    const { serviceProvider: _omitted, ...withoutProvider } = olivia
    assert.equal(Me.safeParse(withoutProvider).success, false, "serviceProvider is null, never absent")
    const { projects: _projects, ...withoutProjects } = olivia
    assert.equal(Me.safeParse(withoutProjects).success, false, "projects is a list, empty for a provider user")
    const { driver: _driver, ...withoutDriver } = olivia
    assert.equal(Me.safeParse(withoutDriver).success, false, "driver is null, never absent")
  })
})
