// Settings › Users & roles (Issue #163), apart from React: what the pane
// lists, what its pickers offer, and the record its Add user writes. The pane
// lists the access module's records alone, once the store has loaded them:
// nothing at all until the API has answered.
//
// The invitation is a record the user adapter turns into the `UserInvite`
// body (lib/api/records/organisation.ts, `toCreateBody`): the address, the
// full name, a role by its web id, and exactly one of every project, some
// projects or a service provider. The type of `InviteAccess` makes the
// one-of a matter of shape, so the record carries exactly one way and the
// adapter finds exactly one.
import { systemRoleKept } from "@waste/domain/access/system-roles"

import { typed, typedFlag } from "@/lib/records/fields"
import { accessMapOf, ALL_PROJECTS_ACCESS, GRANTS_KEY, grantsOfRecord, NO_PROJECT_ACCESS, roleAdapter, roleWebIdOf, SERVICE_PROVIDER_ACCESS, serviceProviderAdapter, userAdapter } from "@/lib/api/records/organisation"
import type { ModuleState } from "@/lib/api/records/server-records"

import type { BusinessRecord } from "./business-modules"
import { projectRecordsOf } from "./project-scope"
import type { RoleAccessMap } from "./role-permissions"

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
 * What a table says while it has no rows: the list is still being read, the
 * read failed with the API's own detail, or the person's role does not view
 * the module, in the store's sentence. Null once the module is ready, when an
 * empty table means what it says.
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
export function userRowsOf(module: ModuleState, companyName: string): UserRow[] {
  if (module.status !== "ready") return []
  return module.records
    .filter((record) => userAdapter.owns(record))
    .map((record) => apiUserRow(record, companyName))
    .sort(byName)
}

/** The roles the tab lists, in the API's order. */
export function roleRowsOf(module: ModuleState): RoleRow[] {
  if (module.status !== "ready") return []
  return module.records.filter((record) => roleAdapter.owns(record)).map(apiRoleRow)
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

const mintedSuffix = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`)

/** The id an invitation is minted under, the generic create path's shape, `access-user-<random>`: on the API it keeps it through the session's reads (#240). */
export function mintInviteId(): string {
  return `access-user-${mintedSuffix()}`
}

/** The id a new role is minted under, `access-role-<random>`, as an invitation's is. */
export function mintRoleId(): string {
  return `access-role-${mintedSuffix()}`
}

export type NewRole = {
  name: string
  scope: string
  description: string
  /** A role whose permissions the new one starts with — a system role's among them, the way to change what one allows; none is no permission at all. */
  startFrom?: BusinessRecord
}

/**
 * The record New role hands the store on the Pilot (#291): a custom role as
 * the table shows it until the API answers, and what `roleAdapter.toCreateBody`
 * reads the `RoleCreate` body off — its copy trimmed, and the matrix it starts
 * from, as the role it copies carries it, or none.
 */
export function newRoleRecord(role: NewRole, id: string): BusinessRecord {
  const name = role.name.trim()
  const description = role.description.trim()
  const grants = role.startFrom === undefined ? [] : (grantsOfRecord(role.startFrom) ?? [])
  return {
    id,
    name,
    context: `Role · ${role.scope.toLowerCase()} scope`,
    status: "Active",
    owner: "",
    value: "",
    updated: "Just now",
    description,
    facts: { Identity: "Role", Type: "Custom", Scope: role.scope },
    related: [],
    source: "Waste API",
    freshness: "Just now",
    recordKind: "Role",
    submittedValues: { name, scope: role.scope, description, system: false, [GRANTS_KEY]: JSON.stringify(grants) },
  }
}

/** A matrix as one comparable text: each module granted something, its actions sorted. */
const accessKey = (access: Readonly<Record<string, readonly string[]>>) =>
  JSON.stringify(
    Object.entries(access)
      .filter(([, actions]) => actions.length > 0)
      .map(([moduleKey, actions]) => [moduleKey, [...actions].sort()])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  )

/** Whether the panel's draft grants anything other than the saved matrix: a module emptied or the actions reordered is no change. */
export function accessChanged(saved: Readonly<Record<string, readonly string[]>>, draft: Readonly<Record<string, readonly string[]>>): boolean {
  return accessKey(saved) !== accessKey(draft)
}

/** A role's matrix as the permissions panel reads it on the Pilot: its grants by module, and why it is read-only where it is — a system role's is the platform's (#291). */
export function roleMatrixOf(record: BusinessRecord): { name: string; access: RoleAccessMap; readOnlyBecause: string | null } {
  return {
    name: record.name,
    access: accessMapOf(grantsOfRecord(record) ?? []),
    readOnlyBecause: typedFlag(record, "system") === true ? systemRoleKept(record.name) : null,
  }
}
