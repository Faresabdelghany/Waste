// Settings › Users & roles (Issue #163), apart from React: what the pane
// lists, what its pickers offer, and the record its Add user writes. The pane
// has two sources and never mixes them:
//
//   without the adapter — the organisation store's users and roles, merged
//   with the fixture access records and the service-provider workspace's, as
//   the prototype has always shown them (`kind: "fixtures"`);
//
//   with it — the access module's records alone, once the store has loaded
//   them (`kind: "api"`): no fixture, no record made in the browser, and
//   nothing at all until the API has answered, since a fixture user shown
//   on the Pilot while the list loads is a user who does not exist.
//
// The invitation is a record the user adapter turns into the `UserInvite`
// body (lib/api/records/organisation.ts, `toCreateBody`): the address, the
// full name, a role by its web id, and exactly one of every project, some
// projects or a service provider. The type of `InviteAccess` makes the
// one-of a matter of shape, so the record carries exactly one way and the
// adapter finds exactly one.
import { typed, typedFlag } from "@/lib/api/records/adapter"
import { ALL_PROJECTS_ACCESS, NO_PROJECT_ACCESS, roleAdapter, roleWebIdOf, SERVICE_PROVIDER_ACCESS, serviceProviderAdapter, userAdapter } from "@/lib/api/records/organisation"
import type { ModuleState } from "@/lib/api/records/server-records"

import { FIXTURE_COMPANY_ID, type BusinessRecord } from "./business-modules"
import { projectRecordsOf } from "./project-scope"

export type UserRow = {
  id: string
  name: string
  email: string
  role: string
  organization: string
  projectAccess: string
  status: string
  primaryAdministrator: boolean
}

export type RoleRow = {
  id: string
  name: string
  type: string
  scope: string
  /** The access summary the Roles table shows: the store's `permissions` text, or the API's role description. */
  permissions: string
}

/** The organisation store's users, companies, projects and roles, and the two fixture record sets, as the pane read them before the adapter. */
export type FixtureUsersRoles = {
  organizationUsers: readonly {
    id: string
    companyId: string
    fullName: string
    email: string
    role: string
    status: string
    accessMode: "none" | "selected-projects" | "all-company-projects"
    projectIds: readonly string[]
    isPrimaryAdministrator: boolean
    serviceProviderName?: string
  }[]
  companies: readonly { id: string; name: string }[]
  projects: readonly { id: string; name: string }[]
  roles: readonly { id: string; name: string; type: string; scope: string; permissions: string }[]
  accessRecords: readonly BusinessRecord[]
  serviceProviderAccessRecords: readonly BusinessRecord[]
}

export type UsersRolesSource = ({ kind: "fixtures" } & FixtureUsersRoles) | { kind: "api"; module: ModuleState; companyName: string }

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)

/**
 * The seeded Company Administrator's web id (`roleWebIdOf`: `role-<key>`),
 * the role that always covers every project (CONTEXT.md). By its key, not
 * its name: a seeded role may be renamed, and a custom role may be called
 * anything.
 */
export const COMPANY_ADMINISTRATOR_ROLE_ID = roleWebIdOf({ id: "", key: "company-administrator" })

/** Whether a role, by web id, covers every current and future project, so Add user offers no other access for it. */
export const coversEveryProject = (roleId: string): boolean => roleId === COMPANY_ADMINISTRATOR_ROLE_ID

/**
 * What a table says on the Pilot while it has no rows: the list is still
 * being read, the read failed with the API's own detail, or the person's
 * role does not view the module, in the store's sentence — never the
 * fixtures. Null once the module is ready, when an empty table means what
 * it says.
 */
export function pilotEmptyState(module: ModuleState, noun: "users" | "roles"): { message: string; hint: string } | null {
  if (module.status === "ready") return null
  if (module.status === "not-granted") {
    return { message: `The ${noun} are not shown to your role.`, hint: module.problem?.detail ?? "" }
  }
  if (module.status === "failed") {
    return { message: `The ${noun} could not be read from the API.`, hint: module.problem === null ? "The API did not answer." : (module.problem.detail ?? module.problem.title) }
  }
  return { message: `Reading the company's ${noun} from the API…`, hint: `The list shows the API's ${noun} and nothing else.` }
}

/** The users the tab lists, sorted by name. */
export function userRowsOf(source: UsersRolesSource): UserRow[] {
  if (source.kind === "api") {
    if (source.module.status !== "ready") return []
    return source.module.records
      .filter((record) => userAdapter.owns(record))
      .map((record) => apiUserRow(record, source.companyName))
      .sort(byName)
  }
  return fixtureUserRows(source)
}

/** The roles the tab lists: the API's in list order, the store's in its own. */
export function roleRowsOf(source: UsersRolesSource): RoleRow[] {
  if (source.kind === "api") {
    if (source.module.status !== "ready") return []
    return source.module.records.filter((record) => roleAdapter.owns(record)).map(apiRoleRow)
  }
  return source.roles.map(({ id, name, type, scope, permissions }) => ({ id, name, type, scope, permissions }))
}

function apiUserRow(record: BusinessRecord, companyName: string): UserRow {
  const projectAccess = record.facts.Projects ?? typed(record, "projectAccess") ?? NO_PROJECT_ACCESS
  return {
    id: record.id,
    name: record.name,
    email: typed(record, "email") ?? record.facts.Email ?? "",
    role: record.facts.Roles ?? typed(record, "role") ?? "Role",
    // A provider's account is the provider's even when the store could not
    // resolve which one (the providers module failed to load): never the company's.
    organization: record.facts["Service provider"] ?? (projectAccess === SERVICE_PROVIDER_ACCESS ? SERVICE_PROVIDER_ACCESS : companyName),
    projectAccess,
    status: record.status,
    primaryAdministrator: record.facts["Primary administrator"] === "Yes",
  }
}

function apiRoleRow(record: BusinessRecord): RoleRow {
  return {
    id: record.id,
    name: record.name,
    type: record.facts.Type ?? (typedFlag(record, "system") ? "System" : "Custom"),
    scope: record.facts.Scope ?? typed(record, "scope") ?? "",
    permissions: record.description,
  }
}

// ---------------------------------------------------------------------------
// The prototype's merge, as the pane read it before the adapter
// ---------------------------------------------------------------------------

function roleForRecord(record: BusinessRecord) {
  if (record.submittedValues?.role) return String(record.submittedValues.role)
  if (record.facts.Roles) return record.facts.Roles

  const context = record.context.toLowerCase()
  if (context.includes("foreman")) return "Service Provider Foreman"
  if (context.includes("manager")) return "Service Provider Manager"
  return "User"
}

function projectAccessForRecord(record: BusinessRecord) {
  if (record.submittedValues?.projectAccess) {
    return String(record.submittedValues.projectAccess)
  }
  if (/^\d+$/.test(record.facts.Projects ?? "")) {
    return record.context.split("·").slice(1).join("·").trim() || record.context
  }
  return record.facts.Projects ?? record.context
}

function organizationForRecord(record: BusinessRecord) {
  if (record.submittedValues?.serviceProvider) {
    return String(record.submittedValues.serviceProvider)
  }
  if (record.facts["Service provider"]) {
    return record.facts["Service provider"].replace(/\s+only$/i, "")
  }
  return "Kystbyen Renovation"
}

function emailForRecord(record: BusinessRecord) {
  if (record.submittedValues?.email) return String(record.submittedValues.email)
  if (record.id === "user-olivia") return "olivia.larsen@kystbyen.example"
  if (record.id === "user-temp") return "integration.user@kystbyen.example"
  return "Managed service provider account"
}

function fixtureUserRows({ organizationUsers, companies, projects, accessRecords, serviceProviderAccessRecords }: FixtureUsersRoles): UserRow[] {
  const companyById = new Map(companies.map((company) => [company.id, company]))
  const projectById = new Map(projects.map((project) => [project.id, project]))
  const normalizedUsers = organizationUsers.map((user) => {
    const company = companyById.get(user.companyId)
    const projectAccess =
      user.accessMode === "all-company-projects"
        ? ALL_PROJECTS_ACCESS
        : user.accessMode === "none"
          ? NO_PROJECT_ACCESS
          : user.projectIds
              .map((projectId) => projectById.get(projectId)?.name)
              .filter(Boolean)
              .join(", ") || NO_PROJECT_ACCESS

    return {
      id: user.id,
      name: user.fullName,
      email: user.email,
      role: user.role,
      organization: user.serviceProviderName ?? company?.name ?? "Unknown company",
      projectAccess,
      status: user.status,
      primaryAdministrator: user.isPrimaryAdministrator,
    }
  })
  const normalizedUserIds = new Set(organizationUsers.map((user) => user.id))
  const normalizedUserEmails = new Set(organizationUsers.map((user) => user.email.toLowerCase()))
  const officeUsers = accessRecords
    .filter(
      (record) =>
        !normalizedUserIds.has(record.id) &&
        !normalizedUserEmails.has(emailForRecord(record).toLowerCase()) &&
        (record.recordKind === "User" || (record.facts.Identity !== "Role" && !record.id.startsWith("role-"))),
    )
    .map((record) => ({
      id: record.id,
      name: record.name,
      email: emailForRecord(record),
      role: roleForRecord(record),
      organization: organizationForRecord(record),
      projectAccess: projectAccessForRecord(record),
      status: record.status,
      primaryAdministrator: false,
    }))

  const serviceProviderUsers = serviceProviderAccessRecords.map((record) => ({
    id: record.id,
    name: record.owner && record.owner !== "Contract Team" ? record.owner : record.name,
    email: emailForRecord(record),
    role: roleForRecord(record),
    organization: organizationForRecord(record),
    projectAccess: projectAccessForRecord(record),
    status: record.status,
    primaryAdministrator: false,
  }))

  return [...normalizedUsers, ...officeUsers, ...serviceProviderUsers].sort(byName)
}

// ---------------------------------------------------------------------------
// The pickers on the Pilot: what the store loaded, by web id
// ---------------------------------------------------------------------------

export type PickerOption = { id: string; name: string }

const option = ({ id, name }: BusinessRecord): PickerOption => ({ id, name })

/** The roles Add user offers: the access module's role records, so a role that exists only in the browser is never one of them. */
export function rolePickerOptions(accessRecords: readonly BusinessRecord[]): PickerOption[] {
  return accessRecords.filter((record) => roleAdapter.owns(record)).map(option)
}

/** The projects Add user offers: the organisation module's project records, its company row left out. */
export function projectPickerOptions(organisationRecords: readonly BusinessRecord[]): PickerOption[] {
  return projectRecordsOf(organisationRecords).map(option)
}

/** The service providers Add user offers: the providers module's rows. */
export function providerPickerOptions(providerRecords: readonly BusinessRecord[]): PickerOption[] {
  return providerRecords.filter((record) => serviceProviderAdapter.owns(record)).map(option)
}

// ---------------------------------------------------------------------------
// The invitation
// ---------------------------------------------------------------------------

/** Exactly one of the three ways an account reaches something, as `UserInvite` takes it. */
export type InviteAccess =
  | { kind: "all-projects" }
  | { kind: "projects"; projects: readonly PickerOption[] }
  | { kind: "service-provider"; provider: PickerOption }

export type Invite = {
  fullName: string
  email: string
  /** A role the store loaded, by its web id. */
  role: PickerOption
  access: InviteAccess
  /** The web id of the caller's company record, once the organisation module has loaded. */
  companyRecordId?: string
}

/**
 * The record Add user hands the store: an Invitation as the list shows it
 * until the API answers, and what `userAdapter.toCreateBody` reads the
 * `UserInvite` body off. The address is trimmed and lowercased here, since it
 * is what the access token hook binds the Login on.
 */
export function inviteRecord(invite: Invite, id: string): BusinessRecord {
  const email = invite.email.trim().toLowerCase()
  const fullName = invite.fullName.trim()
  const { access } = invite
  const label =
    access.kind === "all-projects" ? ALL_PROJECTS_ACCESS : access.kind === "service-provider" ? SERVICE_PROVIDER_ACCESS : access.projects.map((project) => project.name).join(", ")
  const provider = access.kind === "service-provider" ? access.provider : undefined
  const projectIds = access.kind === "projects" ? access.projects.map((project) => project.id) : undefined
  return {
    id,
    name: fullName,
    context: `${provider?.name ?? "Company"} · ${label.toLowerCase()}`,
    status: "Invited",
    owner: "",
    value: "",
    updated: "Just now",
    description: "",
    facts: {
      Identity: "Invitation pending",
      Email: email,
      Roles: invite.role.name,
      Projects: label,
      ...(provider === undefined ? {} : { "Service provider": provider.name }),
    },
    related: [],
    source: "Waste API",
    freshness: "Just now",
    companyId: invite.companyRecordId ?? FIXTURE_COMPANY_ID,
    ...(projectIds === undefined ? {} : { projectIds }),
    ...(provider === undefined ? {} : { serviceProviderId: provider.id }),
    recordKind: "User",
    submittedValues: {
      fullName,
      email,
      role: invite.role.name,
      roleId: invite.role.id,
      projectAccess: label,
      ...(projectIds === undefined ? {} : { projectIds: projectIds.join(", ") }),
      ...(provider === undefined ? {} : { serviceProvider: provider.name, serviceProviderId: provider.id }),
    },
  }
}

/** The id an invitation carries until the next load: the generic create path's shape, `access-user-<random>`. */
export function mintInviteId(): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  return `access-user-${random}`
}
