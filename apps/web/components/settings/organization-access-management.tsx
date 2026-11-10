"use client"

import { useMemo, useState, type ReactNode } from "react"
import {
  DotsThree,
  Funnel,
  MagnifyingGlass,
  Plus,
  Sliders,
} from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import { useApiSession } from "@/components/platform/api-session-store"
import {
  useBusinessRecordStore,
  useModuleRecords,
  useServerModuleState,
  whenSaved,
} from "@/components/platform/business-record-store"
import { BusinessRecordFormDialog } from "@/components/platform/business-record-form-dialog"
import { AssetPanelShell, EmptyRow, RecordsSection } from "@/components/settings/settings-pane-kit"
import { InviteUserDialog } from "@/components/settings/invite-user-dialog"
import { NewRoleDialog } from "@/components/settings/new-role-dialog"
import { PilotRolePermissionsPanel } from "@/components/settings/pilot-role-permissions"
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
import {
  DEACTIVATE_USER,
  REACTIVATE_USER,
  roleAdapter,
} from "@/lib/api/records/organisation"
import { IDLE, type PaneAnswer } from "@/lib/api/records/server-records"
import { isTicketTeamRecord } from "@/lib/api/records/ticket-teams"
import { accessUnknownSentence } from "@/lib/api/session"
import type { BusinessFormField, BusinessFormOption, BusinessFormValues } from "@/lib/data/business-form-types"
import {
  createTicketTeamRecord,
  ticketTeamsAccessOf,
  TICKET_TEAM_EDIT_FORM,
  TICKET_TEAM_FORM,
  TICKET_TEAMS_MODULE,
  updateTicketTeamRecord,
} from "@/lib/data/ticket-teams"
import { ACCESS_MODULE } from "@/lib/data/tickets"
import { isSoftDeleted } from "@/lib/prototype/record-visibility"
import {
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
} from "@/lib/api/users-roles"
import { settingsTabsOf, type SettingsTabOf } from "@/lib/modules/settings-panes"
import type { SettingsPaneProps } from "@/lib/modules/settings-panes"
import { cn } from "@/lib/utils"
import { moduleReadSentence } from "@/lib/api/read-state"
import { useGrants } from "@/components/platform/use-grants"

const roleScopeOptions = [
  "Company",
  "Assigned projects",
  "Company or project",
  "Own service provider",
] as const


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
    return "border-success/20 bg-success/10 text-success-foreground"
  }
  if (normalized === "invited") {
    return "border-info/20 bg-info/10 text-info-foreground"
  }
  if (
    normalized.includes("review") ||
    normalized.includes("issue") ||
    normalized.includes("restricted")
  ) {
    return "border-warning/20 bg-warning/10 text-warning-foreground"
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

const defaultUserView: TableView = { ordering: "name", showDetails: true }
const defaultRoleView: TableView = { ordering: "default", showDetails: true }
const defaultTeamView: TableView = { ordering: "default", showDetails: true }

function TeamRowActions({
  team,
  disabled,
  onEdit,
  onStatus,
}: {
  team: BusinessRecord
  disabled: boolean
  onEdit: () => void
  onStatus: (status: "Active" | "Inactive") => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          type="button"
          aria-label={`Actions for ${team.name}`}
          className="h-7 w-7 rounded-lg text-muted-foreground"
          disabled={disabled}
        >
          <DotsThree className="h-4 w-4" weight="bold" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuItem onSelect={onEdit}>Edit</DropdownMenuItem>
        {team.status === "Active" ? (
          <DropdownMenuItem onSelect={() => onStatus("Inactive")}>Retire</DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={() => onStatus("Active")}>Reactivate</DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The Teams tab's search, filter, view and page, which the pane holds as it holds the Users' and the Roles', so leaving the tab and coming back finds them as they were. */
type TeamsTable = {
  query: string
  onQueryChange: (query: string) => void
  statuses: string[]
  onStatusesChange: (statuses: string[]) => void
  view: TableView
  onViewChange: (view: TableView) => void
  filtered: readonly BusinessRecord[]
  pagination: ReturnType<typeof useTablePagination<BusinessRecord>>
}

/**
 * The Teams tab (O30 of #290, moved from Settings › Tickets): the company's
 * teams a ticket waits with — added, edited, retired and reactivated through
 * the record store, which on the Pilot reaches `/teams` through
 * lib/api/records/ticket-teams.ts. Which team a ticket opened without one
 * takes stays Settings › Tickets' Default teams tab. Offered on the Pilot
 * alone, since the teams are the API's.
 */
function TeamsPanel({ tabs, teams, rows, table }: { tabs: ReactNode; teams: PaneAnswer; rows: readonly BusinessRecord[]; table: TeamsTable }) {
  const session = useApiSession()
  const access = ticketTeamsAccessOf(useGrants())
  const { upsertRecord } = useBusinessRecordStore()
  const users = useModuleRecords(ACCESS_MODULE.workspaceId, ACCESS_MODULE.moduleId)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<BusinessRecord | null>(null)
  const [saving, setSaving] = useState(false)
  const { query, onQueryChange: setQuery, statuses, onStatusesChange: setStatuses, view, onViewChange: setView, filtered } = table
  const { page, setPage, pageCount, pageRows, totalCount } = table.pagination

  // The accounts a member may be: the company's own people, never a provider's.
  const relationOptions = (field: BusinessFormField): readonly BusinessFormOption[] =>
    field.id === "memberUserAccountIds"
      ? users.records.filter((record) => record.recordKind === "User" && record.serviceProviderId === undefined && !isSoftDeleted(record)).map((record) => ({ value: record.id, label: record.name }))
      : (field.options ?? [])

  const write = (record: BusinessRecord, done: () => void, said: string) => {
    if (saving) return
    setSaving(true)
    whenSaved(
      upsertRecord(TICKET_TEAMS_MODULE.workspaceId, TICKET_TEAMS_MODULE.moduleId, record),
      () => {
        done()
        toast.success(said, { description: record.name })
      },
      () => setSaving(false),
    )
  }
  const handleCreate = (values: BusinessFormValues) => write(createTicketTeamRecord(values, { now: Date.now() }), () => setCreating(false), "Team added")
  const handleEdit = (values: BusinessFormValues) => {
    if (editing !== null) write(updateTicketTeamRecord(editing, values), () => setEditing(null), "Team saved")
  }
  const setStatus = (team: BusinessRecord, status: "Active" | "Inactive") =>
    write(updateTicketTeamRecord(team, { status }), () => undefined, status === "Active" ? "Team reactivated" : "Team retired")

  const emptyMessage =
    accessUnknownSentence(session) ??
    moduleReadSentence(teams, "teams", { notShown: "ticket teams" }) ??
    (rows.length > 0 ? "No teams match your search." : "No team yet.")

  return (
    <>
      <AssetPanelShell
        tabs={tabs}
        toolbar={
          <Toolbar
            searchPlaceholder="Search teams"
            query={query}
            onQueryChange={setQuery}
            filterGroups={[{ label: "Status", options: ["Active", "Inactive"], value: statuses, onChange: setStatuses }]}
            view={view}
            onViewChange={setView}
            orderingOptions={[
              { value: "default", label: "Default order" },
              { value: "name", label: "Name" },
            ]}
            detailsLabel="Show members"
          />
        }
        title="Teams"
        description="The teams the company's tickets wait with. A team's queue is its open tickets nobody works: anyone who works tickets takes one, member or not."
      >
        <RecordsSection
          shown={filtered.length}
          total={rows.length}
          actions={
            <Button size="sm" onClick={() => setCreating(true)} disabled={!access.create || !teams.ready || saving}>
              <Plus className="h-4 w-4" weight="bold" /> New team
            </Button>
          }
        >
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-10">Team</TableHead>
                {view.showDetails && <TableHead className="h-10">Members</TableHead>}
                <TableHead className="h-10">Status</TableHead>
                <TableHead className="h-10 w-12">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageRows.map((team) => (
                <TableRow key={team.id}>
                  <TableCell className="min-w-52 py-3 font-medium text-foreground">{team.name}</TableCell>
                  {view.showDetails && <TableCell className="min-w-64 text-muted-foreground">{team.facts.Members ?? "None"}</TableCell>}
                  <TableCell>
                    <Badge variant="outline" className={cn("whitespace-nowrap", statusClassName(team.status))}>
                      {team.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="w-12 text-right">
                    <TeamRowActions team={team} disabled={!access.edit || saving} onEdit={() => setEditing(team)} onStatus={(status) => setStatus(team, status)} />
                  </TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 && (
                <EmptyRow
                  colSpan={view.showDetails ? 4 : 3}
                  message={emptyMessage}
                  hint={teams.notGranted ? teams.problem?.detail : undefined}
                  narrowed={rows.length > 0}
                />
              )}
            </TableBody>
          </Table>
          <TablePagination page={page} pageCount={pageCount} totalCount={totalCount} onPageChange={setPage} />
        </RecordsSection>
      </AssetPanelShell>

      <BusinessRecordFormDialog schema={TICKET_TEAM_FORM} open={creating} onOpenChange={setCreating} onSubmit={handleCreate} relationOptions={relationOptions} />
      {editing && (
        <BusinessRecordFormDialog
          schema={TICKET_TEAM_EDIT_FORM}
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null)
          }}
          onSubmit={handleEdit}
          relationOptions={relationOptions}
          initialValueOverrides={{ ...editing.submittedValues }}
        />
      )}
    </>
  )
}

type UsersRolesTab = SettingsTabOf<"access">

/** The pane at the address's tab (the Settings table offers Teams on the Pilot alone). */
export function OrganizationAccessManagement({ params, onParamsChange }: SettingsPaneProps) {
  // The pane reads and writes the access module through the record store and nothing else (Issue #163).
  const { me } = useApiSession()
  const { getRecords, upsertRecord, sendCommand } = useBusinessRecordStore()
  const accessModuleState = useServerModuleState("configure", "access") ?? IDLE
  const activeTab = (params.tab as UsersRolesTab | undefined) ?? "users"
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null)
  // The Teams tab's rows, read here for the tab's count.
  const teams = useModuleRecords(TICKET_TEAMS_MODULE.workspaceId, TICKET_TEAMS_MODULE.moduleId)
  const teamRows: readonly BusinessRecord[] = useMemo(
    () => teams.records.filter((record) => isTicketTeamRecord(record) && !isSoftDeleted(record)),
    [teams.records],
  )

  const [userQuery, setUserQuery] = useState("")
  const [userStatuses, setUserStatuses] = useState<string[]>([])
  const [userOrganizations, setUserOrganizations] = useState<string[]>([])
  const [userView, setUserView] = useState<TableView>(defaultUserView)

  const [roleQuery, setRoleQuery] = useState("")
  const [roleTypes, setRoleTypes] = useState<string[]>([])
  const [roleScopes, setRoleScopes] = useState<string[]>([])
  const [roleView, setRoleView] = useState<TableView>(defaultRoleView)

  const [teamQuery, setTeamQuery] = useState("")
  const [teamStatuses, setTeamStatuses] = useState<string[]>([])
  const [teamView, setTeamView] = useState<TableView>(defaultTeamView)

  const [addUserOpen, setAddUserOpen] = useState(false)
  const [newRoleOpen, setNewRoleOpen] = useState(false)

  // The row a command is out for, and the row Deactivate asks about first;
  // the row stays named while its dialog animates shut.
  const [pendingCommandId, setPendingCommandId] = useState<string | null>(null)
  const [deactivating, setDeactivating] = useState<UserRow | null>(null)
  const [deactivateOpen, setDeactivateOpen] = useState(false)

  const accessRecords = getRecords(
    "configure",
    "access")
  // The pickers and the company's name: the organisation and the
  // service-provider modules, as the store loaded them, and `/me` for the
  // company until the organisation module is ready.
  const organisationRecords = getRecords("configure", "organization")
  const providerRecords = getRecords("service-providers", "service-providers")
  // The caller's company is `/me`'s; the organisation record lends only its web id.
  const companyName = me?.company.name ?? "Company"
  // The pickers, before the rows' memos: a call over these arrays after the
  // memos reads to the React Compiler as a possible mutation of a dependency,
  // and it would then skip the pane.
  const roleOptions = rolePickerOptions(accessRecords)
  // The API's roles: what a role's panel and New role's Start from read (#291).
  const pilotRoleRecords: readonly BusinessRecord[] = accessRecords.filter((record) => roleAdapter.owns(record))
  const projectOptions = projectPickerOptions(organisationRecords)
  const providerOptions = providerPickerOptions(providerRecords)

  const userRows = useMemo(() => userRowsOf(accessModuleState, companyName), [accessModuleState, companyName])
  const roleRows = useMemo(() => roleRowsOf(accessModuleState), [accessModuleState])
  const pilotUsersEmpty = pilotEmptyState(accessModuleState, "users")
  const pilotRolesEmpty = pilotEmptyState(accessModuleState, "roles")
  const pilotReady = accessModuleState.status === "ready"
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
  const normalizedTeamQuery = teamQuery.trim().toLowerCase()
  const filteredTeams = useMemo(() => {
    const matches = teamRows.filter(
      (team) =>
        (teamStatuses.length === 0 || teamStatuses.includes(team.status)) &&
        (normalizedTeamQuery === "" || [team.name, team.facts.Members ?? ""].join(" ").toLowerCase().includes(normalizedTeamQuery)),
    )
    return teamView.ordering === "name" ? [...matches].sort((a, b) => a.name.localeCompare(b.name)) : matches
  }, [normalizedTeamQuery, teamRows, teamStatuses, teamView])
  const teamsPagination = useTablePagination(filteredTeams)

  const roleUserCount = (roleName: string) =>
    userRows.filter((user) => user.role === roleName).length

  const tabCounts: Readonly<Record<UsersRolesTab, number>> = { users: userRows.length, roles: roleRows.length, teams: teamRows.length }
  const tabs = (
    <div className="flex items-center gap-1 overflow-x-auto pb-1">
      <Tabs
        value={activeTab}
        onValueChange={(next) => {
          onParamsChange({ tab: next })
          setSelectedRoleId(null)
        }}
      >
        <TabsList className="inline-flex h-8 bg-muted rounded-full px-1 py-0.5 text-xs border border-border/50">
          {settingsTabsOf("access").map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value} className="rounded-full px-3 whitespace-nowrap">
              {tab.label}
              <span className="ml-1.5 text-[10px] text-muted-foreground">
                {tabCounts[tab.value]}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  )

  return (
    <>
      {activeTab === "teams" ? (
        <TeamsPanel
          tabs={tabs}
          teams={teams}
          rows={teamRows}
          table={{
            query: teamQuery,
            onQueryChange: setTeamQuery,
            statuses: teamStatuses,
            onStatusesChange: setTeamStatuses,
            view: teamView,
            onViewChange: setTeamView,
            filtered: filteredTeams,
            pagination: teamsPagination,
          }}
        />
      ) : activeTab === "users" ? (
        <AssetPanelShell
          tabs={tabs}
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
          <RecordsSection
            shown={filteredUsers.length}
            total={userRows.length}
            actions={
              <Button
                size="sm"
                onClick={() => setAddUserOpen(true)}
                disabled={!pilotReady}
                title={pilotUsersEmpty?.message}
              >
                <Plus className="h-4 w-4" weight="bold" /> Add user
              </Button>
            }
          >
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-10">User</TableHead>
                  <TableHead className="h-10">Role</TableHead>
                  <TableHead className="h-10">Organization</TableHead>
                  <TableHead className="h-10">Project access</TableHead>
                  <TableHead className="h-10">Status</TableHead>
                  <TableHead className="h-10 w-12">
                    <span className="sr-only">Actions</span>
                  </TableHead>
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
                  </TableRow>
                ))}
                {filteredUsers.length === 0 && (
                  <EmptyRow
                    colSpan={6}
                    message={pilotUsersEmpty?.message ?? (userRows.length > 0 ? "No users match your search." : "No users yet.")}
                    hint={pilotUsersEmpty?.hint}
                    narrowed={userRows.length > 0}
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
        </AssetPanelShell>
      ) : selectedRoleId ? (
        // The access module's role, its matrix saved whole and a system role's read-only (#291).
        <PilotRolePermissionsPanel
          record={pilotRoleRecords.find((record) => record.id === selectedRoleId)}
          onBack={() => setSelectedRoleId(null)}
        />
      ) : (
        <AssetPanelShell
          tabs={tabs}
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
          <RecordsSection
            shown={filteredRoles.length}
            total={roleRows.length}
            actions={
              <Button
                size="sm"
                onClick={() => setNewRoleOpen(true)}
                disabled={!pilotReady}
                title={pilotRolesEmpty?.message}
              >
                <Plus className="h-4 w-4" weight="bold" /> New role
              </Button>
            }
          >
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
                  // A row opens its permissions, the API's (#291).
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
                    message={pilotRolesEmpty?.message ?? "No roles match your search."}
                    hint={pilotRolesEmpty?.hint}
                    narrowed={roleRows.length > 0}
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
        </AssetPanelShell>
      )}

      <InviteUserDialog
        open={addUserOpen}
        onOpenChange={setAddUserOpen}
        roles={roleOptions}
        projects={projectOptions}
        providers={providerOptions}
        // The dialog says a refusal itself, so the store's toast is off; and a record only goes out while the module is ready.
        invite={(record) =>
          accessModuleState.status === "ready" ? upsertRecord("configure", "access", record, { report: false }) : undefined
        }
      />

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

      <NewRoleDialog
        open={newRoleOpen}
        onOpenChange={setNewRoleOpen}
        scopes={roleScopeOptions}
        roles={pilotRoleRecords}
        // The dialog says a refusal itself, so the store's toast is off; a record only goes out while the module is ready.
        create={(record) =>
          accessModuleState.status === "ready" ? upsertRecord("configure", "access", record, { report: false }) : undefined
        }
        onCreated={setSelectedRoleId}
      />
    </>
  )
}
