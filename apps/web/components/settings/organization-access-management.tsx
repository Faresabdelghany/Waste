"use client"

import { useMemo, useState, type FormEvent, type ReactNode } from "react"
import {
  DotsThree,
  Funnel,
  Info,
  MagnifyingGlass,
  Plus,
  Sliders,
} from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import { useApiConfigured, useApiSession } from "@/components/waste/api-session-store"
import {
  useBusinessRecordStore,
  useServerModuleState,
} from "@/components/waste/business-record-store"
import { InviteUserDialog } from "@/components/settings/invite-user-dialog"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
  DEACTIVATE_USER,
  isCompanyRecord,
  REACTIVATE_USER,
} from "@/lib/api/records/organisation"
import { IDLE } from "@/lib/api/records/server-records"
import {
  FIXTURE_COMPANY_ID,
  FIXTURE_SERVICE_PROVIDER_IDS,
  getWorkspaceDefinition,
  type BusinessRecord,
} from "@/lib/data/business-modules"
import {
  pilotEmptyState,
  projectPickerOptions,
  providerPickerOptions,
  rolePickerOptions,
  roleRowsOf,
  userRowsOf,
  type UserRow,
} from "@/lib/data/users-roles"
import { cn } from "@/lib/utils"

const roleScopeOptions = [
  "Company",
  "Assigned projects",
  "Company or project",
  "Own service provider",
] as const

const configureAccessModule = getWorkspaceDefinition("configure").modules.find(
  (module) => module.id === "access",
)
const organizationModule = getWorkspaceDefinition("configure").modules.find(
  (module) => module.id === "organization",
)
const serviceProvidersModule = getWorkspaceDefinition("service-providers").modules.find(
  (module) => module.id === "service-providers",
)
const serviceProviderAccessModule = getWorkspaceDefinition("service-providers").modules.find(
  (module) => module.id === "service-provider-workspace",
)

/** No records, shared: a `[]` made in render reads as mutable to the React Compiler and would keep it from compiling the pane. */
const NO_RECORDS: readonly BusinessRecord[] = []

function UserRowActions({
  row,
  self,
  disabled,
  onDeactivate,
  onReactivate,
}: {
  row: UserRow
  /** The signed-in person's own row: deactivating it would end their own session, and only another administrator could undo it. */
  self: boolean
  disabled: boolean
  onDeactivate: () => void
  onReactivate: () => void
}) {
  const deactivated = row.status.toLowerCase() === "deactivated"
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          type="button"
          aria-label={`Actions for ${row.name}`}
          className="h-7 w-7 rounded-lg text-muted-foreground"
          disabled={disabled}
        >
          <DotsThree className="h-4 w-4" weight="bold" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {deactivated ? (
          <DropdownMenuItem onSelect={onReactivate}>Reactivate</DropdownMenuItem>
        ) : self ? (
          <DropdownMenuItem disabled>Your own account is not deactivated here</DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={onDeactivate}>Deactivate</DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
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

function EmptyRow({
  colSpan,
  message,
  hint = "Try a different search or filter.",
}: {
  colSpan: number
  message: string
  hint?: string
}) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="h-52 text-center">
        <MagnifyingGlass className="mx-auto h-6 w-6 text-muted-foreground" />
        <p className="mt-2 text-sm font-medium">{message}</p>
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
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
  // On the Pilot (the adapter configured) the pane reads and writes the
  // access module through the record store and nothing else: the
  // organisation store below is fixture mode's (Issue #163).
  const configured = useApiConfigured()
  const { me } = useApiSession()
  const { getRecords, upsertRecord, sendCommand } = useBusinessRecordStore()
  const accessModuleState = useServerModuleState("configure", "access") ?? IDLE
  // The pickers' and the company name's modules: read only once each is
  // ready, since `getRecords` answers a module's fixtures until then and a
  // fixture project is one the API never returned.
  const organisationReady = useServerModuleState("configure", "organization")?.status === "ready"
  const providersReady = useServerModuleState("service-providers", "service-providers")?.status === "ready"
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
  const [serviceProvider, setServiceProvider] = useState("")

  const [newRoleOpen, setNewRoleOpen] = useState(false)
  const [roleName, setRoleName] = useState("")
  const [roleScope, setRoleScope] = useState("")
  const [rolePermissions, setRolePermissions] = useState("")

  // The row a command is out for, and the row Deactivate asks about first;
  // the row stays named while its dialog animates shut.
  const [pendingCommandId, setPendingCommandId] = useState<string | null>(null)
  const [deactivating, setDeactivating] = useState<UserRow | null>(null)
  const [deactivateOpen, setDeactivateOpen] = useState(false)

  const accessRecords = getRecords(
    "configure",
    "access",
    configureAccessModule?.records ?? [],
  )
  const serviceProviderAccessRecords = getRecords(
    "service-providers",
    "service-provider-workspace",
    serviceProviderAccessModule?.records ?? [],
  )
  // The Pilot's pickers and the company's name: the organisation and the
  // service-provider modules, as the store loaded them, and `/me` for the
  // company until the organisation module is ready.
  const organisationRecords: readonly BusinessRecord[] =
    configured && organisationReady ? getRecords("configure", "organization", organizationModule?.records ?? NO_RECORDS) : NO_RECORDS
  const providerRecords: readonly BusinessRecord[] =
    configured && providersReady ? getRecords("service-providers", "service-providers", serviceProvidersModule?.records ?? NO_RECORDS) : NO_RECORDS
  const companyRecord = organisationRecords.find(isCompanyRecord)
  // The caller's company is `/me`'s; the organisation record lends only its web id.
  const companyName = me?.company.name ?? "Company"
  // The pickers, before the rows' memos: a call over these arrays after the
  // memos reads to the React Compiler as a possible mutation of a dependency,
  // and it would then skip the pane.
  const roleOptions = rolePickerOptions(accessRecords)
  const projectOptions = projectPickerOptions(organisationRecords)
  const providerOptions = providerPickerOptions(providerRecords)

  const userRows = useMemo(
    () =>
      userRowsOf(
        configured
          ? { kind: "api", module: accessModuleState, companyName }
          : { kind: "fixtures", organizationUsers, companies, projects, roles, accessRecords, serviceProviderAccessRecords },
      ),
    [accessModuleState, accessRecords, companies, companyName, configured, organizationUsers, projects, roles, serviceProviderAccessRecords],
  )
  const roleRows = useMemo(
    () =>
      roleRowsOf(
        configured
          ? { kind: "api", module: accessModuleState, companyName }
          : { kind: "fixtures", organizationUsers, companies, projects, roles, accessRecords, serviceProviderAccessRecords },
      ),
    [accessModuleState, accessRecords, companies, companyName, configured, organizationUsers, projects, roles, serviceProviderAccessRecords],
  )
  const pilotUsersEmpty = configured ? pilotEmptyState(accessModuleState, "users") : null
  const pilotRolesEmpty = configured ? pilotEmptyState(accessModuleState, "roles") : null
  const pilotReady = !configured || accessModuleState.status === "ready"
  const selfEmail = me?.user.email.toLowerCase()

  const userStatusOptions = useMemo(
    () => [...new Set(userRows.map((user) => user.status))].sort(),
    [userRows],
  )
  const userOrganizationOptions = useMemo(
    () => [...new Set(userRows.map((user) => user.organization))].sort(),
    [userRows],
  )
  const roleScopeFilterOptions = useMemo(
    () => [...new Set(roleRows.map((roleDefinition) => roleDefinition.scope))].sort(),
    [roleRows],
  )

  // A promise chain rather than try/finally, which the React Compiler skips.
  // A refusal is toasted by the store in the API's words; only success is
  // this pane's to say.
  const runUserCommand = (row: UserRow, name: string, done: string) => {
    setPendingCommandId(row.id)
    return sendCommand("configure", "access", row.id, name)
      .then((outcome) => {
        if (outcome.kind === "done") toast.success(done)
      })
      .finally(() => setPendingCommandId(null))
  }

  const askToDeactivate = (row: UserRow) => {
    setDeactivating(row)
    setDeactivateOpen(true)
  }

  const confirmDeactivate = () => {
    if (deactivating === null) return
    const row = deactivating
    void runUserCommand(row, DEACTIVATE_USER, `${row.name} deactivated`).finally(() => setDeactivateOpen(false))
  }

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
    const matches = roleRows.filter((roleDefinition) => {
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
  }, [normalizedRoleQuery, roleRows, roleScopes, roleTypes, roleView])

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
    setServiceProvider("")
  }

  const handleUserDialogOpenChange = (nextOpen: boolean) => {
    setAddUserOpen(nextOpen)
    if (!nextOpen) resetUserForm()
  }

  const submitUser = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalizedEmail = email.trim().toLowerCase()
    const isServiceProviderRole = role.startsWith("Service Provider ")
    const selectedProject = selectedCompanyProjects.find(
      (project) => project.id === projectAccess,
    )

    if (
      !companyId ||
      !fullName.trim() ||
      !normalizedEmail ||
      !role ||
      !projectAccess ||
      (isServiceProviderRole && !serviceProvider)
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
    const serviceProviderId =
      serviceProvider === "NordRen ApS"
        ? FIXTURE_SERVICE_PROVIDER_IDS.nordren
        : serviceProvider === "CityHaul A/S"
          ? FIXTURE_SERVICE_PROVIDER_IDS.cityhaul
          : undefined
    try {
      const user = createUser({
        companyId,
        fullName,
        email: normalizedEmail,
        role,
        accessMode,
        projectIds,
        serviceProviderId,
        serviceProviderName: serviceProvider || undefined,
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
  const isServiceProviderRole = role.startsWith("Service Provider ")

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
              {roleRows.length}
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
            <Button
              size="sm"
              onClick={() => setAddUserOpen(true)}
              disabled={!pilotReady}
              title={pilotUsersEmpty?.message}
            >
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
          description="Everyone with access to the company — office users, service provider users, and machine accounts — with their role, organization, and project scope."
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
                  {configured && (
                    <TableHead className="h-10 w-12">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {usersPageRows.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell className="min-w-52 py-3">
                      <div className="flex items-center gap-2 font-medium text-foreground">
                        {user.name}
                        {user.primaryAdministrator && (
                          <Badge variant="muted" className="font-normal">
                            Primary administrator
                          </Badge>
                        )}
                      </div>
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
                    {configured && (
                      <TableCell className="w-12 text-right">
                        <UserRowActions
                          row={user}
                          self={user.email.toLowerCase() === selfEmail}
                          disabled={pendingCommandId !== null}
                          onDeactivate={() => askToDeactivate(user)}
                          onReactivate={() =>
                            void runUserCommand(user, REACTIVATE_USER, `${user.name} reactivated`)
                          }
                        />
                      </TableCell>
                    )}
                  </TableRow>
                ))}
                {filteredUsers.length === 0 && (
                  <EmptyRow
                    colSpan={configured ? 6 : 5}
                    message={pilotUsersEmpty?.message ?? "No users match your search."}
                    hint={pilotUsersEmpty?.hint}
                  />
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
          // New role is not offered on the Pilot: the dialog asks for no
          // description, which `POST /roles` needs, and a role written to the
          // browser must never be one Add user can pick (Issue #163).
          action={
            configured ? undefined : (
              <Button size="sm" onClick={() => setNewRoleOpen(true)}>
                <Plus className="h-4 w-4" weight="bold" /> New role
              </Button>
            )
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
          description="Roles bundle permissions at a scope — company, assigned projects, or own service provider. System roles are built in; custom roles are defined by your company."
        >
          <RecordsSection shown={filteredRoles.length} total={roleRows.length}>
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
                  // The permissions panel edits the organisation store's copy
                  // of a role, which on the Pilot would be a change the API
                  // never sees, so the rows open nothing there.
                  <TableRow
                    key={roleDefinition.id}
                    tabIndex={configured ? undefined : 0}
                    className={configured ? undefined : "cursor-pointer"}
                    aria-label={configured ? undefined : `Open permissions for ${roleDefinition.name}`}
                    onClick={configured ? undefined : () => setSelectedRoleId(roleDefinition.id)}
                    onKeyDown={
                      configured
                        ? undefined
                        : (event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault()
                              setSelectedRoleId(roleDefinition.id)
                            }
                          }
                    }
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
                    message={pilotRolesEmpty?.message ?? "No roles match your search."}
                    hint={pilotRolesEmpty?.hint}
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

      {configured && (
        <InviteUserDialog
          open={addUserOpen}
          onOpenChange={setAddUserOpen}
          roles={roleOptions}
          projects={projectOptions}
          providers={providerOptions}
          companyRecordId={companyRecord?.id}
          // The dialog says a refusal itself, so the store's toast is off;
          // and a record only goes out while the module is ready, never to
          // the browser's bucket.
          invite={(record) =>
            accessModuleState.status === "ready" ? upsertRecord("configure", "access", record, { report: false }) : undefined
          }
        />
      )}

      <Dialog open={deactivateOpen} onOpenChange={(nextOpen) => { if (!nextOpen && pendingCommandId === null) setDeactivateOpen(false) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Deactivate {deactivating?.name}?</DialogTitle>
            <DialogDescription>
              The account&apos;s next request to the API is refused and its session
              ends at its next token. Its role and access stay as they are, and
              Reactivate lets it back in.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeactivateOpen(false)}
              disabled={pendingCommandId !== null}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={confirmDeactivate}
              disabled={pendingCommandId !== null}
            >
              {pendingCommandId === null ? "Deactivate" : "Deactivating…"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!configured && addUserOpen} onOpenChange={handleUserDialogOpenChange}>
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
                    setServiceProvider("")
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
                      setServiceProvider("")
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
              {isServiceProviderRole && (
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="organization-user-service-provider">
                    Service provider
                  </Label>
                  <Select value={serviceProvider} onValueChange={setServiceProvider}>
                    <SelectTrigger id="organization-user-service-provider">
                      <SelectValue placeholder="Select service provider" />
                    </SelectTrigger>
                    <SelectContent>
                      {companyId === FIXTURE_COMPANY_ID ? (
                        <>
                          <SelectItem value="NordRen ApS">NordRen ApS</SelectItem>
                          <SelectItem value="CityHaul A/S">CityHaul A/S</SelectItem>
                        </>
                      ) : (
                        <SelectItem value="no-service-providers" disabled>
                          No service providers in this company
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                  {companyId !== FIXTURE_COMPANY_ID && (
                    <p className="text-xs text-muted-foreground">
                      Add a service provider to this company before inviting a
                      service provider user.
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
