// Organisation & Access on the prototype's records (Issue #81): the company
// and its projects as the `configure.organization` module, users and roles as
// `configure.access`, and the service providers as
// `service-providers.service-providers`. The wire shapes are the contracts'
// (`@waste/contracts/organisation`, `access`), imported as types so no zod
// reaches the bundle; the routes are apps/api/src/routes/{company,projects,
// service-providers,users,roles}.ts.
//
// What each record carries from the wire, and what it inherits from its
// fixture, is set out per adapter. The organisation module's project records
// are what the workspace scopes by (lib/data/project-scope.ts): a project's
// web id is its fixture's when the seed derived it from one and
// `project-<uuid>` otherwise, so both spell the `project-` prefix that
// `isProjectRecordId` reads; and `weekend` and `holidayList` land on
// `submittedValues` exactly as the Holiday lists pane writes them
// (lib/data/holiday-lists.ts), so `resolveProjectCalendar` reads a server
// project as it read a fixture one. A role's web id is `role-<key>` for a
// seeded role, since that is how lib/data/role-permissions.ts keys the
// charter defaults and how the restricted shells name the role they run as.
//
// A user names its role, its projects and its provider by server id, and the
// form names them back by web id: the mapping reads both through the
// context's resolver, which the store composes over what it has loaded, so
// the access module lists its roles before its users and the organisation
// and service-provider modules are loaded first (records/modules.ts).
import type { Role, User } from "@waste/contracts/access"
import type { Company, Project, ServiceProvider } from "@waste/contracts/organisation"
import type { Grant } from "@waste/contracts/permissions"

import { FIXTURE_COMPANY_ID, type BusinessRecord } from "@/lib/data/business-modules"
import type { RoleAccessMap } from "@/lib/data/role-permissions"

import { command, create, get, listAll, patch, put } from "../client"
import {
  countryCode,
  countryName,
  fixtureNamed,
  hasPrefix,
  inheritedPresentation,
  ofKind,
  languageName,
  patchOf,
  stampFacts,
  statusLabel,
  statusToken,
  typed,
  webIdOf,
  type Client,
  type LocalRefusal,
  type MappingContext,
  type ResourceAdapter,
  type ServerModule,
} from "./adapter"

const refusal = (path: string, message: string): LocalRefusal => ({ path, message })

// ---------------------------------------------------------------------------
// Company
// ---------------------------------------------------------------------------

/** The company is one row with no collection: read at `/company`, changed there, created by nobody here. */
export const companyAdapter: ResourceAdapter<Company> = {
  prefix: "company",
  owns: hasPrefix("company"),
  // `CompanyPatch` (`@waste/contracts/organisation`) has no status member: the API states the company's status, so every move is refused by the store and the workspace offers none.
  statuses: undefined,
  list: async (client) => [await get<Company>(client, "/company")],
  toRecord: (company, context) => {
    const fixture = fixtureNamed(context.fixtures, "company", [company.legalName, company.name])
    // The caller's company is the one the fixtures call the tenant, whatever
    // it is named: every fixture record's `companyId` is this id, and the
    // organisation store's tenant is it too.
    const id = fixture?.id ?? FIXTURE_COMPANY_ID
    return {
      id,
      name: company.legalName,
      context: "Company · tenant",
      status: statusLabel(company.status),
      ...inheritedPresentation(fixture),
      ...stampFacts(company, context.now),
      facts: {
        ...fixture?.facts,
        Name: company.name,
        CVR: company.registrationNumber,
        Country: countryName(company.country),
      },
      companyId: id,
      projectIds: fixture?.projectIds,
      recordKind: "Company",
      submittedValues: {
        ...fixture?.submittedValues,
        name: company.name,
        legalName: company.legalName,
        registrationNumber: company.registrationNumber,
        country: company.country,
      },
    }
  },
  toPatchBody: (before, after) =>
    patchOf(before, after, (record) => ({
      name: typed(record, "name"),
      legalName: typed(record, "legalName") ?? record.name,
      // The form seeds `registrationNumber` from the read above, so it is always typed; a fact is presentation and never read back.
      registrationNumber: typed(record, "registrationNumber"),
      country: typed(record, "country") === undefined ? undefined : countryCode(typed(record, "country") as string),
    })),
  update: (client, _serverId, body) => patch<Company>(client, "/company", body),
}

/**
 * The tenant's own record among the organisation module's: the company
 * adapter's row, by its `owns` and its kind — the `company-` prefix alone is
 * a customer organisation's too (registry.ts).
 */
export const isCompanyRecord = (record: BusinessRecord): boolean => companyAdapter.owns(record) && record.recordKind === "Company"

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/** `Project · municipality`, the fixture's context shape, from the wire's free-text kind. */
const projectContext = (kind: string) => `Project · ${kind.toLowerCase()}`

/** The wire's project statuses (`@waste/contracts/organisation`, `ProjectStatus`); the module's lifecycle also lists Suspended and Archived, which the API has no column for. */
const PROJECT_STATUSES: readonly Project["status"][] = ["active", "onboarding"]

export const projectAdapter: ResourceAdapter<Project> = {
  prefix: "project",
  // A fixture's or a `webIdOf`, or a row the workspace just made under the organisation module's form (`recordKind: "Project"`).
  owns: ofKind("project", ["Project"]),
  statuses: PROJECT_STATUSES,
  list: (client) => listAll<Project>(client, "/projects"),
  toRecord: (project, context) => {
    const fixture = fixtureNamed(context.fixtures, "project", [project.name])
    const id = fixture?.id ?? webIdOf("project", project.id)
    const facts: Record<string, string> = {
      ...fixture?.facts,
      Language: languageName(project.language),
      Currency: project.currency,
      Timezone: project.timezone,
      Weekend: weekendLabel(project.weekend),
    }
    if (project.holidayList === null) delete facts["Holiday list"]
    else facts["Holiday list"] = project.holidayList
    const submittedValues: Record<string, string> = {
      name: project.name,
      kind: project.kind,
      language: project.language,
      currency: project.currency,
      timezone: project.timezone,
      weekend: project.weekend.join(", "),
    }
    if (project.holidayList !== null) submittedValues.holidayList = project.holidayList
    return {
      id,
      name: project.name,
      context: projectContext(project.kind),
      status: statusLabel(project.status),
      ...inheritedPresentation(fixture),
      ...stampFacts(project, context.now),
      facts,
      companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
      // A project record scopes itself: the one project it is.
      projectIds: [id],
      recordKind: "Project",
      submittedValues,
    }
  },
  toCreateBody: (record) => {
    const name = typed(record, "name") ?? record.name
    const kind = typed(record, "kind") ?? kindOfContext(record.context)
    const language = typed(record, "language")
    const currency = typed(record, "currency")
    const timezone = typed(record, "timezone")
    if (!language) return refusal("language", "A project needs a language")
    if (!currency) return refusal("currency", "A project needs a currency")
    if (!timezone) return refusal("timezone", "A project needs a timezone")
    // The record's own status is what the workspace shows and moves; a create
    // says it only when the form set one the lifecycle knows (`Active`,
    // `Onboarding`), else the API's default stands.
    const status = PROJECT_STATUSES.find((candidate) => candidate === statusToken(record.status))
    return {
      name,
      kind,
      language,
      currency,
      timezone,
      ...projectCalendarBody(record),
      ...(status === undefined ? {} : { status }),
    }
  },
  toPatchBody: (before, after) =>
    patchOf(before, after, (record) => ({
      name: typed(record, "name") ?? record.name,
      kind: typed(record, "kind"),
      language: typed(record, "language"),
      currency: typed(record, "currency"),
      timezone: typed(record, "timezone"),
      // A controlled action moves the record's status; the wire's two are what a patch may say.
      status: PROJECT_STATUSES.find((candidate) => candidate === statusToken(record.status)),
      ...projectCalendarBody(record),
    })),
  create: (client, body) => create<Project>(client, "/projects", body).then((created) => created.body),
  update: (client, serverId, body) => patch<Project>(client, `/projects/${serverId}`, body),
}

/** `Sat–Sun`, the fixture's spelling of a weekend, from the wire's day list. */
export function weekendLabel(weekend: readonly string[]): string {
  const short = weekend.map((day) => day.charAt(0).toUpperCase() + day.slice(1, 3))
  return short.length === 2 && consecutive(weekend[0], weekend[1]) ? `${short[0]}–${short[1]}` : short.join(", ")
}

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
const consecutive = (a: string, b: string) => (DAYS.indexOf(a) + 1) % 7 === DAYS.indexOf(b)

/**
 * The `weekend` and `holidayList` a project record says, as the wire spells
 * them. The Holiday lists pane writes both onto `submittedValues` and deletes
 * `holidayList` when the list is taken away, so on a record that carries a
 * weekend an absent list is "no list", which the wire spells null; a record
 * that carries neither says nothing about either.
 */
function projectCalendarBody(record: BusinessRecord): { weekend?: string[]; holidayList?: string | null } {
  const weekend = typed(record, "weekend")
  if (weekend === undefined) return {}
  return {
    weekend: weekend
      .split(",")
      .map((day) => day.trim().toLowerCase())
      .filter((day) => DAYS.includes(day)),
    holidayList: typed(record, "holidayList") ?? null,
  }
}

/** `Project · municipality` → `Municipality`; a bare context is a kind of its own. */
function kindOfContext(context: string): string {
  const [, kind] = context.split("·").map((part) => part.trim())
  const text = kind ?? context
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Project"
}

// ---------------------------------------------------------------------------
// Service providers
// ---------------------------------------------------------------------------

const PROVIDER_CHILD_PREFIXES = ["service-provider-access-", "service-provider-activity-", "service-provider-price-", "service-provider-workspace-"]

export const serviceProviderAdapter: ResourceAdapter<ServiceProvider> = {
  prefix: "service-provider",
  // Other modules' records carry the prefix too (`service-provider-access-…`); here the prefix is the provider row's own, and a new row is the form's `recordKind`.
  owns: (record) => (hasPrefix("service-provider")(record) && !PROVIDER_CHILD_PREFIXES.some((prefix) => record.id.startsWith(prefix))) || record.recordKind === "Service provider company",
  // A provider has no status on the wire; the record's is the fixture's and moves nowhere.
  statuses: undefined,
  list: (client) => listAll<ServiceProvider>(client, "/service-providers"),
  toRecord: (provider, context) => {
    const fixture = fixtureNamed(context.fixtures, "service-provider", [provider.legalName])
    const id = fixture?.id ?? webIdOf("service-provider", provider.id)
    return {
      id,
      name: provider.legalName,
      context: fixture?.context ?? `${countryName(provider.country)} · ${provider.registrationNumber}`,
      status: fixture?.status ?? "Active",
      ...inheritedPresentation(fixture),
      ...stampFacts(provider, context.now),
      facts: {
        ...fixture?.facts,
        CVR: provider.registrationNumber,
        Country: countryName(provider.country),
        "Primary contact": provider.contactName,
        "Contact email": provider.contactEmail,
      },
      companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
      projectIds: fixture?.projectIds,
      serviceProviderId: id,
      recordKind: "Service provider company",
      submittedValues: {
        ...fixture?.submittedValues,
        legalName: provider.legalName,
        registrationNumber: provider.registrationNumber,
        country: provider.country,
        contactName: provider.contactName,
        contactEmail: provider.contactEmail,
      },
    }
  },
  toCreateBody: (record) => {
    const legalName = typed(record, "legalName") ?? record.name
    const registrationNumber = typed(record, "registrationNumber")
    const country = typed(record, "country")
    const contactName = typed(record, "contactName")
    const contactEmail = typed(record, "contactEmail")
    if (!registrationNumber) return refusal("registrationNumber", "A service provider needs a registration number")
    if (!country) return refusal("country", "A service provider needs a country")
    if (!contactName) return refusal("contactName", "A service provider needs a primary contact")
    if (!contactEmail) return refusal("contactEmail", "A service provider needs a contact e-mail")
    return { legalName, registrationNumber, country: countryCode(country), contactName, contactEmail }
  },
  toPatchBody: (before, after) =>
    patchOf(before, after, (record) => ({
      legalName: typed(record, "legalName") ?? record.name,
      registrationNumber: typed(record, "registrationNumber"),
      country: typed(record, "country") === undefined ? undefined : countryCode(typed(record, "country") as string),
      contactName: typed(record, "contactName"),
      contactEmail: typed(record, "contactEmail"),
    })),
  create: (client, body) => create<ServiceProvider>(client, "/service-providers", body).then((created) => created.body),
  update: (client, serverId, body) => patch<ServiceProvider>(client, `/service-providers/${serverId}`, body),
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/** The web's sparse access map from the wire's normalised grants. */
export function accessMapOf(grants: readonly Grant[]): RoleAccessMap {
  return Object.fromEntries(grants.map((grant) => [grant.moduleKey, [...grant.actions]])) as RoleAccessMap
}

/** The wire's grants from the web's access map: an entry with no action is no entry. */
export function grantsOf(access: RoleAccessMap): Grant[] {
  return Object.entries(access)
    .filter(([, actions]) => actions.length > 0)
    .map(([moduleKey, actions]) => ({ moduleKey, actions: [...new Set(actions)] }) as Grant)
}

/** A seeded role's web id is its key's, the id the charter defaults are keyed by; a custom role's is the server's. */
export const roleWebIdOf = (role: Pick<Role, "id" | "key">) => (role.key === null ? webIdOf("role", role.id) : `role-${role.key}`)

/** `Role.grants` as a record carries it: one JSON string on `submittedValues`, read back by `grantsOfRecord`. */
export const GRANTS_KEY = "grants"

/** The grants a role record carries, or undefined when it carries none. */
export function grantsOfRecord(record: Pick<BusinessRecord, "submittedValues">): Grant[] | undefined {
  const raw = typed(record, GRANTS_KEY)
  if (raw === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as Grant[]) : undefined
  } catch {
    return undefined
  }
}

export const roleAdapter: ResourceAdapter<Role> = {
  prefix: "role",
  owns: ofKind("role", ["Role"]),
  // A role has no status on the wire.
  statuses: undefined,
  list: (client) => listAll<Role>(client, "/roles"),
  toRecord: (role, context) => {
    const fixture = fixtureNamed(context.fixtures, "role", [role.name])
    const grantCount = role.grants.reduce((total, grant) => total + grant.actions.length, 0)
    return {
      id: roleWebIdOf(role),
      name: role.name,
      context: `Role · ${role.scope.toLowerCase()} scope`,
      status: "Active",
      ...inheritedPresentation(fixture),
      ...stampFacts(role, context.now),
      value: `${grantCount} permissions`,
      description: role.description,
      facts: {
        ...fixture?.facts,
        Identity: "Role",
        Type: role.system ? "System" : "Custom",
        Scope: role.scope,
        Projects: role.scope,
        Roles: role.name,
        Permissions: String(grantCount),
      },
      companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
      projectIds: fixture?.projectIds,
      recordKind: "Role",
      submittedValues: {
        name: role.name,
        scope: role.scope,
        description: role.description,
        system: role.system,
        [GRANTS_KEY]: JSON.stringify(role.grants),
      },
    }
  },
  toCreateBody: (record) => {
    const name = typed(record, "name") ?? record.name
    const scope = typed(record, "scope")
    const description = typed(record, "description") ?? record.description
    if (!scope) return refusal("scope", "A role needs a scope")
    if (!description) return refusal("description", "A role needs a description")
    const grants = grantsOfRecord(record)
    return { name, scope, description, ...(grants === undefined ? {} : { grants }) }
  },
  toPatchBody: (before, after) =>
    patchOf(before, after, (record) => ({
      name: typed(record, "name") ?? record.name,
      scope: typed(record, "scope"),
      description: typed(record, "description") ?? record.description,
    })),
  create: (client, body) => create<Role>(client, "/roles", body).then((created) => created.body),
  update: (client, serverId, body) => patch<Role>(client, `/roles/${serverId}`, body),
}

/** `PUT /roles/:id/grants`: the whole matrix, replacing what the role had. */
export function replaceRoleGrants(client: Client, serverId: string, grants: readonly Grant[]): Promise<Role> {
  return put<Role>(client, `/roles/${serverId}/grants`, { grants })
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/** The `projectAccess` option the access form spells, as the record's fact and typed value. */
export const ALL_PROJECTS_ACCESS = "All projects"
export const NO_PROJECT_ACCESS = "No project access"
export const SERVICE_PROVIDER_ACCESS = "Service provider"

function projectAccessLabel(user: User, projectName: (projectId: string) => string): string {
  if (user.serviceProviderId !== null) return SERVICE_PROVIDER_ACCESS
  if (user.allProjects) return ALL_PROJECTS_ACCESS
  if (user.projectIds.length === 0) return NO_PROJECT_ACCESS
  return user.projectIds.map(projectName).join(", ")
}

/** The user adapter's commands, by the names the Users & roles pane sends (Issue #163). */
export const DEACTIVATE_USER = "deactivate"
export const REACTIVATE_USER = "reactivate"

export const userAdapter: ResourceAdapter<User> = {
  prefix: "user",
  owns: ofKind("user", ["User", "Service provider user"]),
  // A user's status is derived on the wire (`invited`, `active`, `deactivated`) and `UserPatch` has no member for it: it moves through the two commands below, never a patch.
  statuses: undefined,
  list: (client) => listAll<User>(client, "/users"),
  toRecord: (user, context) => {
    const fixture = fixtureNamed(context.fixtures, "user", [user.fullName])
    const role = context.resolve.byServerId(user.roleId)
    const roleName = role?.name ?? "Role"
    const projectName = (projectId: string) => context.resolve.byServerId(projectId)?.name ?? projectId
    const access = projectAccessLabel(user, projectName)
    const provider = user.serviceProviderId === null ? undefined : context.resolve.byServerId(user.serviceProviderId)
    const projectWebIds = user.projectIds.map((projectId) => context.resolve.byServerId(projectId)?.id ?? projectId)
    return {
      id: fixture?.id ?? webIdOf("user", user.id),
      name: user.fullName,
      context: `${provider?.name ?? "Company"} · ${access.toLowerCase()}`,
      status: statusLabel(user.status),
      ...inheritedPresentation(fixture),
      ...stampFacts(user, context.now),
      facts: {
        ...fixture?.facts,
        Identity: user.status === "invited" ? "Invitation pending" : "Login bound",
        Email: user.email,
        Roles: roleName,
        Projects: access,
        ...(provider === undefined ? {} : { "Service provider": provider.name }),
        ...(user.primaryAdministrator ? { "Primary administrator": "Yes" } : {}),
      },
      companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
      // A user with Project Access is scoped to those projects by web id. One
      // with every project, none yet, or a provider is company-wide: no
      // project at all, which `isInProjectScope` shows in every scope —
      // whatever two projects the fixture happened to be filed under.
      projectIds: user.allProjects || user.projectIds.length === 0 ? undefined : projectWebIds,
      serviceProviderId: provider?.id,
      recordKind: "User",
      submittedValues: {
        fullName: user.fullName,
        email: user.email,
        role: roleName,
        roleId: role?.id ?? user.roleId,
        projectAccess: access,
        projectIds: projectWebIds.join(", "),
        ...(provider === undefined ? {} : { serviceProvider: provider.name, serviceProviderId: provider.id }),
      },
    }
  },
  toCreateBody: (record, context) => {
    const email = typed(record, "email")
    const fullName = typed(record, "fullName") ?? record.name
    if (!email) return refusal("email", "A user needs an e-mail address")
    const roleWebId = typed(record, "roleId")
    const roleId = roleWebId === undefined ? undefined : context.resolve.serverIdOf(roleWebId)
    if (roleId === undefined) return refusal("roleId", "Pick a role")
    const providerWebId = typed(record, "serviceProviderId") ?? record.serviceProviderId
    if (providerWebId !== undefined) {
      const serviceProviderId = context.resolve.serverIdOf(providerWebId)
      if (serviceProviderId === undefined) return refusal("serviceProviderId", "Not a service provider of this company")
      return { email, fullName, roleId, serviceProviderId }
    }
    if (typed(record, "projectAccess") === ALL_PROJECTS_ACCESS) return { email, fullName, roleId, allProjects: true }
    const webIds = typed(record, "projectIds")?.split(",").map((id) => id.trim()) ?? record.projectIds ?? []
    // Every project named must be one the store loaded. One it has not is
    // refused, not dropped: the API would take the rest as the whole.
    const projectIds = webIds.map((webId) => context.resolve.serverIdOf(webId))
    if (projectIds.length === 0 || !projectIds.every((id): id is string => id !== undefined)) {
      return refusal("projectIds", "Pick the projects the user works in, or all of them")
    }
    return { email, fullName, roleId, projectIds }
  },
  toPatchBody: (before, after, context) =>
    patchOf(before, after, (record) => ({
      fullName: typed(record, "fullName") ?? record.name,
      roleId: typed(record, "roleId") === undefined ? undefined : context.resolve.serverIdOf(typed(record, "roleId") as string),
    })),
  create: (client, body) => create<User>(client, "/users", body).then((created) => created.body),
  update: (client, serverId, body) => patch<User>(client, `/users/${serverId}`, body),
  // Both need `edit` on `configure.access`; the primary administrator's
  // deactivation is the API's 409, shown as it words it.
  commands: {
    [DEACTIVATE_USER]: {
      run: (client, serverId) => command<User>(client, `/users/${serverId}/deactivate`),
      refused: (record) => `${record.name} was not deactivated`,
    },
    [REACTIVATE_USER]: {
      run: (client, serverId) => command<User>(client, `/users/${serverId}/reactivate`),
      refused: (record) => `${record.name} was not reactivated`,
    },
  },
}

// ---------------------------------------------------------------------------
// The modules
// ---------------------------------------------------------------------------

/** Settings → Company & Projects: the company row first, then the projects. */
export const organisationModule: ServerModule = {
  workspaceId: "configure",
  moduleId: "organization",
  resources: [companyAdapter, projectAdapter],
}

/** Service providers, the company's external haulers. */
export const serviceProvidersModule: ServerModule = {
  workspaceId: "service-providers",
  moduleId: "service-providers",
  resources: [serviceProviderAdapter],
}

/** Settings → Users, Roles & Teams: the roles first, so a user's mapping finds its role's name, then the users. */
export const accessModule: ServerModule = {
  workspaceId: "configure",
  moduleId: "access",
  resources: [roleAdapter, userAdapter],
}

/** The mapping context a module's fixtures and a resolver make. */
export const contextOf = (fixtures: readonly BusinessRecord[], resolve: MappingContext["resolve"], companyRecordId?: string, now?: Date): MappingContext => ({
  fixtures,
  resolve,
  companyRecordId,
  now,
})
