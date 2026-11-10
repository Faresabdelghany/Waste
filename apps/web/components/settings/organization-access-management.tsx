"use client"

import { useMemo, useState, type ReactNode } from "react"
import {
  DotsThree,
  Plus,
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
import { Tabs } from "@/components/ui/tabs"
import { PillTab, PillTabsList } from "@/components/page-layout"
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
import { type BusinessOrderingOption, type BusinessViewOptions } from "@/components/platform/business-view-options-popover"
import { emptyBusinessFilters, matchesBusinessFilters, singleFilterValue, type BusinessFilters, type FilterValueReaders } from "@/lib/prototype/business-filters"
import { cn } from "@/lib/utils"
import { moduleReadSentence } from "@/lib/api/read-state"
import { useGrants } from "@/components/platform/use-grants"
import { densityClass, detailsColumn, listView, RecordToolbar } from "@/components/platform/record-toolbar"

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

const defaultUserView = listView("name")
const defaultRoleView = listView("default")
const defaultTeamView = listView("default")

const TEAM_READERS: FilterValueReaders = { statuses: (record) => singleFilterValue(record.status) }

const shownIn = (records: readonly BusinessRecord[], filters: BusinessFilters, readers: FilterValueReaders, id: string): boolean => {
  const record = records.find((candidate) => candidate.id === id)
  return record === undefined || matchesBusinessFilters(record, filters, readers)
}


const USER_ORDERS: readonly BusinessOrderingOption[] = [
  { value: "name", label: "Name" },
  { value: "role", label: "Role" },
]
const LIST_ORDERS: readonly BusinessOrderingOption[] = [
  { value: "default", label: "Default order" },
  { value: "name", label: "Name" },
]

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
  filters: BusinessFilters
  onFiltersChange: (filters: BusinessFilters) => void
  view: BusinessViewOptions
  onViewChange: (view: BusinessViewOptions) => void
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
  const { query, onQueryChange: setQuery, filters, onFiltersChange: setFilters, view, onViewChange: setView, filtered } = table
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
          <RecordToolbar
            placeholder="Search teams"
            query={query}
            onQueryChange={setQuery}
            records={rows}
            readers={TEAM_READERS}
            filters={filters}
            onFiltersChange={setFilters}
            view={{
              value: view,
              onChange: setView,
              orderingOptions: LIST_ORDERS,
              defaults: defaultTeamView,
              builtinColumnChips: detailsColumn("Members"),
            }}
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
          <Table className={densityClass(view)}>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-10">Team</TableHead>
                {view.showDescription && <TableHead className="h-10">Members</TableHead>}
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
                  {view.showDescription && <TableCell className="min-w-64 text-muted-foreground">{team.facts.Members ?? "None"}</TableCell>}
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
                  colSpan={view.showDescription ? 4 : 3}
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
  const [userFilters, setUserFilters] = useState<BusinessFilters>(emptyBusinessFilters)
  const [userView, setUserView] = useState<BusinessViewOptions>(defaultUserView)

  const [roleQuery, setRoleQuery] = useState("")
  const [roleFilters, setRoleFilters] = useState<BusinessFilters>(emptyBusinessFilters)
  const [roleView, setRoleView] = useState<BusinessViewOptions>(defaultRoleView)

  const [teamQuery, setTeamQuery] = useState("")
  const [teamFilters, setTeamFilters] = useState<BusinessFilters>(emptyBusinessFilters)
  const [teamView, setTeamView] = useState<BusinessViewOptions>(defaultTeamView)

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

  const userById = useMemo(() => new Map(userRows.map((user) => [user.id, user])), [userRows])
  const roleById = useMemo(() => new Map(roleRows.map((roleDefinition) => [roleDefinition.id, roleDefinition])), [roleRows])
  const userRecords = useMemo(() => accessRecords.filter((record) => userById.has(record.id)), [accessRecords, userById])
  const roleRecords = useMemo(() => accessRecords.filter((record) => roleById.has(record.id)), [accessRecords, roleById])
  const userReaders = useMemo<FilterValueReaders>(
    () => ({
      statuses: (record) => singleFilterValue(userById.get(record.id)?.status),
      organizations: (record) => singleFilterValue(userById.get(record.id)?.organization),
    }),
    [userById],
  )
  const roleReaders = useMemo<FilterValueReaders>(
    () => ({
      types: (record) => singleFilterValue(roleById.get(record.id)?.type),
      scopes: (record) => singleFilterValue(roleById.get(record.id)?.scope),
    }),
    [roleById],
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
      if (!shownIn(userRecords, userFilters, userReaders, user.id)) return false
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
  }, [normalizedUserQuery, userFilters, userRecords, userReaders, userRows, userView])

  const normalizedRoleQuery = roleQuery.trim().toLowerCase()
  const filteredRoles = useMemo(() => {
    const matches = roleRows.filter((roleDefinition) => {
      if (!shownIn(roleRecords, roleFilters, roleReaders, roleDefinition.id)) return false
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
  }, [normalizedRoleQuery, roleFilters, roleReaders, roleRecords, roleRows, roleView])

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
        matchesBusinessFilters(team, teamFilters, TEAM_READERS) &&
        (normalizedTeamQuery === "" || [team.name, team.facts.Members ?? ""].join(" ").toLowerCase().includes(normalizedTeamQuery)),
    )
    return teamView.ordering === "name" ? [...matches].sort((a, b) => a.name.localeCompare(b.name)) : matches
  }, [normalizedTeamQuery, teamRows, teamFilters, teamView])
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
        <PillTabsList>
          {settingsTabsOf("access").map((tab) => (
            <PillTab key={tab.value} value={tab.value} nav>
              {tab.label}
              <span className="ml-1.5 text-[10px] text-muted-foreground">
                {tabCounts[tab.value]}
              </span>
            </PillTab>
          ))}
        </PillTabsList>
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
            filters: teamFilters,
            onFiltersChange: setTeamFilters,
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
            <RecordToolbar
              placeholder="Search users"
              query={userQuery}
              onQueryChange={setUserQuery}
              records={userRecords}
              readers={userReaders}
              filters={userFilters}
              onFiltersChange={setUserFilters}
              view={{
                value: userView,
                onChange: setUserView,
                orderingOptions: USER_ORDERS,
                defaults: defaultUserView,
                builtinColumnChips: detailsColumn("Emails"),
              }}
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
            <Table className={densityClass(userView)}>
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
                      {userView.showDescription && (
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
            <RecordToolbar
              placeholder="Search roles"
              query={roleQuery}
              onQueryChange={setRoleQuery}
              records={roleRecords}
              readers={roleReaders}
              filters={roleFilters}
              onFiltersChange={setRoleFilters}
              view={{
                value: roleView,
                onChange: setRoleView,
                orderingOptions: LIST_ORDERS,
                defaults: defaultRoleView,
                builtinColumnChips: detailsColumn("Access summary"),
              }}
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
            <Table className={densityClass(roleView)}>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-10">Role</TableHead>
                  <TableHead className="h-10">Type</TableHead>
                  <TableHead className="h-10">Users</TableHead>
                  <TableHead className="h-10">Scope</TableHead>
                  {roleView.showDescription && (
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
                    {roleView.showDescription && (
                      <TableCell className="min-w-64 text-muted-foreground">
                        {roleDefinition.permissions}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
                {filteredRoles.length === 0 && (
                  <EmptyRow
                    colSpan={roleView.showDescription ? 5 : 4}
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
