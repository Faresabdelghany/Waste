"use client"

import { useMemo, useState, type FormEvent, type ReactNode } from "react"
import {
  Funnel,
  Info,
  MagnifyingGlass,
  Plus,
  Sliders,
} from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import { useBusinessRecordStore } from "@/components/wastehero/business-record-store"
import { useOrganizationStore } from "@/components/settings/organization-store"
import { RolePermissionsPanel } from "@/components/settings/role-permissions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  TablePagination,
  useTablePagination,
} from "@/components/ui/table-pagination"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  FIXTURE_COMPANY_ID,
  FIXTURE_CONTRACTOR_IDS,
  getWorkspaceDefinition,
  type BusinessRecord,
} from "@/lib/data/business-modules"
import { cn } from "@/lib/utils"

type UserRow = {
  id: string
  name: string
  email: string
  role: string
  organization: string
  projectAccess: string
  status: string
}

const roleScopeOptions = [
  "Company",
  "Assigned projects",
  "Company or project",
  "Own contractor",
] as const

const configureAccessModule = getWorkspaceDefinition("configure").modules.find(
  (module) => module.id === "access",
)
const contractorAccessModule = getWorkspaceDefinition("contractors").modules.find(
  (module) => module.id === "contractor-workspace",
)

function roleForRecord(record: BusinessRecord) {
  if (record.submittedValues?.role) return String(record.submittedValues.role)
  if (record.facts.Roles) return record.facts.Roles

  const context = record.context.toLowerCase()
  if (context.includes("foreman")) return "Contractor Foreman"
  if (context.includes("manager")) return "Contractor Manager"
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
  if (record.submittedValues?.contractor) {
    return String(record.submittedValues.contractor)
  }
  if (record.facts.Contractor) {
    return record.facts.Contractor.replace(/\s+only$/i, "")
  }
  return "WasteHero Denmark"
}

function emailForRecord(record: BusinessRecord) {
  if (record.submittedValues?.email) return String(record.submittedValues.email)
  if (record.id === "user-olivia") return "olivia.larsen@wastehero.example"
  if (record.id === "user-temp") return "integration.user@wastehero.example"
  return "Managed contractor account"
}

function statusClassName(status: string) {
  const normalized = status.toLowerCase()
  if (normalized === "active") {
    return "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
  }
  if (normalized === "invited") {
    return "border-blue-500/20 bg-blue-500/10 text-blue-700 dark:text-blue-300"
  }
  if (
    normalized.includes("review") ||
    normalized.includes("issue") ||
    normalized.includes("restricted")
  ) {
    return "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300"
  }
  return "border-border bg-muted text-muted-foreground"
}

type TableView = {
  ordering: string
  showDetails: boolean
}

type FilterGroup = {
  label: string
  options: readonly string[]
  value: string[]
  onChange: (value: string[]) => void
}

function FilterPopover({ groups }: { groups: FilterGroup[] }) {
  const activeCount = groups.reduce((sum, group) => sum + group.value.length, 0)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-2 rounded-lg border-border/60 bg-transparent px-3"
        >
          <Funnel className="h-4 w-4" />
          Filter
          {activeCount > 0 && (
            <span className="rounded-full bg-primary/10 px-1.5 text-[10px] font-medium text-primary">
              {activeCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 rounded-xl p-0">
        <div className="space-y-3 p-4">
          <div>
            <p className="text-sm font-semibold">Filter</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Narrow the table by {groups.map((group) => group.label.toLowerCase()).join(" and ")}.
            </p>
          </div>
          {groups.map((group) => (
            <div key={group.label} className="space-y-2">
              {groups.length > 1 && (
                <p className="text-xs font-medium text-muted-foreground">{group.label}</p>
              )}
              {group.options.map((option) => (
                <label key={option} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={group.value.includes(option)}
                    onCheckedChange={(checked) =>
                      group.onChange(
                        checked
                          ? [...group.value, option]
                          : group.value.filter((item) => item !== option),
                      )
                    }
                  />
                  {option}
                </label>
              ))}
            </div>
          ))}
          {activeCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => groups.forEach((group) => group.onChange([]))}
            >
              Clear filters
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function ViewPopover({
  value,
  onChange,
  orderingOptions,
  detailsLabel,
}: {
  value: TableView
  onChange: (value: TableView) => void
  orderingOptions: Array<{ value: string; label: string }>
  detailsLabel: string
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-2 rounded-lg border-border/60 bg-transparent px-3"
        >
          <Sliders className="h-4 w-4" />
          View
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 rounded-xl p-0">
        <div className="space-y-4 p-4">
          <div>
            <p className="text-sm font-semibold">Table view</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Choose ordering and visible details.
            </p>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm">Ordering</span>
            <Select
              value={value.ordering}
              onValueChange={(ordering) => onChange({ ...value, ordering })}
            >
              <SelectTrigger className="h-8 w-44 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {orderingOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <label className="flex items-center justify-between gap-4 text-sm">
            {detailsLabel}
            <Switch
              checked={value.showDetails}
              onCheckedChange={(showDetails) => onChange({ ...value, showDetails })}
            />
          </label>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function Toolbar({
  searchPlaceholder,
  query,
  onQueryChange,
  filterGroups,
  view,
  onViewChange,
  orderingOptions,
  detailsLabel,
}: {
  searchPlaceholder: string
  query: string
  onQueryChange: (value: string) => void
  filterGroups: FilterGroup[]
  view: TableView
  onViewChange: (value: TableView) => void
  orderingOptions: Array<{ value: string; label: string }>
  detailsLabel: string
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-[260px] flex-1 flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] max-w-sm flex-1">
          <MagnifyingGlass className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={searchPlaceholder}
            className="h-8 pl-9 text-sm"
          />
        </div>
        <FilterPopover groups={filterGroups} />
        <ViewPopover
          value={view}
          onChange={onViewChange}
          orderingOptions={orderingOptions}
          detailsLabel={detailsLabel}
        />
      </div>
    </div>
  )
}

function RecordsSection({
  shown,
  total,
  children,
}: {
  shown: number
  total: number
  children: ReactNode
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border/60">
      <div className="border-b border-border px-4 py-2">
        <p className="text-xs text-muted-foreground">
          {shown === total ? `${shown} records` : `${shown} of ${total} records`}
        </p>
      </div>
      {children}
    </section>
  )
}

function EmptyRow({ colSpan, message }: { colSpan: number; message: string }) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="h-52 text-center">
        <MagnifyingGlass className="mx-auto h-6 w-6 text-muted-foreground" />
        <p className="mt-2 text-sm font-medium">{message}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Try a different search or filter.
        </p>
      </TableCell>
    </TableRow>
  )
}

function PanelShell({
  action,
  tabs,
  toolbar,
  title,
  description,
  children,
}: {
  action?: ReactNode
  tabs: ReactNode
  toolbar: ReactNode
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-1 flex-col">
      <header className="flex flex-col border-b border-border/40">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <p className="text-base font-medium text-foreground">Users &amp; roles</p>
          {action && <div className="flex items-center gap-2">{action}</div>}
        </div>
        <div className="flex flex-col gap-3 px-4 py-3">
          {tabs}
          {toolbar}
        </div>
      </header>
      <div className="flex-1 p-4">
        <div className="mx-auto max-w-[1500px] space-y-4">
          <section className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={`About ${title}`}
                  >
                    <Info className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-sm text-xs">
                  {description}
                </TooltipContent>
              </Tooltip>
            </div>
          </section>
          {children}
        </div>
      </div>
    </div>
  )
}

const defaultUserView: TableView = { ordering: "name", showDetails: true }
const defaultRoleView: TableView = { ordering: "default", showDetails: true }

export function OrganizationAccessManagement() {
  const { getRecords } = useBusinessRecordStore()
  const {
    companies,
    projects,
    users: organizationUsers,
    roles,
    createUser,
    createRole,
  } = useOrganizationStore()
  const [activeTab, setActiveTab] = useState("users")
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null)

  const [userQuery, setUserQuery] = useState("")
  const [userStatuses, setUserStatuses] = useState<string[]>([])
  const [userOrganizations, setUserOrganizations] = useState<string[]>([])
  const [userView, setUserView] = useState<TableView>(defaultUserView)

  const [roleQuery, setRoleQuery] = useState("")
  const [roleTypes, setRoleTypes] = useState<string[]>([])
  const [roleScopes, setRoleScopes] = useState<string[]>([])
  const [roleView, setRoleView] = useState<TableView>(defaultRoleView)

  const [addUserOpen, setAddUserOpen] = useState(false)
  const [companyId, setCompanyId] = useState(FIXTURE_COMPANY_ID)
  const [fullName, setFullName] = useState("")
  const [email, setEmail] = useState("")
  const [role, setRole] = useState("")
  const [projectAccess, setProjectAccess] = useState("")
  const [contractor, setContractor] = useState("")

  const [newRoleOpen, setNewRoleOpen] = useState(false)
  const [roleName, setRoleName] = useState("")
  const [roleScope, setRoleScope] = useState("")
  const [rolePermissions, setRolePermissions] = useState("")

  const accessRecords = getRecords(
    "configure",
    "access",
    configureAccessModule?.records ?? [],
  )
  const contractorAccessRecords = getRecords(
    "contractors",
    "contractor-workspace",
    contractorAccessModule?.records ?? [],
  )

  const userRows = useMemo<UserRow[]>(() => {
    const companyById = new Map(
      companies.map((company) => [company.id, company]),
    )
    const projectById = new Map(
      projects.map((project) => [project.id, project]),
    )
    const normalizedUsers = organizationUsers.map((user) => {
      const company = companyById.get(user.companyId)
      const projectAccess =
        user.accessMode === "all-company-projects"
          ? "All projects"
          : user.accessMode === "none"
            ? "No project access"
            : user.projectIds
                .map((projectId) => projectById.get(projectId)?.name)
                .filter(Boolean)
                .join(", ") || "No project access"

      return {
        id: user.id,
        name: user.fullName,
        email: user.email,
        role: user.role,
        organization: user.contractorName ?? company?.name ?? "Unknown company",
        projectAccess,
        status: user.status,
      }
    })
    const normalizedUserIds = new Set(
      organizationUsers.map((user) => user.id),
    )
    const normalizedUserEmails = new Set(
      organizationUsers.map((user) => user.email.toLowerCase()),
    )
    const officeUsers = accessRecords
      .filter(
        (record) =>
          !normalizedUserIds.has(record.id) &&
          !normalizedUserEmails.has(emailForRecord(record).toLowerCase()) &&
          (record.recordKind === "User" ||
            (record.facts.Identity !== "Role" &&
              !record.id.startsWith("role-"))),
      )
      .map((record) => ({
        id: record.id,
        name: record.name,
        email: emailForRecord(record),
        role: roleForRecord(record),
        organization: organizationForRecord(record),
        projectAccess: projectAccessForRecord(record),
        status: record.status,
      }))

    const contractorUsers = contractorAccessRecords.map((record) => ({
      id: record.id,
      name:
        record.owner && record.owner !== "Contract Team"
          ? record.owner
          : record.name,
      email: emailForRecord(record),
      role: roleForRecord(record),
      organization: organizationForRecord(record),
      projectAccess: projectAccessForRecord(record),
      status: record.status,
    }))

    return [...normalizedUsers, ...officeUsers, ...contractorUsers].sort(
      (a, b) => a.name.localeCompare(b.name),
    )
  }, [
    accessRecords,
    companies,
    contractorAccessRecords,
    organizationUsers,
    projects,
  ])

  const userStatusOptions = useMemo(
    () => [...new Set(userRows.map((user) => user.status))].sort(),
    [userRows],
  )
  const userOrganizationOptions = useMemo(
    () => [...new Set(userRows.map((user) => user.organization))].sort(),
    [userRows],
  )
  const roleScopeFilterOptions = useMemo(
    () => [...new Set(roles.map((roleDefinition) => roleDefinition.scope))].sort(),
    [roles],
  )

  const normalizedUserQuery = userQuery.trim().toLowerCase()
  const filteredUsers = useMemo(() => {
    const matches = userRows.filter((user) => {
      if (userStatuses.length > 0 && !userStatuses.includes(user.status)) {
        return false
      }
      if (
        userOrganizations.length > 0 &&
        !userOrganizations.includes(user.organization)
      ) {
        return false
      }
      if (!normalizedUserQuery) return true
      return [
        user.name,
        user.email,
        user.role,
        user.organization,
        user.projectAccess,
        user.status,
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedUserQuery)
    })
    return [...matches].sort((a, b) =>
      userView.ordering === "role"
        ? a.role.localeCompare(b.role) || a.name.localeCompare(b.name)
        : a.name.localeCompare(b.name),
    )
  }, [normalizedUserQuery, userOrganizations, userRows, userStatuses, userView])

  const normalizedRoleQuery = roleQuery.trim().toLowerCase()
  const filteredRoles = useMemo(() => {
    const matches = roles.filter((roleDefinition) => {
      if (roleTypes.length > 0 && !roleTypes.includes(roleDefinition.type)) {
        return false
      }
      if (roleScopes.length > 0 && !roleScopes.includes(roleDefinition.scope)) {
        return false
      }
      if (!normalizedRoleQuery) return true
      return [
        roleDefinition.name,
        roleDefinition.type,
        roleDefinition.scope,
        roleDefinition.permissions,
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedRoleQuery)
    })
    if (roleView.ordering === "name") {
      return [...matches].sort((a, b) => a.name.localeCompare(b.name))
    }
    return matches
  }, [normalizedRoleQuery, roleScopes, roleTypes, roleView, roles])

  const {
    page: usersPage,
    setPage: setUsersPage,
    pageCount: usersPageCount,
    pageRows: usersPageRows,
    totalCount: usersTotalCount,
  } = useTablePagination(filteredUsers)
  const {
    page: rolesPage,
    setPage: setRolesPage,
    pageCount: rolesPageCount,
    pageRows: rolesPageRows,
    totalCount: rolesTotalCount,
  } = useTablePagination(filteredRoles)

  const selectedCompany = companies.find(
    (company) => company.id === companyId,
  )
  const selectedCompanyProjects = projects.filter(
    (project) => project.companyId === companyId,
  )

  const resetUserForm = () => {
    setCompanyId(FIXTURE_COMPANY_ID)
    setFullName("")
    setEmail("")
    setRole("")
    setProjectAccess("")
    setContractor("")
  }

  const handleUserDialogOpenChange = (nextOpen: boolean) => {
    setAddUserOpen(nextOpen)
    if (!nextOpen) resetUserForm()
  }

  const submitUser = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalizedEmail = email.trim().toLowerCase()
    const isContractorRole = role.startsWith("Contractor ")
    const selectedProject = selectedCompanyProjects.find(
      (project) => project.id === projectAccess,
    )

    if (
      !companyId ||
      !fullName.trim() ||
      !normalizedEmail ||
      !role ||
      !projectAccess ||
      (isContractorRole && !contractor)
    ) {
      toast.error("Complete the required fields")
      return
    }

    if (
      userRows.some(
        (user) => user.email.toLowerCase() === normalizedEmail,
      )
    ) {
      toast.error("A user with this email already exists")
      return
    }

    const accessMode =
      role === "Company Administrator" || projectAccess === "all"
        ? "all-company-projects"
        : projectAccess === "none"
          ? "none"
          : "selected-projects"
    const projectIds = selectedProject ? [selectedProject.id] : []
    const contractorId =
      contractor === "NordRen ApS"
        ? FIXTURE_CONTRACTOR_IDS.nordren
        : contractor === "CityHaul A/S"
          ? FIXTURE_CONTRACTOR_IDS.cityhaul
          : undefined
    try {
      const user = createUser({
        companyId,
        fullName,
        email: normalizedEmail,
        role,
        accessMode,
        projectIds,
        contractorId,
        contractorName: contractor || undefined,
      })
      handleUserDialogOpenChange(false)
      toast.success("User added", {
        description: `${user.fullName} has been added to ${selectedCompany?.name ?? "the company"} with an invited status.`,
      })
    } catch (caughtError) {
      toast.error("User could not be added", {
        description:
          caughtError instanceof Error
            ? caughtError.message
            : "Review the company and project access.",
      })
    }
  }

  const resetRoleForm = () => {
    setRoleName("")
    setRoleScope("")
    setRolePermissions("")
  }

  const handleRoleDialogOpenChange = (nextOpen: boolean) => {
    setNewRoleOpen(nextOpen)
    if (!nextOpen) resetRoleForm()
  }

  const submitRole = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!roleName.trim() || !roleScope) {
      toast.error("Complete the role name and scope")
      return
    }

    try {
      const createdRole = createRole({
        name: roleName,
        scope: roleScope,
        permissions: rolePermissions,
      })
      handleRoleDialogOpenChange(false)
      toast.success("Role created", {
        description: `${createdRole.name} can now be assigned when adding users.`,
      })
    } catch (caughtError) {
      toast.error("Role could not be created", {
        description:
          caughtError instanceof Error
            ? caughtError.message
            : "Review the role name and scope.",
      })
    }
  }

  const roleUserCount = (roleName: string) =>
    userRows.filter((user) => user.role === roleName).length
  const isContractorRole = role.startsWith("Contractor ")

  const tabs = (
    <div className="flex items-center gap-1 overflow-x-auto pb-1">
      <Tabs
        value={activeTab}
        onValueChange={(tab) => {
          setActiveTab(tab)
          setSelectedRoleId(null)
        }}
      >
        <TabsList className="inline-flex h-8 bg-muted rounded-full px-1 py-0.5 text-xs border border-border/50">
          <TabsTrigger value="users" className="rounded-full px-3 whitespace-nowrap">
            Users
            <span className="ml-1.5 text-[10px] text-muted-foreground">
              {userRows.length}
            </span>
          </TabsTrigger>
          <TabsTrigger value="roles" className="rounded-full px-3 whitespace-nowrap">
            Roles
            <span className="ml-1.5 text-[10px] text-muted-foreground">
              {roles.length}
            </span>
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  )

  return (
    <>
      {activeTab === "users" ? (
        <PanelShell
          tabs={tabs}
          action={
            <Button size="sm" onClick={() => setAddUserOpen(true)}>
              <Plus className="h-4 w-4" weight="bold" /> Add user
            </Button>
          }
          toolbar={
            <Toolbar
              searchPlaceholder="Search users"
              query={userQuery}
              onQueryChange={setUserQuery}
              filterGroups={[
                {
                  label: "Status",
                  options: userStatusOptions,
                  value: userStatuses,
                  onChange: setUserStatuses,
                },
                {
                  label: "Organization",
                  options: userOrganizationOptions,
                  value: userOrganizations,
                  onChange: setUserOrganizations,
                },
              ]}
              view={userView}
              onViewChange={setUserView}
              orderingOptions={[
                { value: "name", label: "Name" },
                { value: "role", label: "Role" },
              ]}
              detailsLabel="Show emails"
            />
          }
          title="Users"
          description="Everyone with access to the company — office users, contractor users, and machine accounts — with their role, organization, and project scope."
        >
          <RecordsSection shown={filteredUsers.length} total={userRows.length}>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-10">User</TableHead>
                  <TableHead className="h-10">Role</TableHead>
                  <TableHead className="h-10">Organization</TableHead>
                  <TableHead className="h-10">Project access</TableHead>
                  <TableHead className="h-10">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usersPageRows.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell className="min-w-52 py-3">
                      <div className="font-medium text-foreground">{user.name}</div>
                      {userView.showDetails && (
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {user.email}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="min-w-40">{user.role}</TableCell>
                    <TableCell className="min-w-40">{user.organization}</TableCell>
                    <TableCell className="min-w-44">{user.projectAccess}</TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={cn("whitespace-nowrap", statusClassName(user.status))}
                      >
                        {user.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
                {filteredUsers.length === 0 && (
                  <EmptyRow colSpan={5} message="No users match your search." />
                )}
              </TableBody>
            </Table>
            <TablePagination
              page={usersPage}
              pageCount={usersPageCount}
              totalCount={usersTotalCount}
              onPageChange={setUsersPage}
            />
          </RecordsSection>
        </PanelShell>
      ) : selectedRoleId ? (
        <RolePermissionsPanel
          roleId={selectedRoleId}
          onBack={() => setSelectedRoleId(null)}
        />
      ) : (
        <PanelShell
          tabs={tabs}
          action={
            <Button size="sm" onClick={() => setNewRoleOpen(true)}>
              <Plus className="h-4 w-4" weight="bold" /> New role
            </Button>
          }
          toolbar={
            <Toolbar
              searchPlaceholder="Search roles"
              query={roleQuery}
              onQueryChange={setRoleQuery}
              filterGroups={[
                {
                  label: "Type",
                  options: ["System", "Custom"],
                  value: roleTypes,
                  onChange: setRoleTypes,
                },
                {
                  label: "Scope",
                  options: roleScopeFilterOptions,
                  value: roleScopes,
                  onChange: setRoleScopes,
                },
              ]}
              view={roleView}
              onViewChange={setRoleView}
              orderingOptions={[
                { value: "default", label: "Default order" },
                { value: "name", label: "Name" },
              ]}
              detailsLabel="Show access summary"
            />
          }
          title="Roles"
          description="Roles bundle permissions at a scope — company, assigned projects, or own contractor. System roles are built in; custom roles are defined by your company."
        >
          <RecordsSection shown={filteredRoles.length} total={roles.length}>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-10">Role</TableHead>
                  <TableHead className="h-10">Type</TableHead>
                  <TableHead className="h-10">Users</TableHead>
                  <TableHead className="h-10">Scope</TableHead>
                  {roleView.showDetails && (
                    <TableHead className="h-10">Access</TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rolesPageRows.map((roleDefinition) => (
                  <TableRow
                    key={roleDefinition.id}
                    tabIndex={0}
                    className="cursor-pointer"
                    aria-label={`Open permissions for ${roleDefinition.name}`}
                    onClick={() => setSelectedRoleId(roleDefinition.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault()
                        setSelectedRoleId(roleDefinition.id)
                      }
                    }}
                  >
                    <TableCell className="min-w-48 py-3 font-medium text-foreground">
                      {roleDefinition.name}
                    </TableCell>
                    <TableCell>
                      <Badge variant="muted">{roleDefinition.type}</Badge>
                    </TableCell>
                    <TableCell>{roleUserCount(roleDefinition.name)}</TableCell>
                    <TableCell className="min-w-40">
                      {roleDefinition.scope}
                    </TableCell>
                    {roleView.showDetails && (
                      <TableCell className="min-w-64 text-muted-foreground">
                        {roleDefinition.permissions}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
                {filteredRoles.length === 0 && (
                  <EmptyRow
                    colSpan={roleView.showDetails ? 5 : 4}
                    message="No roles match your search."
                  />
                )}
              </TableBody>
            </Table>
            <TablePagination
              page={rolesPage}
              pageCount={rolesPageCount}
              totalCount={rolesTotalCount}
              onPageChange={setRolesPage}
            />
          </RecordsSection>
        </PanelShell>
      )}

      <Dialog open={addUserOpen} onOpenChange={handleUserDialogOpenChange}>
        <DialogContent className="sm:max-w-xl">
          <form onSubmit={submitUser}>
            <DialogHeader>
              <DialogTitle>Add user</DialogTitle>
              <DialogDescription>
                Add a user and assign their role and project access.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4 py-5 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="organization-user-company">Company</Label>
                <Select
                  value={companyId}
                  onValueChange={(value) => {
                    setCompanyId(value)
                    setProjectAccess("")
                    setContractor("")
                  }}
                >
                  <SelectTrigger id="organization-user-company">
                    <SelectValue placeholder="Select company" />
                  </SelectTrigger>
                  <SelectContent>
                    {companies.map((company) => (
                      <SelectItem key={company.id} value={company.id}>
                        {company.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  A user belongs to one company. Project access cannot cross
                  this boundary.
                </p>
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="organization-user-name">Full name</Label>
                <Input
                  id="organization-user-name"
                  value={fullName}
                  onChange={(event) => setFullName(event.target.value)}
                  autoComplete="name"
                  required
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="organization-user-email">Email</Label>
                <Input
                  id="organization-user-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="email"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="organization-user-role">Role</Label>
                <Select
                  value={role}
                  onValueChange={(value) => {
                    setRole(value)
                    if (value === "Company Administrator") {
                      setProjectAccess("all")
                      setContractor("")
                    }
                  }}
                >
                  <SelectTrigger id="organization-user-role">
                    <SelectValue placeholder="Select role" />
                  </SelectTrigger>
                  <SelectContent>
                    {roles.map((roleDefinition) => (
                      <SelectItem
                        key={roleDefinition.id}
                        value={roleDefinition.name}
                      >
                        {roleDefinition.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="organization-user-project">Project access</Label>
                <Select
                  value={projectAccess}
                  onValueChange={setProjectAccess}
                  disabled={role === "Company Administrator"}
                >
                  <SelectTrigger id="organization-user-project">
                    <SelectValue placeholder="Select access" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">
                      No project access
                    </SelectItem>
                    {selectedCompanyProjects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name}
                      </SelectItem>
                    ))}
                    <SelectItem value="all">
                      All current and future projects
                    </SelectItem>
                  </SelectContent>
                </Select>
                {role === "Company Administrator" && (
                  <p className="text-xs text-muted-foreground">
                    Company administrators always cover all projects.
                  </p>
                )}
              </div>
              {isContractorRole && (
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="organization-user-contractor">
                    Contractor
                  </Label>
                  <Select value={contractor} onValueChange={setContractor}>
                    <SelectTrigger id="organization-user-contractor">
                      <SelectValue placeholder="Select contractor" />
                    </SelectTrigger>
                    <SelectContent>
                      {companyId === FIXTURE_COMPANY_ID ? (
                        <>
                          <SelectItem value="NordRen ApS">NordRen ApS</SelectItem>
                          <SelectItem value="CityHaul A/S">CityHaul A/S</SelectItem>
                        </>
                      ) : (
                        <SelectItem value="no-contractors" disabled>
                          No contractors in this company
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                  {companyId !== FIXTURE_COMPANY_ID && (
                    <p className="text-xs text-muted-foreground">
                      Add a contractor to this company before inviting a
                      contractor user.
                    </p>
                  )}
                </div>
              )}
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => handleUserDialogOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit">Add user</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={newRoleOpen} onOpenChange={handleRoleDialogOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <form onSubmit={submitRole}>
            <DialogHeader>
              <DialogTitle>New role</DialogTitle>
              <DialogDescription>
                Custom roles bundle permissions at a scope and can be assigned
                when adding users.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4 py-5">
              <div className="space-y-2">
                <Label htmlFor="organization-role-name">
                  Role name<span className="ml-1 text-destructive">*</span>
                </Label>
                <Input
                  id="organization-role-name"
                  value={roleName}
                  onChange={(event) => setRoleName(event.target.value)}
                  placeholder="Depot Supervisor"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="organization-role-scope">
                  Scope<span className="ml-1 text-destructive">*</span>
                </Label>
                <Select value={roleScope} onValueChange={setRoleScope}>
                  <SelectTrigger id="organization-role-scope">
                    <SelectValue placeholder="Select scope" />
                  </SelectTrigger>
                  <SelectContent>
                    {roleScopeOptions.map((scope) => (
                      <SelectItem key={scope} value={scope}>
                        {scope}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Where the role applies when it is assigned to a user.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="organization-role-permissions">
                  Permissions summary
                </Label>
                <Textarea
                  id="organization-role-permissions"
                  value={rolePermissions}
                  onChange={(event) => setRolePermissions(event.target.value)}
                  placeholder="Warehouses, containers, and spare parts"
                  rows={3}
                />
                <p className="text-xs text-muted-foreground">
                  Shown in the roles table to describe what this role can
                  access.
                </p>
              </div>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => handleRoleDialogOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit">Create role</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
