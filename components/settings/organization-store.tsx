"use client"

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"

import { createExternalStore, type ExternalStore } from "@/lib/external-store"

import {
  FIXTURE_COMPANY_ID,
  FIXTURE_PROJECT_IDS,
} from "@/lib/data/business-modules"
import { migrateLegacyState } from "@/lib/data/legacy-ids"
import {
  isRoleAccessMap,
  type RoleAccessMap,
} from "@/lib/data/role-permissions"

export type CompanyStatus = "Active" | "Onboarding"
export type ProjectStatus = "Active" | "Onboarding"
export type OrganizationUserStatus = "Active" | "Invited"
export type ProjectAccessMode =
  | "none"
  | "selected-projects"
  | "all-company-projects"

export type Company = {
  id: string
  name: string
  legalName: string
  registrationNumber: string
  status: CompanyStatus
  source: "fixture" | "created"
  createdAt: string
}

export type Project = {
  id: string
  companyId: string
  name: string
  kind: string
  language: string
  currency: string
  timezone: string
  status: ProjectStatus
  source: "fixture" | "created"
  createdAt: string
}

export type OrganizationUser = {
  id: string
  companyId: string
  fullName: string
  email: string
  role: string
  status: OrganizationUserStatus
  accessMode: ProjectAccessMode
  projectIds: string[]
  isPrimaryAdministrator: boolean
  serviceProviderId?: string
  serviceProviderName?: string
  createdAt: string
}

export type OrganizationRoleType = "System" | "Custom"

export type OrganizationRole = {
  id: string
  name: string
  type: OrganizationRoleType
  scope: string
  permissions: string
  // Sparse per-module grants. Absent means "use the seeded defaults for this
  // role id" (see lib/data/role-permissions.ts); {} means explicitly nothing.
  access?: RoleAccessMap
  source: "fixture" | "created"
  createdAt: string
}

type OrganizationState = {
  companies: Company[]
  projects: Project[]
  users: OrganizationUser[]
  roles: OrganizationRole[]
}

export type CreateCompanyInput = {
  companyName: string
  legalName: string
  registrationNumber: string
  projectName: string
  projectKind: string
  projectLanguage: string
  projectCurrency: string
  projectTimezone: string
  administratorName: string
  administratorEmail: string
}

export type CreateProjectInput = {
  companyId: string
  name: string
  kind: string
  language: string
  currency: string
  timezone: string
}

export type UpdateProjectInput = {
  projectId: string
  name: string
  kind: string
  language: string
  currency: string
  timezone: string
}

export type UpdateCompanyInput = {
  companyId: string
  companyName: string
  legalName: string
  registrationNumber: string
}

export type CreateOrganizationUserInput = {
  companyId: string
  fullName: string
  email: string
  role: string
  accessMode: ProjectAccessMode
  projectIds: string[]
  serviceProviderId?: string
  serviceProviderName?: string
}

export type CreateOrganizationRoleInput = {
  name: string
  scope: string
  permissions: string
}

export type UpdateRoleAccessInput = {
  roleId: string
  access: RoleAccessMap
}

type OrganizationStoreValue = OrganizationState & {
  hydrated: boolean
  createCompany: (input: CreateCompanyInput) => Company
  updateCompany: (input: UpdateCompanyInput) => Company
  createProject: (input: CreateProjectInput) => Project
  updateProject: (input: UpdateProjectInput) => Project
  createUser: (input: CreateOrganizationUserInput) => OrganizationUser
  createRole: (input: CreateOrganizationRoleInput) => OrganizationRole
  updateRoleAccess: (input: UpdateRoleAccessInput) => OrganizationRole
  projectsForCompany: (companyId: string) => Project[]
  usersForCompany: (companyId: string) => OrganizationUser[]
  primaryAdministratorForCompany: (
    companyId: string,
  ) => OrganizationUser | undefined
}

const ORGANIZATION_STORAGE_KEY = "wastehero.organization.v1"

const fixtureCreatedAt = "2026-01-01T00:00:00.000Z"

function fixtureRole(
  name: string,
  type: OrganizationRoleType,
  scope: string,
  permissions: string,
): OrganizationRole {
  return {
    id: `role-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    name,
    type,
    scope,
    permissions,
    source: "fixture",
    createdAt: fixtureCreatedAt,
  }
}

const fixtureRoles: OrganizationRole[] = [
  fixtureRole(
    "Company Administrator",
    "System",
    "Company",
    "Company, projects, users, and settings",
  ),
  fixtureRole(
    "Operations Manager",
    "System",
    "Assigned projects",
    "Routes, tickets, fleet, and approvals",
  ),
  fixtureRole(
    "Dispatcher",
    "System",
    "Assigned projects",
    "Live routes, assignments, and tickets",
  ),
  fixtureRole(
    "Route Planner",
    "System",
    "Assigned projects",
    "Route schemes, routes, and planning",
  ),
  fixtureRole(
    "Fleet Manager",
    "System",
    "Assigned projects",
    "Vehicles, drivers, and vehicle planning",
  ),
  fixtureRole(
    "Customer Service",
    "System",
    "Assigned projects",
    "Customers, properties, tickets, and communication",
  ),
  fixtureRole(
    "Finance Specialist",
    "System",
    "Company or project",
    "Prices, billing, invoices, and settlements",
  ),
  fixtureRole(
    "Service Provider Manager",
    "System",
    "Own service provider",
    "Service provider users, fleet, routes, and settlements",
  ),
  fixtureRole(
    "Service Provider Foreman",
    "Custom",
    "Own service provider",
    "Service provider routes, vehicles, and drivers",
  ),
  fixtureRole(
    "Driver",
    "System",
    "Assigned routes",
    "Driver app and assigned route execution",
  ),
  fixtureRole(
    "Integration Writer",
    "System",
    "Explicit API scope",
    "Configured integration read and write access",
  ),
]

const fixtureState: OrganizationState = {
  companies: [
    {
      id: FIXTURE_COMPANY_ID,
      name: "WasteHero Denmark",
      legalName: "WasteHero Denmark A/S",
      registrationNumber: "38144209",
      status: "Active",
      source: "fixture",
      createdAt: fixtureCreatedAt,
    },
  ],
  projects: [
    {
      id: FIXTURE_PROJECT_IDS.copenhagen,
      companyId: FIXTURE_COMPANY_ID,
      name: "Copenhagen Central",
      kind: "Municipality",
      language: "Danish",
      currency: "DKK",
      timezone: "Europe/Copenhagen",
      status: "Active",
      source: "fixture",
      createdAt: fixtureCreatedAt,
    },
    {
      id: FIXTURE_PROJECT_IDS.harbor,
      companyId: FIXTURE_COMPANY_ID,
      name: "Harbor Commercial",
      kind: "Business unit",
      language: "Danish",
      currency: "DKK",
      timezone: "Europe/Copenhagen",
      status: "Onboarding",
      source: "fixture",
      createdAt: fixtureCreatedAt,
    },
  ],
  users: [
    {
      id: "user-olivia",
      companyId: FIXTURE_COMPANY_ID,
      fullName: "Olivia Larsen",
      email: "olivia.larsen@wastehero.example",
      role: "Company Administrator",
      status: "Active",
      accessMode: "all-company-projects",
      projectIds: [],
      isPrimaryAdministrator: true,
      createdAt: fixtureCreatedAt,
    },
  ],
  roles: fixtureRoles,
}

// Persisted graphs written before the Contractor → Service provider rename
// (2026-09-02) still carry the retired role ids ("role-contractor-manager"),
// `${workspaceId}.${moduleId}` access keys ("contractors.contractor-workspace"),
// user fields (contractorId / contractorName), and the old fixture copy. The
// restricted service provider workspace resolves its grants by the new role id,
// so an unmigrated role list would silently lose them. The rewrite runs on
// every load and is idempotent; the persist right after hydration writes the
// migrated graph back.
const LEGACY_ROLE_NAMES: Readonly<Record<string, string>> = {
  "Contractor Manager": "Service Provider Manager",
  "Contractor Foreman": "Service Provider Foreman",
}

// Scope labels are picked from a fixed list, so custom roles carry them too.
const LEGACY_ROLE_SCOPES: Readonly<Record<string, string>> = {
  "Own contractor": "Own service provider",
}

const fixtureRolesById = new Map(fixtureRoles.map((role) => [role.id, role]))

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function renameLegacyLabel(
  value: unknown,
  renames: Readonly<Record<string, string>>,
): unknown {
  return typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(renames, value)
    ? renames[value]
    : value
}

export function migrateLegacyOrganizationState(value: unknown): unknown {
  if (!isRecord(value)) return value
  const next: Record<string, unknown> = { ...value }

  // Users reference roles by display name, so every built-in role rename below
  // has to re-point that role's users as well. A payload without a persisted
  // role list hydrates the current fixture roles, so the static table applies
  // as-is; otherwise the roles pass replaces it with the renames that actually
  // happened, so a user is never moved onto a custom role that already holds
  // the new fixture name.
  let roleRenames: Readonly<Record<string, string>> = LEGACY_ROLE_NAMES

  if (Array.isArray(value.roles)) {
    // Role ids, access-map keys, and id-shaped values go through the shared
    // rewrite; the display copy below is not id-shaped and is handled here.
    const roles = migrateLegacyState<unknown[]>(value.roles)
    const isFixtureRole = (role: Record<string, unknown>) =>
      typeof role.id === "string" && fixtureRolesById.has(role.id)
    const customRoleNames = new Set(
      roles.flatMap((role) =>
        isRecord(role) && !isFixtureRole(role) && typeof role.name === "string"
          ? [normalize(role.name)]
          : [],
      ),
    )
    const appliedRenames: Record<string, string> = {}
    next.roles = roles.map((role) => {
      if (!isRecord(role)) return role
      const fixture = isFixtureRole(role)
        ? fixtureRolesById.get(role.id as string)
        : undefined
      if (!fixture) {
        return { ...role, scope: renameLegacyLabel(role.scope, LEGACY_ROLE_SCOPES) }
      }
      // Built-in roles' display fields are not editable, so the persisted copy
      // is whatever fixture text was current when it was saved. Adopt the
      // current fixture copy — keeping the old name only if a custom role
      // already took the new one, since role names must stay unique.
      const keepsPersistedName = customRoleNames.has(normalize(fixture.name))
      if (
        !keepsPersistedName &&
        typeof role.name === "string" &&
        role.name !== fixture.name
      ) {
        appliedRenames[role.name] = fixture.name
      }
      return {
        ...role,
        name: keepsPersistedName ? role.name : fixture.name,
        scope: fixture.scope,
        permissions: fixture.permissions,
      }
    })
    roleRenames = appliedRenames
  }

  if (Array.isArray(value.users)) {
    // The shared rewrite already moved the retired contractorId /
    // contractorName user fields to their serviceProvider* counterparts; only
    // the role display name still needs the rename computed above.
    next.users = migrateLegacyState<unknown[]>(value.users).map((user) =>
      isRecord(user)
        ? { ...user, role: renameLegacyLabel(user.role, roleRenames) }
        : user,
    )
  }

  return next
}

type OrganizationSnapshot = OrganizationState & { hydrated: boolean }

type OrganizationActions = Pick<
  OrganizationStoreValue,
  | "createCompany"
  | "updateCompany"
  | "createProject"
  | "updateProject"
  | "createUser"
  | "createRole"
  | "updateRoleAccess"
>

type OrganizationStoreHandle = ExternalStore<OrganizationSnapshot> & {
  actions: OrganizationActions
}

// The server (and every hydrating component) sees the fixture tenant only —
// see lib/external-store.ts for why the context carries a stable handle
// instead of the state itself (hydration safety under streaming SSR).
const organizationServerSnapshot: OrganizationSnapshot = {
  ...fixtureState,
  hydrated: false,
}

const OrganizationStoreContext =
  createContext<OrganizationStoreHandle | null>(null)

function normalize(value: string) {
  return value.trim().toLocaleLowerCase()
}

function entityId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function isOrganizationState(value: unknown): value is OrganizationState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const candidate = value as Partial<OrganizationState>
  const hasValidShape =
    Array.isArray(candidate.companies) &&
    candidate.companies.every(
      (company) =>
        company &&
        typeof company.id === "string" &&
        typeof company.name === "string",
    ) &&
    Array.isArray(candidate.projects) &&
    candidate.projects.every(
      (project) =>
        project &&
        typeof project.id === "string" &&
        typeof project.companyId === "string" &&
        typeof project.name === "string",
    ) &&
    Array.isArray(candidate.users) &&
    candidate.users.every(
      (user) =>
        user &&
        typeof user.id === "string" &&
        typeof user.companyId === "string" &&
        typeof user.email === "string",
    ) &&
    // Roles were added later; older persisted payloads without them stay valid.
    (candidate.roles === undefined ||
      (Array.isArray(candidate.roles) &&
        candidate.roles.every(
          (role) =>
            role &&
            typeof role.id === "string" &&
            typeof role.name === "string" &&
            (role.type === "System" || role.type === "Custom") &&
            typeof role.scope === "string" &&
            typeof role.permissions === "string" &&
            (role.access === undefined || isRoleAccessMap(role.access)),
        )))

  if (!hasValidShape) return false

  if (candidate.roles) {
    const roleNames = new Set(candidate.roles.map((role) => normalize(role.name)))
    if (roleNames.size !== candidate.roles.length) return false
  }

  const state = candidate as OrganizationState
  const companyIds = new Set(state.companies.map((company) => company.id))
  const projectIds = new Set(state.projects.map((project) => project.id))
  const userIds = new Set(state.users.map((user) => user.id))
  const normalizedEmails = new Set(
    state.users.map((user) => normalize(user.email)),
  )

  if (
    companyIds.size !== state.companies.length ||
    projectIds.size !== state.projects.length ||
    userIds.size !== state.users.length ||
    normalizedEmails.size !== state.users.length
  ) {
    return false
  }

  if (
    state.projects.some((project) => !companyIds.has(project.companyId)) ||
    state.users.some((user) => !companyIds.has(user.companyId))
  ) {
    return false
  }

  for (const company of state.companies) {
    if (!state.projects.some((project) => project.companyId === company.id)) {
      return false
    }
    const primaryAdministrators = state.users.filter(
      (user) =>
        user.companyId === company.id && user.isPrimaryAdministrator,
    )
    if (
      primaryAdministrators.length !== 1 ||
      primaryAdministrators[0].role !== "Company Administrator" ||
      primaryAdministrators[0].accessMode !== "all-company-projects"
    ) {
      return false
    }
  }

  return state.users.every((user) => {
    if (
      !["none", "selected-projects", "all-company-projects"].includes(
        user.accessMode,
      )
    ) {
      return false
    }
    return user.projectIds.every((projectId) =>
      state.projects.some(
        (project) =>
          project.id === projectId && project.companyId === user.companyId,
      ),
    )
  })
}

function assertCompanyInput(
  state: OrganizationState,
  input: CreateCompanyInput,
) {
  const requiredValues = [
    input.companyName,
    input.legalName,
    input.projectName,
    input.projectKind,
    input.projectLanguage,
    input.projectCurrency,
    input.projectTimezone,
    input.administratorName,
    input.administratorEmail,
  ]

  if (requiredValues.some((value) => !value.trim())) {
    throw new Error(
      "Complete the company, first project, and administrator fields.",
    )
  }

  if (
    state.companies.some(
      (company) => normalize(company.name) === normalize(input.companyName),
    )
  ) {
    throw new Error("A company with this name already exists.")
  }

  if (
    input.registrationNumber.trim() &&
    state.companies.some(
      (company) =>
        normalize(company.registrationNumber) ===
        normalize(input.registrationNumber),
    )
  ) {
    throw new Error("A company with this registration number already exists.")
  }

  if (
    state.users.some(
      (user) => normalize(user.email) === normalize(input.administratorEmail),
    )
  ) {
    throw new Error(
      "This email already belongs to a user in another company.",
    )
  }
}

function assertCompanyUpdateInput(
  state: OrganizationState,
  input: UpdateCompanyInput,
) {
  if (!state.companies.some((company) => company.id === input.companyId)) {
    throw new Error("The company could not be found.")
  }
  if (!input.companyName.trim() || !input.legalName.trim()) {
    throw new Error("Complete the company name and legal name.")
  }
  if (
    state.companies.some(
      (company) =>
        company.id !== input.companyId &&
        normalize(company.name) === normalize(input.companyName),
    )
  ) {
    throw new Error("A company with this name already exists.")
  }
  if (
    input.registrationNumber.trim() &&
    state.companies.some(
      (company) =>
        company.id !== input.companyId &&
        normalize(company.registrationNumber) ===
          normalize(input.registrationNumber),
    )
  ) {
    throw new Error("A company with this registration number already exists.")
  }
}

function createOrganizationStore(): OrganizationStoreHandle {
  const store = createExternalStore<OrganizationSnapshot>(
    organizationServerSnapshot,
  )

  const createCompany = (input: CreateCompanyInput) => {
    assertCompanyInput(store.getSnapshot(), input)

    const createdAt = new Date().toISOString()
    const companyId = entityId("company")
    const createdCompany: Company = {
      id: companyId,
      name: input.companyName.trim(),
      legalName: input.legalName.trim(),
      registrationNumber: input.registrationNumber.trim(),
      status: "Onboarding",
      source: "created",
      createdAt,
    }
    const firstProject: Project = {
      id: entityId("project"),
      companyId,
      name: input.projectName.trim(),
      kind: input.projectKind,
      language: input.projectLanguage,
      currency: input.projectCurrency,
      timezone: input.projectTimezone,
      status: "Onboarding",
      source: "created",
      createdAt,
    }
    const primaryAdministrator: OrganizationUser = {
      id: entityId("user"),
      companyId,
      fullName: input.administratorName.trim(),
      email: normalize(input.administratorEmail),
      role: "Company Administrator",
      status: "Invited",
      accessMode: "all-company-projects",
      projectIds: [],
      isPrimaryAdministrator: true,
      createdAt,
    }

    store.set((current) => ({
      ...current,
      companies: [createdCompany, ...current.companies],
      projects: [firstProject, ...current.projects],
      users: [primaryAdministrator, ...current.users],
    }))
    return createdCompany
  }

  const updateCompany = (input: UpdateCompanyInput) => {
    const state = store.getSnapshot()
    assertCompanyUpdateInput(state, input)

    const existingCompany = state.companies.find(
      (company) => company.id === input.companyId,
    )
    if (!existingCompany) {
      throw new Error("The company could not be found.")
    }

    const updatedCompany: Company = {
      ...existingCompany,
      name: input.companyName.trim(),
      legalName: input.legalName.trim(),
      registrationNumber: input.registrationNumber.trim(),
    }

    store.set((current) => ({
      ...current,
      companies: current.companies.map((company) =>
        company.id === input.companyId ? updatedCompany : company,
      ),
    }))
    return updatedCompany
  }

  const createProject = (input: CreateProjectInput) => {
    const state = store.getSnapshot()
    if (!state.companies.some((company) => company.id === input.companyId)) {
      throw new Error("Select a valid company.")
    }
    if (
      [
        input.name,
        input.kind,
        input.language,
        input.currency,
        input.timezone,
      ].some((value) => !value.trim())
    ) {
      throw new Error("Complete all project fields.")
    }
    if (
      state.projects.some(
        (project) =>
          project.companyId === input.companyId &&
          normalize(project.name) === normalize(input.name),
      )
    ) {
      throw new Error(
        "A project with this name already exists in the company.",
      )
    }

    const createdProject: Project = {
      id: entityId("project"),
      companyId: input.companyId,
      name: input.name.trim(),
      kind: input.kind,
      language: input.language,
      currency: input.currency,
      timezone: input.timezone,
      status: "Onboarding",
      source: "created",
      createdAt: new Date().toISOString(),
    }

    store.set((current) => ({
      ...current,
      projects: [createdProject, ...current.projects],
    }))
    return createdProject
  }

  const updateProject = (input: UpdateProjectInput) => {
    const state = store.getSnapshot()
    const existingProject = state.projects.find(
      (project) => project.id === input.projectId,
    )
    if (!existingProject) {
      throw new Error("The project could not be found.")
    }
    if (
      [input.name, input.kind, input.language, input.currency, input.timezone].some(
        (value) => !value.trim(),
      )
    ) {
      throw new Error("Complete all project fields.")
    }
    if (
      state.projects.some(
        (project) =>
          project.id !== input.projectId &&
          project.companyId === existingProject.companyId &&
          normalize(project.name) === normalize(input.name),
      )
    ) {
      throw new Error("A project with this name already exists in the company.")
    }

    const updatedProject: Project = {
      ...existingProject,
      name: input.name.trim(),
      kind: input.kind,
      language: input.language,
      currency: input.currency,
      timezone: input.timezone,
    }

    store.set((current) => ({
      ...current,
      projects: current.projects.map((project) =>
        project.id === input.projectId ? updatedProject : project,
      ),
    }))
    return updatedProject
  }

  const createUser = (input: CreateOrganizationUserInput) => {
    const state = store.getSnapshot()
    if (!state.companies.some((company) => company.id === input.companyId)) {
      throw new Error("Select a valid company.")
    }
    if (
      !input.fullName.trim() ||
      !input.email.trim() ||
      !input.role.trim()
    ) {
      throw new Error("Complete the required user fields.")
    }
    if (
      state.users.some(
        (user) => normalize(user.email) === normalize(input.email),
      )
    ) {
      throw new Error("A user with this email already exists.")
    }

    const companyProjectIds = new Set(
      state.projects
        .filter((project) => project.companyId === input.companyId)
        .map((project) => project.id),
    )
    if (
      input.projectIds.some((projectId) => !companyProjectIds.has(projectId))
    ) {
      throw new Error("Project access must belong to the selected company.")
    }

    const createdUser: OrganizationUser = {
      id: entityId("user"),
      companyId: input.companyId,
      fullName: input.fullName.trim(),
      email: normalize(input.email),
      role: input.role,
      status: "Invited",
      accessMode:
        input.role === "Company Administrator"
          ? "all-company-projects"
          : input.accessMode,
      projectIds:
        input.role !== "Company Administrator" &&
        input.accessMode === "selected-projects"
          ? input.projectIds
          : [],
      isPrimaryAdministrator: false,
      serviceProviderId: input.serviceProviderId,
      serviceProviderName: input.serviceProviderName,
      createdAt: new Date().toISOString(),
    }

    store.set((current) => ({
      ...current,
      users: [createdUser, ...current.users],
    }))
    return createdUser
  }

  const createRole = (input: CreateOrganizationRoleInput) => {
    const state = store.getSnapshot()
    if (!input.name.trim() || !input.scope.trim()) {
      throw new Error("Complete the role name and scope.")
    }
    if (
      state.roles.some(
        (role) => normalize(role.name) === normalize(input.name),
      )
    ) {
      throw new Error("A role with this name already exists.")
    }

    const createdRole: OrganizationRole = {
      id: entityId("role"),
      name: input.name.trim(),
      type: "Custom",
      scope: input.scope.trim(),
      permissions: input.permissions.trim() || "Custom permissions",
      source: "created",
      createdAt: new Date().toISOString(),
    }

    store.set((current) => ({
      ...current,
      roles: [...current.roles, createdRole],
    }))
    return createdRole
  }

  const updateRoleAccess = (input: UpdateRoleAccessInput) => {
    const state = store.getSnapshot()
    const existingRole = state.roles.find((role) => role.id === input.roleId)
    if (!existingRole) {
      throw new Error("The role could not be found.")
    }

    // Keep the persisted map sparse: entries with no granted actions are the
    // same as absent entries. An all-empty map still persists as {} so an
    // explicit "nothing granted" survives over the seeded defaults.
    const sanitizedAccess: RoleAccessMap = {}
    for (const [key, actions] of Object.entries(input.access)) {
      const uniqueActions = [...new Set(actions)]
      if (uniqueActions.length > 0) sanitizedAccess[key] = uniqueActions
    }

    const updatedRole: OrganizationRole = {
      ...existingRole,
      access: sanitizedAccess,
    }

    store.set((current) => ({
      ...current,
      roles: current.roles.map((role) =>
        role.id === input.roleId ? updatedRole : role,
      ),
    }))
    return updatedRole
  }

  return {
    ...store,
    actions: {
      createCompany,
      updateCompany,
      createProject,
      updateProject,
      createUser,
      createRole,
      updateRoleAccess,
    },
  }
}

export function OrganizationStoreProvider({
  children,
}: {
  children: ReactNode
}) {
  const [store] = useState(createOrganizationStore)

  useEffect(() => {
    let parsed: unknown = null
    try {
      const rawValue = window.localStorage.getItem(ORGANIZATION_STORAGE_KEY)
      parsed = rawValue
        ? migrateLegacyOrganizationState(JSON.parse(rawValue))
        : null
    } catch {
      // Keep the fixture tenant available if browser persistence is corrupt.
    }
    store.set((current) =>
      isOrganizationState(parsed)
        ? {
            ...parsed,
            roles:
              parsed.roles && parsed.roles.length > 0
                ? parsed.roles
                : fixtureRoles,
            hydrated: true,
          }
        : { ...current, hydrated: true },
    )
    const persist = () => {
      const { hydrated: _hydrated, ...persistable } = store.getSnapshot()
      try {
        window.localStorage.setItem(
          ORGANIZATION_STORAGE_KEY,
          JSON.stringify(persistable),
        )
      } catch {
        // The normalized graph remains usable for this browser session.
      }
    }
    persist()
    return store.subscribe(persist)
  }, [store])

  return (
    <OrganizationStoreContext.Provider value={store}>
      {children}
    </OrganizationStoreContext.Provider>
  )
}

export function useOrganizationStore(): OrganizationStoreValue {
  const store = useContext(OrganizationStoreContext)
  if (!store) {
    throw new Error(
      "useOrganizationStore must be used within OrganizationStoreProvider",
    )
  }
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  )
  // Derived reads come from the rendered snapshot (not live store state) so a
  // component hydrating against the server snapshot stays self-consistent.
  return useMemo(
    () => ({
      ...snapshot,
      ...store.actions,
      projectsForCompany: (companyId: string) =>
        snapshot.projects.filter((project) => project.companyId === companyId),
      usersForCompany: (companyId: string) =>
        snapshot.users.filter((user) => user.companyId === companyId),
      primaryAdministratorForCompany: (companyId: string) =>
        snapshot.users.find(
          (user) =>
            user.companyId === companyId && user.isPrimaryAdministrator,
        ),
    }),
    [snapshot, store],
  )
}
