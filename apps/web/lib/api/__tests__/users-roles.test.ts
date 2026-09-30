// Settings › Users & roles on the Pilot (Issue #163), at the record store's
// seam and without React: the record Add user builds becomes the `UserInvite`
// body in each of its three forms, held against the contracts' own schema; a
// picker value that names no loaded record is refused before any request;
// the API's 409 and 400 come back as its own sentences; the lists are the
// API's rows when the adapter is configured and the prototype's merge when it
// is not — never both; and the pickers read what the store loaded.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { UserInvite, type Role, type User } from "@waste/contracts/access"
import type { Company, Project, ServiceProvider } from "@waste/contracts/organisation"

import { FIXTURE_COMPANY_ID, FIXTURE_PROJECT_IDS, FIXTURE_SERVICE_PROVIDER_IDS, getModuleDefinition, type BusinessRecord } from "../../data/business-modules"
import {
  COMPANY_ADMINISTRATOR_ROLE_ID,
  coversEveryProject,
  inviteRecord,
  pilotEmptyState,
  projectPickerOptions,
  providerPickerOptions,
  rolePickerOptions,
  roleRowsOf,
  userRowsOf,
  type FixtureUsersRoles,
  type Invite,
} from "../../data/users-roles"
import { problemSentence } from "../problem"
import { NOTHING_RESOLVED, type MappingContext, type Resolver } from "../records/adapter"
import { accessModule, companyAdapter, projectAdapter, roleAdapter, roleWebIdOf, SERVICE_PROVIDER_ACCESS, serviceProviderAdapter, userAdapter } from "../records/organisation"
import { IDLE, loaded, loadFailed, loading, notGranted, resolverOver, writeRecord, type ServerRecordsState } from "../records/server-records"
import { bodyOf, clientOver, json, problem, scripted } from "./scripted-fetch"

const NOW = new Date("2026-09-25T12:00:00Z")
const STAMPS = { createdAt: "2026-09-24T09:00:00.000Z", updatedAt: "2026-09-25T09:30:00.000Z" }

const fixturesOf = (workspaceId: "configure" | "service-providers", moduleId: string) => {
  const module = getModuleDefinition({ workspaceId, moduleId })
  if (!module) throw new Error(`no module ${workspaceId}.${moduleId}`)
  return module.records
}
const accessFixtures = fixturesOf("configure", "access")
const organisationFixtures = fixturesOf("configure", "organization")
const providerFixtures = fixturesOf("service-providers", "service-providers")
const providerWorkspaceFixtures = fixturesOf("service-providers", "service-provider-workspace")

const context = (fixtures: readonly BusinessRecord[], resolve: Resolver = NOTHING_RESOLVED): MappingContext => ({ fixtures, resolve, now: NOW })

// The seeded demo company as the API answers it.
const company: Company = { id: "01a0d2a4-a280-7001-8000-000000000001", ...STAMPS, name: "Kystbyen Renovation", legalName: "Kystbyen Renovation A/S", registrationNumber: "12345678", country: "DK", status: "active" }
const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: null }
const harbor: Project = { ...copenhagen, id: "01a0d2a4-a280-7002-8000-000000000002", name: "Harbor Commercial", kind: "Business unit", status: "onboarding" }
const nordren: ServiceProvider = { id: "01a0d2a4-a280-7003-8000-000000000001", ...STAMPS, legalName: "NordRen ApS", registrationNumber: "40291188", country: "DK", contactName: "Lars Mikkelsen", contactEmail: "contact@nordren.example" }
const administrator: Role = { id: "01a0d2a4-a280-7004-8000-000000000001", ...STAMPS, key: "company-administrator", name: "Company Administrator", scope: "Company", description: "Company, projects, users, and settings", system: true, grants: [] }
const dispatcher: Role = { ...administrator, id: "01a0d2a4-a280-7004-8000-000000000003", key: "dispatcher", name: "Dispatcher", scope: "Assigned projects", description: "Live routes, assignments, and tickets" }
const nightShift: Role = { ...administrator, id: "019995e0-0000-7000-8000-0000000000aa", key: null, name: "Night Dispatch", scope: "Assigned projects", description: "Night shift", system: false }
const olivia: User = { id: "01a0d2a4-a280-7005-8000-000000000001", ...STAMPS, email: "olivia.larsen@kystbyen.example", fullName: "Olivia Larsen", status: "active", roleId: administrator.id, allProjects: true, projectIds: [], serviceProviderId: null, primaryAdministrator: true, deactivatedAt: null }
const lars: User = { ...olivia, id: "01a0d2a4-a280-7005-8000-000000000002", email: "lars.mikkelsen@nordren.example", fullName: "Lars Mikkelsen", status: "invited", roleId: nightShift.id, allProjects: false, serviceProviderId: nordren.id, primaryAdministrator: false }
const mads: User = { ...olivia, id: "01a0d2a4-a280-7005-8000-000000000003", email: "mads.jensen@kystbyen.example", fullName: "Mads Jensen", status: "deactivated", roleId: dispatcher.id, allProjects: false, projectIds: [copenhagen.id], primaryAdministrator: false, deactivatedAt: "2026-09-25T10:00:00.000Z" }

// The store's state once the organisation, the providers and the access module have loaded, in that order.
const companyRecord = companyAdapter.toRecord(company, context(organisationFixtures))
const copenhagenRecord = projectAdapter.toRecord(copenhagen, context(organisationFixtures))
const harborRecord = projectAdapter.toRecord(harbor, context(organisationFixtures))
const nordrenRecord = serviceProviderAdapter.toRecord(nordren, context(providerFixtures))
const administratorRecord = roleAdapter.toRecord(administrator, context(accessFixtures))
const dispatcherRecord = roleAdapter.toRecord(dispatcher, context(accessFixtures))
const nightShiftRecord = roleAdapter.toRecord(nightShift, context(accessFixtures))
const earlier: ServerRecordsState = new Map([
  ["configure.organization", loaded({ records: [companyRecord, copenhagenRecord, harborRecord], serverIds: new Map([[companyRecord.id, company.id], [copenhagenRecord.id, copenhagen.id], [harborRecord.id, harbor.id]]) }, 1)],
  ["service-providers.service-providers", loaded({ records: [nordrenRecord], serverIds: new Map([[nordrenRecord.id, nordren.id]]) }, 1)],
])
const roleIds = new Map([[administratorRecord.id, administrator.id], [dispatcherRecord.id, dispatcher.id], [nightShiftRecord.id, nightShift.id]])
const byServerId = new Map([[administrator.id, administratorRecord], [dispatcher.id, dispatcherRecord], [nightShift.id, nightShiftRecord]])
const resolve = resolverOver(earlier, { records: [administratorRecord, dispatcherRecord, nightShiftRecord], serverIds: roleIds, byServerId })
const oliviaRecord = userAdapter.toRecord(olivia, context(accessFixtures, resolve))
const larsRecord = userAdapter.toRecord(lars, context(accessFixtures, resolve))
const madsRecord = userAdapter.toRecord(mads, context(accessFixtures, resolve))
const access = loaded(
  {
    records: [administratorRecord, dispatcherRecord, nightShiftRecord, oliviaRecord, larsRecord, madsRecord],
    serverIds: new Map([...roleIds, [oliviaRecord.id, olivia.id], [larsRecord.id, lars.id], [madsRecord.id, mads.id]]),
  },
  1,
)
const state: ServerRecordsState = new Map([...earlier, ["configure.access", access]])
const options = { fixtures: accessFixtures, state, now: NOW }
const invitedContext = (): MappingContext => ({ fixtures: accessFixtures, resolve: resolverOver(state), companyRecordId: companyRecord.id, now: NOW })

const newPerson: Omit<Invite, "access"> = { fullName: "New Person", email: "new.person@kystbyen.example", role: { id: dispatcherRecord.id, name: "Dispatcher" }, companyRecordId: companyRecord.id }

const ways = (body: unknown) => Object.keys(body as object).filter((key) => ["allProjects", "projectIds", "serviceProviderId"].includes(key))

describe("the invitation Add user builds", () => {
  test("every project: the record becomes a UserInvite with allProjects and nothing else about access", () => {
    const record = inviteRecord({ ...newPerson, access: { kind: "all-projects" } }, "access-user-1")
    assert.equal(record.id, "access-user-1")
    assert.equal(record.recordKind, "User", "so the user adapter owns it before the server has answered")
    assert.ok(userAdapter.owns(record))
    assert.equal(record.status, "Invited")
    assert.equal(record.facts.Identity, "Invitation pending")
    assert.equal(record.facts.Projects, "All projects")
    assert.equal(record.companyId, companyRecord.id)
    const body = userAdapter.toCreateBody?.(record, invitedContext())
    assert.deepEqual(body, { email: "new.person@kystbyen.example", fullName: "New Person", roleId: dispatcher.id, allProjects: true })
    assert.deepEqual(ways(body), ["allProjects"])
    assert.ok(UserInvite.safeParse(body).success)
  })

  test("some projects: the projects by their web ids, resolved to the server's, and the label names them", () => {
    const record = inviteRecord({ ...newPerson, access: { kind: "projects", projects: [{ id: copenhagenRecord.id, name: "Copenhagen Central" }, { id: harborRecord.id, name: "Harbor Commercial" }] } }, "access-user-2")
    assert.deepEqual(record.projectIds, [FIXTURE_PROJECT_IDS.copenhagen, FIXTURE_PROJECT_IDS.harbor])
    assert.equal(record.facts.Projects, "Copenhagen Central, Harbor Commercial")
    const body = userAdapter.toCreateBody?.(record, invitedContext())
    assert.deepEqual(body, { email: "new.person@kystbyen.example", fullName: "New Person", roleId: dispatcher.id, projectIds: [copenhagen.id, harbor.id] })
    assert.deepEqual(ways(body), ["projectIds"])
    assert.ok(UserInvite.safeParse(body).success)
  })

  test("a service provider: the provider by its web id, and no project at all", () => {
    const record = inviteRecord({ ...newPerson, role: { id: nightShiftRecord.id, name: "Night Dispatch" }, access: { kind: "service-provider", provider: { id: nordrenRecord.id, name: "NordRen ApS" } } }, "access-user-3")
    assert.equal(record.serviceProviderId, FIXTURE_SERVICE_PROVIDER_IDS.nordren)
    assert.equal(record.projectIds, undefined)
    assert.equal(record.facts["Service provider"], "NordRen ApS")
    assert.equal(record.context, "NordRen ApS · service provider")
    const body = userAdapter.toCreateBody?.(record, invitedContext())
    assert.deepEqual(body, { email: "new.person@kystbyen.example", fullName: "New Person", roleId: nightShift.id, serviceProviderId: nordren.id })
    assert.deepEqual(ways(body), ["serviceProviderId"])
    assert.ok(UserInvite.safeParse(body).success)
  })

  test("a project that happens to be named \"All projects\", ticked under selected projects, is sent as that project and never as every project", () => {
    const record = inviteRecord({ ...newPerson, access: { kind: "projects", projects: [{ id: copenhagenRecord.id, name: "All projects" }] } }, "access-user-11")
    const body = userAdapter.toCreateBody?.(record, invitedContext())
    assert.deepEqual(body, { email: "new.person@kystbyen.example", fullName: "New Person", roleId: dispatcher.id, projectIds: [copenhagen.id] })
    assert.deepEqual(ways(body), ["projectIds"])
  })

  test("the address is sent as typed, trimmed and lowercased, since it is what the hook binds on", () => {
    const record = inviteRecord({ ...newPerson, email: "  New.Person@Kystbyen.example ", access: { kind: "all-projects" } }, "access-user-4")
    const body = userAdapter.toCreateBody?.(record, invitedContext()) as { email: string }
    assert.equal(body.email, "new.person@kystbyen.example")
    assert.equal(record.facts.Email, "new.person@kystbyen.example")
  })
})

describe("the invitation through the store's write", () => {
  test("is POST /users with exactly the UserInvite body, and the answer is the account as the API wrote it, invited", async () => {
    const written: User = { ...olivia, id: "019995e0-0000-7000-8000-0000000000cc", email: "new.person@kystbyen.example", fullName: "New Person", status: "invited", roleId: dispatcher.id, allProjects: false, projectIds: [copenhagen.id], primaryAdministrator: false }
    const { fetch, calls } = scripted([() => json(written, 201, { location: `/users/${written.id}` })])
    const record = inviteRecord({ ...newPerson, access: { kind: "projects", projects: [{ id: copenhagenRecord.id, name: "Copenhagen Central" }] } }, "access-user-5")
    const outcome = await writeRecord(clientOver(fetch), accessModule, access, record, options)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, "http://api.test/users")
    assert.equal(calls[0].init.method, "POST")
    assert.deepEqual(bodyOf(calls[0]), { email: "new.person@kystbyen.example", fullName: "New Person", roleId: dispatcher.id, projectIds: [copenhagen.id] })
    assert.equal(outcome.kind, "created")
    if (outcome.kind !== "created") return
    assert.equal(outcome.optimisticId, "access-user-5")
    assert.equal(outcome.serverId, written.id)
    assert.equal(outcome.record.status, "Invited")
    assert.equal(outcome.record.facts.Identity, "Invitation pending")
    assert.equal(outcome.record.facts.Roles, "Dispatcher")
    assert.equal(outcome.record.facts.Projects, "Copenhagen Central")
  })

  test("an address the company already has is the API's 409, in its sentence", async () => {
    const detail = 'This company already has a user with the e-mail address "olivia.larsen@kystbyen.example"'
    const { fetch } = scripted([() => problem(409, detail)])
    const record = inviteRecord({ ...newPerson, email: "olivia.larsen@kystbyen.example", access: { kind: "all-projects" } }, "access-user-6")
    const outcome = await writeRecord(clientOver(fetch), accessModule, access, record, options)
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.equal(outcome.recordId, "access-user-6")
    assert.equal(outcome.problem.status, 409)
    assert.equal(problemSentence(outcome.problem), detail)
  })

  test("a 400 names the field, and the sentence carries it", async () => {
    const { fetch } = scripted([() => problem(400, "The request body is invalid", [{ path: "email", message: "Invalid email address" }])])
    const record = inviteRecord({ ...newPerson, email: "not-an-address", access: { kind: "all-projects" } }, "access-user-7")
    const outcome = await writeRecord(clientOver(fetch), accessModule, access, record, options)
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.equal(outcome.problem.status, 400)
    assert.equal(problemSentence(outcome.problem), "The request body is invalid — email: Invalid email address")
  })

  test("a role the store has not loaded is refused before any request", async () => {
    const { fetch, calls } = scripted([])
    const record = inviteRecord({ ...newPerson, role: { id: "role-made-in-the-browser", name: "Browser Role" }, access: { kind: "all-projects" } }, "access-user-8")
    const outcome = await writeRecord(clientOver(fetch), accessModule, access, record, options)
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.deepEqual(calls, [])
    assert.deepEqual(outcome.problem.errors, [{ path: "roleId", message: "Pick a role" }])
  })

  test("a project the store has not loaded is refused before any request, even beside one it has", async () => {
    const { fetch, calls } = scripted([])
    const record = inviteRecord({ ...newPerson, access: { kind: "projects", projects: [{ id: copenhagenRecord.id, name: "Copenhagen Central" }, { id: "project-nowhere", name: "Nowhere" }] } }, "access-user-9")
    const outcome = await writeRecord(clientOver(fetch), accessModule, access, record, options)
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.deepEqual(calls, [])
    assert.deepEqual(outcome.problem.errors, [{ path: "projectIds", message: "Pick the projects the user works in, or all of them" }])
  })

  test("a service provider the store has not loaded is refused before any request", async () => {
    const { fetch, calls } = scripted([])
    const record = inviteRecord({ ...newPerson, access: { kind: "service-provider", provider: { id: "service-provider-nowhere", name: "Nowhere ApS" } } }, "access-user-10")
    const outcome = await writeRecord(clientOver(fetch), accessModule, access, record, options)
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.deepEqual(calls, [])
    assert.deepEqual(outcome.problem.errors, [{ path: "serviceProviderId", message: "Not a service provider of this company" }])
  })
})

// The prototype's own sources, as the organisation store hands them to the pane.
const fixtureSources: FixtureUsersRoles = {
  organizationUsers: [
    { id: "user-olivia", companyId: FIXTURE_COMPANY_ID, fullName: "Olivia Larsen", email: "olivia.larsen@kystbyen.example", role: "Company Administrator", status: "Active", accessMode: "all-company-projects", projectIds: [], isPrimaryAdministrator: true },
    { id: "user-browser-1", companyId: FIXTURE_COMPANY_ID, fullName: "Browser Person", email: "browser.person@kystbyen.example", role: "Dispatcher", status: "Invited", accessMode: "selected-projects", projectIds: [FIXTURE_PROJECT_IDS.copenhagen], isPrimaryAdministrator: false },
  ],
  companies: [{ id: FIXTURE_COMPANY_ID, name: "Kystbyen Renovation" }],
  projects: [{ id: FIXTURE_PROJECT_IDS.copenhagen, name: "Copenhagen Central" }],
  roles: [
    { id: "role-company-administrator", name: "Company Administrator", type: "System", scope: "Company", permissions: "Company, projects, users, and settings" },
    { id: "role-browser-only", name: "Browser Role", type: "Custom", scope: "Assigned projects", permissions: "Custom permissions" },
  ],
  accessRecords: accessFixtures,
  serviceProviderAccessRecords: providerWorkspaceFixtures,
}

describe("what the Users tab lists", () => {
  test("with the adapter configured and the module ready: the API's users alone, no fixture and no browser record", () => {
    const rows = userRowsOf({ kind: "api", module: access, companyName: "Kystbyen Renovation" })
    assert.deepEqual(rows.map((row) => row.name), ["Lars Mikkelsen", "Mads Jensen", "Olivia Larsen"], "sorted by name; the roles are not users")
    const [larsRow, madsRow, oliviaRow] = rows
    assert.equal(oliviaRow.email, "olivia.larsen@kystbyen.example")
    assert.equal(oliviaRow.role, "Company Administrator")
    assert.equal(oliviaRow.organization, "Kystbyen Renovation")
    assert.equal(oliviaRow.projectAccess, "All projects")
    assert.equal(oliviaRow.status, "Active")
    assert.equal(oliviaRow.primaryAdministrator, true)
    assert.equal(larsRow.organization, "NordRen ApS")
    assert.equal(larsRow.projectAccess, "Service provider")
    assert.equal(larsRow.status, "Invited")
    assert.equal(madsRow.projectAccess, "Copenhagen Central")
    assert.equal(madsRow.status, "Deactivated")
    assert.equal(madsRow.primaryAdministrator, false)
    assert.ok(!rows.some((row) => row.name === "Temporary Integration User"), "the fixture user is not mixed in")
  })

  test("with the adapter configured and the module not yet ready, or failed: nothing, never the fixtures", () => {
    assert.deepEqual(userRowsOf({ kind: "api", module: IDLE, companyName: "Kystbyen Renovation" }), [])
    assert.deepEqual(userRowsOf({ kind: "api", module: loading(IDLE), companyName: "Kystbyen Renovation" }), [])
    assert.deepEqual(userRowsOf({ kind: "api", module: loadFailed(loading(IDLE), { type: "about:blank", title: "Service Unavailable", status: 503 }), companyName: "Kystbyen Renovation" }), [])
  })

  test("without the adapter: the organisation store's users, the fixture access users and the service-provider workspace's, as before", () => {
    const rows = userRowsOf({ kind: "fixtures", ...fixtureSources })
    const names = rows.map((row) => row.name)
    assert.ok(names.includes("Olivia Larsen"))
    assert.ok(names.includes("Browser Person"))
    assert.ok(names.includes("Temporary Integration User"), "a fixture access user")
    assert.equal(names.filter((name) => name === "Olivia Larsen").length, 1, "the fixture record of a store user is not listed twice")
    for (const record of providerWorkspaceFixtures) {
      const expected = record.owner && record.owner !== "Contract Team" ? record.owner : record.name
      assert.ok(names.includes(expected), `the provider workspace's ${expected}`)
    }
    const browser = rows.find((row) => row.name === "Browser Person")
    assert.equal(browser?.projectAccess, "Copenhagen Central")
    assert.equal(browser?.organization, "Kystbyen Renovation")
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)))
  })
})

describe("what the Roles tab lists", () => {
  test("with the adapter configured: the API's roles, their type, scope and description", () => {
    const rows = roleRowsOf({ kind: "api", module: access, companyName: "Kystbyen Renovation" })
    assert.deepEqual(
      rows.map((row) => [row.id, row.name, row.type, row.scope, row.permissions]),
      [
        ["role-company-administrator", "Company Administrator", "System", "Company", "Company, projects, users, and settings"],
        ["role-dispatcher", "Dispatcher", "System", "Assigned projects", "Live routes, assignments, and tickets"],
        [`role-${nightShift.id}`, "Night Dispatch", "Custom", "Assigned projects", "Night shift"],
      ],
    )
    assert.deepEqual(roleRowsOf({ kind: "api", module: loading(IDLE), companyName: "Kystbyen Renovation" }), [])
  })

  test("without the adapter: the organisation store's roles, a browser-made one included", () => {
    const rows = roleRowsOf({ kind: "fixtures", ...fixtureSources })
    assert.deepEqual(rows.map((row) => row.name), ["Company Administrator", "Browser Role"])
  })
})

describe("what the pane says while it has no rows on the Pilot", () => {
  test("a module still loading: a reading sentence and the rule, for either noun; a failed one: the API's own detail", () => {
    assert.deepEqual(pilotEmptyState(IDLE, "users"), { message: "Reading the company's users from the API…", hint: "The list shows the API's users and nothing else." })
    assert.deepEqual(pilotEmptyState(loading(IDLE), "roles"), { message: "Reading the company's roles from the API…", hint: "The list shows the API's roles and nothing else." })
    const failed = loadFailed(loading(IDLE), { type: "about:blank", title: "Forbidden", status: 403, detail: "Your role does not allow view on configure.access" })
    assert.deepEqual(pilotEmptyState(failed, "roles"), { message: "The roles could not be read from the API.", hint: "Your role does not allow view on configure.access" })
    assert.deepEqual(pilotEmptyState(loadFailed(loading(IDLE), { type: "about:blank", title: "Service Unavailable", status: 503 }), "users"), { message: "The users could not be read from the API.", hint: "Service Unavailable" })
    assert.equal(pilotEmptyState(access, "users"), null)
  })

  test("a module the role does not view: the pane says it is not the role's to see, in the store's sentence, and never that a read is out or broke", () => {
    assert.deepEqual(pilotEmptyState(notGranted("configure.access"), "users"), { message: "The users are not shown to your role.", hint: "Your role does not allow view on configure.access" })
    assert.deepEqual(pilotEmptyState(notGranted("configure.access"), "roles"), { message: "The roles are not shown to your role.", hint: "Your role does not allow view on configure.access" })
  })
})

describe("a provider user whose provider the store could not resolve", () => {
  test("is listed under \"Service provider\", never under the company", () => {
    const withoutProviders = resolverOver(new Map([["configure.access", loaded({ records: [nightShiftRecord], serverIds: new Map([[nightShiftRecord.id, nightShift.id]]) }, 1)]]))
    const unresolved = userAdapter.toRecord(lars, context(accessFixtures, withoutProviders))
    assert.equal(unresolved.facts["Service provider"], undefined)
    assert.equal(unresolved.facts.Projects, SERVICE_PROVIDER_ACCESS)
    const rows = userRowsOf({ kind: "api", module: loaded({ records: [unresolved], serverIds: new Map([[unresolved.id, lars.id]]) }, 1), companyName: "Kystbyen Renovation" })
    assert.equal(rows[0].organization, SERVICE_PROVIDER_ACCESS)
    assert.equal(rows[0].projectAccess, SERVICE_PROVIDER_ACCESS)
  })
})

describe("the role that covers every project", () => {
  test("is the seeded Company Administrator by its web id, whatever it is called today", () => {
    assert.equal(COMPANY_ADMINISTRATOR_ROLE_ID, roleWebIdOf(administrator))
    assert.ok(coversEveryProject(administratorRecord.id))
    const renamed: Role = { ...administrator, name: "Tenant Owner" }
    assert.ok(coversEveryProject(roleAdapter.toRecord(renamed, context(accessFixtures)).id), "a renamed seeded role keeps its key")
    assert.ok(!coversEveryProject(dispatcherRecord.id))
    const impostor: Role = { ...nightShift, name: "Company Administrator" }
    assert.ok(!coversEveryProject(roleAdapter.toRecord(impostor, context(accessFixtures)).id), "a custom role with the name is not it")
  })
})

describe("the pickers on the Pilot", () => {
  test("the roles are the access module's role records, by web id, so a role that exists only in the browser is never offered", () => {
    assert.deepEqual(rolePickerOptions(access.records), [
      { id: "role-company-administrator", name: "Company Administrator" },
      { id: "role-dispatcher", name: "Dispatcher" },
      { id: `role-${nightShift.id}`, name: "Night Dispatch" },
    ])
    assert.deepEqual(rolePickerOptions([]), [])
  })

  test("the projects are the organisation module's project records, not its company row", () => {
    assert.deepEqual(projectPickerOptions([companyRecord, copenhagenRecord, harborRecord]), [
      { id: FIXTURE_PROJECT_IDS.copenhagen, name: "Copenhagen Central" },
      { id: FIXTURE_PROJECT_IDS.harbor, name: "Harbor Commercial" },
    ])
  })

  test("the service providers are the providers module's rows", () => {
    assert.deepEqual(providerPickerOptions([nordrenRecord]), [{ id: FIXTURE_SERVICE_PROVIDER_IDS.nordren, name: "NordRen ApS" }])
  })
})
