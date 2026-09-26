// The Organisation & Access mappings (Issue #81): a wire resource of the
// seeded demo company becomes the fixture record the seed derived it from, a
// row no fixture names becomes a `<prefix>-<uuid>` record, and a record the
// workspace hands back becomes exactly the body the API's contracts accept —
// held here against the contracts' own zod schemas, which the web meets in
// its tests and nowhere in its bundle (CLAUDE.md, contracts).
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { RoleCreate, RolePatch, UserInvite, UserPatch, type Role, type User } from "@waste/contracts/access"
import { CompanyPatch, ProjectCreate, ProjectPatch, ServiceProviderCreate, ServiceProviderPatch, type Company, type Project, type ServiceProvider } from "@waste/contracts/organisation"
import { resolveProjectCalendar } from "@waste/domain/route-schemes/project-calendar"

import { FIXTURE_COMPANY_ID, FIXTURE_PROJECT_IDS, FIXTURE_SERVICE_PROVIDER_IDS, getModuleDefinition, type BusinessRecord } from "../../data/business-modules"
import { isInProjectScope, isProjectRecordId, projectRecordsOf } from "../../data/project-scope"
import { NOTHING_RESOLVED, type MappingContext, type Resolver } from "../records/adapter"
import {
  accessMapOf,
  accessModule,
  ALL_PROJECTS_ACCESS,
  companyAdapter,
  grantsOf,
  grantsOfRecord,
  isCompanyRecord,
  organisationModule,
  projectAdapter,
  roleAdapter,
  roleWebIdOf,
  serviceProviderAdapter,
  serviceProvidersModule,
  userAdapter,
  weekendLabel,
} from "../records/organisation"
import { customerAdapter } from "../records/registry"

const NOW = new Date("2026-09-25T12:00:00Z")
const STAMPS = { createdAt: "2026-09-24T09:00:00.000Z", updatedAt: "2026-09-25T09:30:00.000Z" }

const fixturesOf = (workspaceId: "configure" | "service-providers", moduleId: string) => {
  const module = getModuleDefinition({ workspaceId, moduleId })
  if (!module) throw new Error(`no module ${workspaceId}.${moduleId}`)
  return module.records
}

const context = (fixtures: readonly BusinessRecord[], resolve: Resolver = NOTHING_RESOLVED, companyRecordId?: string): MappingContext => ({ fixtures, resolve, companyRecordId, now: NOW })

// The seeded demo company as the API answers it (packages/db/src/seed/demo.ts).
const COMPANY_ID = "01a0d2a4-a280-7001-8000-000000000001"
const company: Company = { id: COMPANY_ID, ...STAMPS, name: "Kystbyen Renovation", legalName: "Kystbyen Renovation A/S", registrationNumber: "12345678", country: "DK", status: "active" }
const copenhagen: Project = {
  id: "01a0d2a4-a280-7002-8000-000000000001",
  ...STAMPS,
  name: "Copenhagen Central",
  kind: "Municipality",
  language: "da",
  currency: "DKK",
  timezone: "Europe/Copenhagen",
  status: "active",
  weekend: ["saturday", "sunday"],
  holidayList: "Danish public holidays",
}
const harbor: Project = { ...copenhagen, id: "01a0d2a4-a280-7002-8000-000000000002", name: "Harbor Commercial", kind: "Business unit", status: "onboarding", holidayList: null }
const aarhus: Project = { ...copenhagen, id: "019995e0-0000-7000-8000-00000000abcd", name: "Aarhus North", kind: "Contract", weekend: ["friday", "saturday"], holidayList: null }
const nordren: ServiceProvider = { id: "01a0d2a4-a280-7003-8000-000000000001", ...STAMPS, legalName: "NordRen ApS", registrationNumber: "40291188", country: "DK", contactName: "Lars Mikkelsen", contactEmail: "lars.mikkelsen@nordren.dk" }
const administrator: Role = {
  id: "01a0d2a4-a280-7004-8000-000000000001",
  ...STAMPS,
  key: "company-administrator",
  name: "Company Administrator",
  scope: "Company",
  description: "Company, projects, users, and settings",
  system: true,
  grants: [{ moduleKey: "configure.organization", actions: ["view", "edit", "create", "delete"] }],
}
const custom: Role = { ...administrator, id: "019995e0-0000-7000-8000-0000000000aa", key: null, name: "Night Dispatch", scope: "Assigned projects", description: "Night shift", system: false, grants: [{ moduleKey: "operate.tickets", actions: ["view"] }] }
const olivia: User = {
  id: "01a0d2a4-a280-7005-8000-000000000001",
  ...STAMPS,
  email: "olivia.larsen@kystbyen.example",
  fullName: "Olivia Larsen",
  status: "active",
  roleId: administrator.id,
  allProjects: true,
  projectIds: [],
  serviceProviderId: null,
  primaryAdministrator: true,
  deactivatedAt: null,
}
const lars: User = { ...olivia, id: "01a0d2a4-a280-7005-8000-000000000002", email: "lars@nordren.dk", fullName: "Lars Mikkelsen", status: "invited", roleId: custom.id, allProjects: false, serviceProviderId: nordren.id, primaryAdministrator: false }
const viewer: User = { ...olivia, id: "019995e0-0000-7000-8000-0000000000bb", email: "viewer@kystbyen.example", fullName: "Viewer Person", roleId: custom.id, allProjects: false, projectIds: [copenhagen.id], primaryAdministrator: false }

/** A resolver over a few mapped records, the way the store composes one. */
function resolverOver(entries: Array<[BusinessRecord, string]>): Resolver {
  return {
    byServerId: (serverId) => entries.find(([, id]) => id === serverId)?.[0],
    serverIdOf: (webId) => entries.find(([record]) => record.id === webId)?.[1],
  }
}

describe("the company", () => {
  const fixtures = fixturesOf("configure", "organization")

  test("the tenant's row is the fixture company record, by its legal name, with the wire's fields over the fixture's facts", () => {
    const record = companyAdapter.toRecord(company, context(fixtures))
    assert.equal(record.id, FIXTURE_COMPANY_ID)
    assert.equal(record.name, "Kystbyen Renovation A/S")
    assert.equal(record.status, "Active")
    assert.equal(record.facts.CVR, "12345678")
    assert.equal(record.facts.Country, "Denmark")
    assert.equal(record.facts.Currency, "DKK", "a fact the wire does not carry is inherited from the fixture")
    assert.equal(record.updated, "Today")
    assert.equal(record.source, "Waste API")
    assert.equal(record.owner, "Company Admin", "presentation the wire does not carry is the fixture's")
    assert.equal(record.companyId, FIXTURE_COMPANY_ID)
  })

  test("a company the fixtures never named still takes the tenant id, since every fixture's companyId is it", () => {
    const record = companyAdapter.toRecord({ ...company, name: "Anywhere", legalName: "Anywhere A/S" }, context(fixtures))
    assert.equal(record.id, FIXTURE_COMPANY_ID)
    assert.equal(record.owner, "")
  })

  test("a patch says only what moved, and the contracts accept it", () => {
    const before = companyAdapter.toRecord(company, context(fixtures))
    const after = { ...before, submittedValues: { ...before.submittedValues, legalName: "Kystbyen Renovation ApS", country: "Denmark" } }
    const body = companyAdapter.toPatchBody(before, after, context(fixtures))
    assert.deepEqual(body, { legalName: "Kystbyen Renovation ApS" })
    assert.ok(CompanyPatch.safeParse(body).success)
    assert.equal(companyAdapter.toPatchBody(before, before, context(fixtures)), null, "nothing moved, nothing sent")
  })

  test("the registration number travels from the typed value alone; a fact is presentation and is never read back", () => {
    const before = companyAdapter.toRecord(company, context(fixtures))
    assert.equal(before.submittedValues?.registrationNumber, "12345678", "the read seeds the form, so the value is always typed")
    const factOnly = { ...before, facts: { ...before.facts, CVR: "99999999" } }
    assert.equal(companyAdapter.toPatchBody(before, factOnly, context(fixtures)), null, "a changed fact moves nothing")
    const typedChange = { ...before, submittedValues: { ...before.submittedValues, registrationNumber: "87654321" } }
    assert.deepEqual(companyAdapter.toPatchBody(before, typedChange, context(fixtures)), { registrationNumber: "87654321" })
  })

  test("the company's status is the API's to state: the adapter lists no status a patch may carry", () => {
    assert.equal(companyAdapter.statuses, undefined)
  })

  test("the tenant's record is told from a customer organisation by kind, not by the company- prefix both carry", () => {
    const tenant = companyAdapter.toRecord(company, context(fixtures))
    assert.ok(isCompanyRecord(tenant))
    const customerFixtures = getModuleDefinition({ workspaceId: "customers", moduleId: "contacts" })?.records ?? []
    const osterbro = customerAdapter.toRecord(
      { id: "01a0d2a4-a280-700b-8000-000000000002", ...STAMPS, kind: "organisation", name: "Østerbro Housing", registrationNumber: "38112009", email: null, phone: null, billingAddress: null, serviceMessagesAllowed: true, status: "active" },
      context(customerFixtures),
    )
    assert.equal(osterbro.id, "company-osterbro-housing", "the customer organisation's fixture id carries company- too")
    assert.ok(companyAdapter.owns(osterbro), "by prefix alone the company adapter would claim it")
    assert.ok(!isCompanyRecord(osterbro), "by kind it does not")
  })

  test("the company is not created here", () => {
    assert.equal(companyAdapter.toCreateBody, undefined)
    assert.equal(companyAdapter.create, undefined)
  })
})

describe("the projects", () => {
  const fixtures = fixturesOf("configure", "organization")

  test("a seeded project is its fixture record: the fixture id, the wire's fields, the fixture's presentation", () => {
    const record = projectAdapter.toRecord(copenhagen, context(fixtures, NOTHING_RESOLVED, FIXTURE_COMPANY_ID))
    assert.equal(record.id, FIXTURE_PROJECT_IDS.copenhagen)
    assert.equal(record.name, "Copenhagen Central")
    assert.equal(record.context, "Project · municipality")
    assert.equal(record.status, "Active")
    assert.deepEqual(record.projectIds, [FIXTURE_PROJECT_IDS.copenhagen], "a project record scopes itself")
    assert.equal(record.companyId, FIXTURE_COMPANY_ID)
    assert.equal(record.facts.Language, "Danish")
    assert.equal(record.facts.Weekend, "Sat–Sun")
    assert.equal(record.facts["Holiday list"], "Danish public holidays")
    assert.equal(record.facts.WeekStart, "Monday", "a fact only the fixture knows stays")
    assert.equal(record.value, "Core + Live + Invoicing")
    assert.equal(record.submittedValues?.weekend, "saturday, sunday")
    assert.equal(record.submittedValues?.holidayList, "Danish public holidays")
  })

  test("a project without a holiday list carries neither the fact nor the typed value", () => {
    const record = projectAdapter.toRecord(harbor, context(fixtures))
    assert.equal(record.id, FIXTURE_PROJECT_IDS.harbor)
    assert.equal(record.status, "Onboarding")
    assert.equal(record.facts["Holiday list"], undefined)
    assert.equal(record.submittedValues?.holidayList, undefined)
  })

  test("resolveProjectCalendar reads a server project as it reads a fixture one", () => {
    const projects = [copenhagen, harbor, aarhus].map((project) => projectAdapter.toRecord(project, context(fixtures)))
    const calendar = resolveProjectCalendar(FIXTURE_PROJECT_IDS.copenhagen, { projects, calendars: [] })
    assert.equal(calendar.list?.name, "Danish public holidays")
    assert.deepEqual(calendar.weekend, ["saturday", "sunday"])
    const cairoLike = resolveProjectCalendar(projects[2].id, { projects, calendars: [] })
    assert.equal(cairoLike.list, null)
    assert.deepEqual(cairoLike.weekend, ["friday", "saturday"])
  })

  test("a project no fixture names is project-<uuid>, which the scope vocabulary reads as a project record", () => {
    const record = projectAdapter.toRecord(aarhus, context(fixtures))
    assert.equal(record.id, `project-${aarhus.id}`)
    assert.ok(isProjectRecordId(record.id))
    assert.equal(record.facts.Weekend, "Fri–Sat")
    assert.equal(record.owner, "")
    const organisation = [companyAdapter.toRecord(company, context(fixtures)), record]
    assert.deepEqual(
      projectRecordsOf(organisation).map((project) => project.id),
      [record.id],
    )
  })

  test("a record the workspace made becomes a ProjectCreate the contracts accept, the weekend and list included", () => {
    const record: BusinessRecord = {
      ...projectAdapter.toRecord(aarhus, context(fixtures)),
      id: "organization-project-1700000000000",
      submittedValues: { name: "Aarhus North", kind: "Contract", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", weekend: "friday, saturday" },
    }
    const body = projectAdapter.toCreateBody?.(record, context(fixtures))
    assert.deepEqual(body, { name: "Aarhus North", kind: "Contract", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", weekend: ["friday", "saturday"], holidayList: null, status: "active" })
    const parsed = ProjectCreate.safeParse(body)
    assert.ok(parsed.success, JSON.stringify(parsed.error))
  })

  test("a create missing what the API requires is refused here, naming the field", () => {
    const record: BusinessRecord = { ...projectAdapter.toRecord(aarhus, context(fixtures)), submittedValues: { name: "X", kind: "Contract" } }
    assert.deepEqual(projectAdapter.toCreateBody?.(record, context(fixtures)), { path: "language", message: "A project needs a language" })
  })

  test("the Holiday lists pane's write becomes a patch of the weekend and the list, and a taken-away list is null", () => {
    const before = projectAdapter.toRecord(copenhagen, context(fixtures))
    const renamed = { ...before, submittedValues: { ...before.submittedValues, weekend: "friday, saturday", holidayList: "Egyptian public holidays" } }
    assert.deepEqual(projectAdapter.toPatchBody(before, renamed, context(fixtures)), { weekend: ["friday", "saturday"], holidayList: "Egyptian public holidays" })
    const withoutList = { ...before, submittedValues: { ...before.submittedValues } }
    delete withoutList.submittedValues.holidayList
    const body = projectAdapter.toPatchBody(before, withoutList, context(fixtures))
    assert.deepEqual(body, { holidayList: null })
    assert.ok(ProjectPatch.safeParse(body).success)
  })

  test("a controlled action that moved the status is a status patch; the adapter lists exactly the statuses the wire has, so the store refuses the rest before a patch is built", () => {
    const before = projectAdapter.toRecord(harbor, context(fixtures))
    const body = projectAdapter.toPatchBody(before, { ...before, status: "Active" }, context(fixtures))
    assert.deepEqual(body, { status: "active" })
    assert.ok(ProjectPatch.safeParse(body).success)
    assert.deepEqual(projectAdapter.statuses, ["active", "onboarding"])
    // A patch to a status the wire has no word for says nothing — which is why writeRecord refuses it first (server-records.test.ts).
    assert.equal(projectAdapter.toPatchBody(before, { ...before, status: "Suspended" }, context(fixtures)), null)
  })

  test("weekendLabel spells two consecutive days with a dash and anything else with commas", () => {
    assert.equal(weekendLabel(["saturday", "sunday"]), "Sat–Sun")
    assert.equal(weekendLabel(["friday", "saturday"]), "Fri–Sat")
    assert.equal(weekendLabel(["sunday", "monday"]), "Sun–Mon")
    assert.equal(weekendLabel(["monday", "wednesday"]), "Mon, Wed")
    assert.equal(weekendLabel([]), "")
  })
})

describe("the service providers", () => {
  const fixtures = fixturesOf("service-providers", "service-providers")

  test("a seeded provider is its fixture record with the wire's fields over it", () => {
    const record = serviceProviderAdapter.toRecord(nordren, context(fixtures))
    assert.equal(record.id, FIXTURE_SERVICE_PROVIDER_IDS.nordren)
    assert.equal(record.serviceProviderId, FIXTURE_SERVICE_PROVIDER_IDS.nordren)
    assert.equal(record.facts.CVR, "40291188")
    assert.equal(record.facts["Primary contact"], "Lars Mikkelsen")
    assert.equal(record.facts["Service area"], "CA-Ø-2", "the fixture's facts stay beside the wire's")
    assert.equal(record.status, "Active")
  })

  test("owns provider rows and none of the access, activity or price records that share the prefix", () => {
    const owns = (id: string) => serviceProviderAdapter.owns({ id } as BusinessRecord)
    assert.ok(owns("service-provider-nordren"))
    assert.ok(owns("service-provider-019995e0-0000-7000-8000-0000000000cc"))
    assert.ok(!owns("service-provider-access-nordren-manager"))
    assert.ok(!owns("service-provider-activity-proposal-88"))
    assert.ok(!owns("service-provider-price-nordren-res"))
  })

  test("the create body spells the country as a code and the contracts accept it", () => {
    const record: BusinessRecord = {
      ...serviceProviderAdapter.toRecord(nordren, context(fixtures)),
      id: "service-providers-service-provider-company-1",
      submittedValues: { legalName: "Fjord Renhold AS", registrationNumber: "998877665", country: "Norway", contactName: "Kari", contactEmail: "kari@fjord.no" },
    }
    const body = serviceProviderAdapter.toCreateBody?.(record, context(fixtures))
    assert.deepEqual(body, { legalName: "Fjord Renhold AS", registrationNumber: "998877665", country: "NO", contactName: "Kari", contactEmail: "kari@fjord.no" })
    assert.ok(ServiceProviderCreate.safeParse(body).success)
    const patch = serviceProviderAdapter.toPatchBody(record, { ...record, submittedValues: { ...record.submittedValues, contactName: "Ola" } }, context(fixtures))
    assert.deepEqual(patch, { contactName: "Ola" })
    assert.ok(ServiceProviderPatch.safeParse(patch).success)
  })
})

describe("the roles", () => {
  const fixtures = fixturesOf("configure", "access")

  test("a seeded role's web id is role-<key>, the id the charter defaults are keyed by; a custom role's is the server's", () => {
    assert.equal(roleWebIdOf(administrator), "role-company-administrator")
    assert.equal(roleWebIdOf(custom), `role-${custom.id}`)
    const record = roleAdapter.toRecord(administrator, context(fixtures))
    assert.equal(record.id, "role-company-administrator")
    assert.equal(record.facts.Type, "System")
    assert.equal(record.value, "4 permissions")
    assert.deepEqual(grantsOfRecord(record), administrator.grants)
  })

  test("the access map and the grants convert both ways, an empty entry dropped", () => {
    assert.deepEqual(accessMapOf(custom.grants), { "operate.tickets": ["view"] })
    assert.deepEqual(grantsOf({ "operate.tickets": ["view", "view"], "plan.map-planning": [] }), [{ moduleKey: "operate.tickets", actions: ["view"] }])
  })

  test("a custom role the Settings dialog made becomes a RoleCreate the contracts accept", () => {
    const record: BusinessRecord = { ...roleAdapter.toRecord(custom, context(fixtures)), id: "role-mint-1", submittedValues: { name: "Night Dispatch", scope: "Assigned projects", description: "Night shift" } }
    const body = roleAdapter.toCreateBody?.(record, context(fixtures))
    assert.deepEqual(body, { name: "Night Dispatch", scope: "Assigned projects", description: "Night shift" })
    assert.ok(RoleCreate.safeParse(body).success)
    const patch = roleAdapter.toPatchBody(record, { ...record, submittedValues: { ...record.submittedValues, description: "Nights and weekends" } }, context(fixtures))
    assert.ok(RolePatch.safeParse(patch).success)
    assert.deepEqual(patch, { description: "Nights and weekends" })
  })
})

describe("the users", () => {
  const fixtures = fixturesOf("configure", "access")
  const organisationFixtures = fixturesOf("configure", "organization")
  const roleRecord = roleAdapter.toRecord(administrator, context(fixtures))
  const customRecord = roleAdapter.toRecord(custom, context(fixtures))
  const copenhagenRecord = projectAdapter.toRecord(copenhagen, context(organisationFixtures))
  const nordrenRecord = serviceProviderAdapter.toRecord(nordren, context(fixturesOf("service-providers", "service-providers")))
  const resolve = resolverOver([
    [roleRecord, administrator.id],
    [customRecord, custom.id],
    [copenhagenRecord, copenhagen.id],
    [nordrenRecord, nordren.id],
  ])

  test("the seeded administrator is the fixture user, its role, projects and provider read through the resolver", () => {
    const record = userAdapter.toRecord(olivia, context(fixtures, resolve))
    assert.equal(record.id, "user-olivia")
    assert.equal(record.status, "Active")
    assert.equal(record.facts.Roles, "Company Administrator")
    assert.equal(record.facts.Projects, ALL_PROJECTS_ACCESS)
    assert.equal(record.facts.Email, olivia.email)
    assert.equal(record.facts["Primary administrator"], "Yes")
    assert.equal(record.submittedValues?.roleId, "role-company-administrator")
    assert.equal(record.submittedValues?.role, "Company Administrator")
    assert.equal(record.projectIds, undefined, "all projects is company-wide: no project at all, whatever the fixture was filed under")
    assert.ok(isInProjectScope(record, "project-cairo"), "so the administrator shows in a project the fixture never named")
    assert.ok(isInProjectScope(record, FIXTURE_PROJECT_IDS.copenhagen))
  })

  test("a provider's user carries the provider and an invited status, and is company-wide too", () => {
    const record = userAdapter.toRecord(lars, context(fixtures, resolve))
    assert.equal(record.status, "Invited")
    assert.equal(record.facts.Identity, "Invitation pending")
    assert.equal(record.facts["Service provider"], "NordRen ApS")
    assert.equal(record.serviceProviderId, FIXTURE_SERVICE_PROVIDER_IDS.nordren)
    assert.equal(record.submittedValues?.serviceProvider, "NordRen ApS")
    assert.equal(record.context, "NordRen ApS · service provider")
    assert.equal(record.projectIds, undefined)
  })

  test("a user with Project Access is scoped to those projects by web id", () => {
    const record = userAdapter.toRecord(viewer, context(fixtures, resolve))
    assert.equal(record.id, `user-${viewer.id}`)
    assert.deepEqual(record.projectIds, [FIXTURE_PROJECT_IDS.copenhagen])
    assert.equal(record.facts.Projects, "Copenhagen Central")
    assert.equal(record.facts.Roles, "Night Dispatch")
    assert.ok(isInProjectScope(record, FIXTURE_PROJECT_IDS.copenhagen))
    assert.ok(!isInProjectScope(record, "project-cairo"), "and hidden from a project it does not work in")
  })

  test("a role the resolver does not know reads as Role and keeps the server id, so the row still shows", () => {
    const record = userAdapter.toRecord(viewer, context(fixtures))
    assert.equal(record.facts.Roles, "Role")
    assert.equal(record.submittedValues?.roleId, custom.id)
  })

  test("an invitation becomes a UserInvite the contracts accept, one way of reaching things at a time", () => {
    const base = userAdapter.toRecord(viewer, context(fixtures, resolve))
    const allProjects: BusinessRecord = { ...base, id: "user-mint-1", submittedValues: { fullName: "New Person", email: "new@kystbyen.example", roleId: "role-company-administrator", projectAccess: ALL_PROJECTS_ACCESS } }
    const invite = userAdapter.toCreateBody?.(allProjects, context(fixtures, resolve))
    assert.deepEqual(invite, { email: "new@kystbyen.example", fullName: "New Person", roleId: administrator.id, allProjects: true })
    assert.ok(UserInvite.safeParse(invite).success)

    const selected: BusinessRecord = { ...allProjects, submittedValues: { ...allProjects.submittedValues, projectAccess: "Copenhagen Central", projectIds: FIXTURE_PROJECT_IDS.copenhagen } }
    const invite2 = userAdapter.toCreateBody?.(selected, context(fixtures, resolve))
    assert.deepEqual(invite2, { email: "new@kystbyen.example", fullName: "New Person", roleId: administrator.id, projectIds: [copenhagen.id] })
    assert.ok(UserInvite.safeParse(invite2).success)

    const provider: BusinessRecord = { ...allProjects, serviceProviderId: FIXTURE_SERVICE_PROVIDER_IDS.nordren, submittedValues: { ...allProjects.submittedValues, projectAccess: "Service provider", roleId: `role-${custom.id}` } }
    const invite3 = userAdapter.toCreateBody?.(provider, context(fixtures, resolve))
    assert.deepEqual(invite3, { email: "new@kystbyen.example", fullName: "New Person", roleId: custom.id, serviceProviderId: nordren.id })
    assert.ok(UserInvite.safeParse(invite3).success)
  })

  test("an invitation naming a role or a project the server does not hold is refused here", () => {
    const base = userAdapter.toRecord(viewer, context(fixtures, resolve))
    const noRole: BusinessRecord = { ...base, id: "user-mint-2", submittedValues: { fullName: "X", email: "x@y.example", roleId: "role-nowhere", projectAccess: ALL_PROJECTS_ACCESS } }
    assert.deepEqual(userAdapter.toCreateBody?.(noRole, context(fixtures, resolve)), { path: "roleId", message: "Pick a role" })
    const noProjects: BusinessRecord = { ...base, id: "user-mint-3", projectIds: ["project-nowhere"], submittedValues: { fullName: "X", email: "x@y.example", roleId: "role-company-administrator", projectAccess: "Nowhere", projectIds: "project-nowhere" } }
    assert.deepEqual(userAdapter.toCreateBody?.(noProjects, context(fixtures, resolve)), { path: "projectIds", message: "Pick the projects the user works in, or all of them" })
  })

  test("a renamed or re-roled user is a UserPatch the contracts accept", () => {
    const before = userAdapter.toRecord(viewer, context(fixtures, resolve))
    const body = userAdapter.toPatchBody(before, { ...before, submittedValues: { ...before.submittedValues, fullName: "Viewer Renamed", roleId: "role-company-administrator" } }, context(fixtures, resolve))
    assert.deepEqual(body, { fullName: "Viewer Renamed", roleId: administrator.id })
    assert.ok(UserPatch.safeParse(body).success)
  })
})

describe("what an adapter owns", () => {
  test("a fixture's id, a webIdOf, and a record the workspace just made under the form's recordKind", () => {
    const minted = (id: string, recordKind?: string) => ({ id, recordKind }) as BusinessRecord
    assert.ok(projectAdapter.owns(minted("project-copenhagen")))
    assert.ok(projectAdapter.owns(minted(`project-${aarhus.id}`)))
    assert.ok(projectAdapter.owns(minted("organization-project-1700000000000", "Project")))
    assert.ok(!projectAdapter.owns(minted("organization-project-1700000000000")), "a minted id without its kind is nobody's")
    assert.ok(!projectAdapter.owns(minted("company-kystbyen-dk", "Company")))
    assert.ok(userAdapter.owns(minted("access-user-1700000000000", "User")))
    assert.ok(userAdapter.owns(minted("service-provider-workspace-service-provider-user-1", "Service provider user")))
    assert.ok(!userAdapter.owns(minted("role-company-administrator", "Role")))
    assert.ok(roleAdapter.owns(minted("access-role-1", "Role")))
    assert.ok(serviceProviderAdapter.owns(minted("service-providers-service-provider-company-1", "Service provider company")))
  })
})

describe("the modules", () => {
  test("the organisation module lists the company before the projects, and access the roles before the users", () => {
    assert.deepEqual(
      organisationModule.resources.map((resource) => resource.prefix),
      ["company", "project"],
    )
    assert.deepEqual(
      accessModule.resources.map((resource) => resource.prefix),
      ["role", "user"],
    )
    assert.deepEqual(
      serviceProvidersModule.resources.map((resource) => resource.prefix),
      ["service-provider"],
    )
  })
})
