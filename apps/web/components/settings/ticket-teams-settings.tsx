"use client"

// Settings › Operations › Ticket teams (O30 of #290, row 7.20): the company's
// teams a ticket waits with — added, renamed, retired and given their members
// through the record store, which on the Pilot reaches `/teams` through
// lib/api/records/ticket-teams.ts — and, beneath, one project's default team
// per kind, read from and saved whole to `/projects/:id/ticket-team-defaults`
// as the SLA's pane does its targets. A ticket opened without a team takes its
// kind's default; a ticket already open keeps its team. Offered on the Pilot
// alone, beside the Ticket SLA.

import { useState } from "react"
import { FloppyDisk, PencilSimple, Plus } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import type { TicketTeamDefaults } from "@waste/contracts/ticket-teams"
import { useReport } from "@/components/insight/use-report"
import { AssetPanelShell, EmptyRow, RecordsSection } from "@/components/settings/asset-management-settings"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useApiClient, useApiConfigured, useApiSession } from "@/components/waste/api-session-store"
import { BusinessRecordFormDialog } from "@/components/waste/business-record-form-dialog"
import { useBusinessRecordStore, useModuleRecords, useServerModuleState, whenSaved } from "@/components/waste/business-record-store"
import { get, put } from "@/lib/api/client"
import { problemSentence } from "@/lib/api/problem"
import { webIdOf } from "@/lib/api/records/adapter"
import { problemOfError } from "@/lib/api/records/server-records"
import { isTicketTeamRecord } from "@/lib/api/records/ticket-teams"
import type { BusinessFormField, BusinessFormOption, BusinessFormValues } from "@/lib/data/business-form-types"
import type { BusinessRecord } from "@/lib/data/business-modules"
import {
  createTicketTeamRecord,
  NO_TEAM,
  teamDefaultRowsOf,
  teamDefaultsBodyOf,
  ticketTeamsAccessOf,
  TICKET_TEAM_EDIT_FORM,
  TICKET_TEAM_FORM,
  TICKET_TEAM_PREFIX,
  TICKET_TEAMS_MODULE,
  updateTicketTeamRecord,
  type TeamDefaultRow,
} from "@/lib/data/ticket-teams"
import { ACCESS_MODULE } from "@/lib/data/tickets"
import { isSoftDeleted } from "@waste/domain/record-visibility"

const NO_RECORDS: readonly BusinessRecord[] = []

export function TicketTeamsSettings() {
  const client = useApiClient()
  const configured = useApiConfigured()
  const { me } = useApiSession()
  const access = ticketTeamsAccessOf(me?.role.grants)
  const { upsertRecord } = useBusinessRecordStore()
  const teams = useModuleRecords(TICKET_TEAMS_MODULE.workspaceId, TICKET_TEAMS_MODULE.moduleId, NO_RECORDS)
  const teamIds = useServerModuleState(TICKET_TEAMS_MODULE.workspaceId, TICKET_TEAMS_MODULE.moduleId)?.serverIds
  const users = useModuleRecords(ACCESS_MODULE.workspaceId, ACCESS_MODULE.moduleId, NO_RECORDS)
  const rows = teams.records.filter((record) => isTicketTeamRecord(record) && !isSoftDeleted(record))
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<BusinessRecord | null>(null)
  const [saving, setSaving] = useState(false)

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

  const emptyMessage = !configured
    ? "The ticket teams are kept on the API: sign in on the Pilot to read and write them."
    : teams.pending
      ? "Reading the teams from the API…"
      : teams.notGranted
        ? "The ticket teams are not shown to your role."
        : teams.problem
          ? `The teams could not be read from the API: ${teams.problem.detail ?? teams.problem.title}`
          : "No team yet. A ticket waits with a team once the company has one."

  return (
    <AssetPanelShell
      heading="Operations"
      title="Ticket teams"
      description="The teams the company's tickets wait with, and each project's default team per kind. A team's queue is its open tickets nobody works: anyone who works tickets takes one, member or not."
      toolbar={<p className="text-sm text-muted-foreground">A ticket&apos;s team is picked as it opens, or left to its kind&apos;s default below, and handed on from its details.</p>}
      action={
        <Button size="sm" disabled={!configured || !access.create || !teams.ready || saving} onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" weight="bold" />
          New team
        </Button>
      }
    >
      <RecordsSection shown={rows.length} total={rows.length}>
        <div className="overflow-x-auto">
          <Table className="min-w-[640px]">
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Team</TableHead>
                <TableHead>Members</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <EmptyRow colSpan={4} message={emptyMessage} hint={teams.notGranted ? teams.problem?.detail : undefined} />
              ) : (
                rows.map((record) => (
                  <TableRow key={record.id}>
                    <TableCell className="text-sm font-medium text-foreground">{record.name}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{record.facts.Members ?? "None"}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{record.status}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Edit ${record.name}`} disabled={!access.edit || saving} onClick={() => setEditing(record)}>
                        <PencilSimple className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </RecordsSection>

      <TeamDefaults
        teams={rows}
        serverIdOf={(webId) => teamIds?.get(webId)}
        webIdOf={(serverId) => [...(teamIds ?? [])].find(([, id]) => id === serverId)?.[0] ?? webIdOf(TICKET_TEAM_PREFIX, serverId)}
        canRead={configured && access.view}
        canEdit={access.edit}
        client={client}
        projects={me?.projects ?? []}
      />

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
    </AssetPanelShell>
  )
}

/** One project's default team per kind: every kind a row, a team or none, saved whole. */
function TeamDefaults({
  teams,
  serverIdOf,
  webIdOf,
  canRead,
  canEdit,
  client,
  projects,
}: {
  teams: readonly BusinessRecord[]
  serverIdOf: (webId: string) => string | undefined
  webIdOf: (serverId: string) => string
  canRead: boolean
  canEdit: boolean
  client: ReturnType<typeof useApiClient>
  projects: readonly { id: string; name: string }[]
}) {
  const [chosenProjectId, setChosenProjectId] = useState<string | null>(null)
  const project = projects.find((candidate) => candidate.id === chosenProjectId) ?? projects[0] ?? null
  const read = useReport<TicketTeamDefaults>(project === null || !canRead ? null : `ticket-team-defaults:${project.id}`, (asking) => get<TicketTeamDefaults>(asking, `/projects/${project?.id}/ticket-team-defaults`))
  // The set the last save answered, which stands for the project's until the next read of another project.
  const [answered, setAnswered] = useState<TicketTeamDefaults | null>(null)
  const base = answered !== null && answered.projectId === project?.id ? answered : read.report
  const [edits, setEdits] = useState<{ base: TicketTeamDefaults; rows: TeamDefaultRow[] } | null>(null)
  const editing = edits !== null && edits.base === base
  const rows = base === null ? [] : editing ? edits.rows : teamDefaultRowsOf(base, webIdOf)
  const [refused, setRefused] = useState<{ kind: string; message: string } | null>(null)
  const [saving, setSaving] = useState(false)
  // A team that takes tickets, and the one a kind already names whatever its status, so the row reads what is saved.
  const optionsFor = (row: TeamDefaultRow) => teams.filter((team) => team.status === "Active" || team.id === row.teamId)

  const change = (index: number, teamId: string) => {
    if (base === null) return
    setEdits({ base, rows: rows.map((row, at) => (at === index ? { ...row, teamId } : row)) })
    setRefused(null)
  }

  const save = () => {
    if (client === null || project === null || base === null) return
    const body = teamDefaultsBodyOf(rows, serverIdOf)
    if ("message" in body) {
      setRefused(body)
      return
    }
    setSaving(true)
    put<TicketTeamDefaults>(client, `/projects/${project.id}/ticket-team-defaults`, body)
      .then(
        (defaults) => {
          setAnswered(defaults)
          setEdits(null)
          toast.success("Default teams saved", { description: `Tickets opened in ${project.name} from now on go to these teams.` })
        },
        (error: unknown) => toast.error("The default teams were not saved", { description: problemSentence(problemOfError(error)) }),
      )
      .finally(() => setSaving(false))
  }

  const emptyMessage = !canRead
    ? "The default teams are not shown to your role."
    : project === null
      ? "No project to set default teams for."
      : read.problem !== null
        ? `The default teams could not be read from the API: ${problemSentence(read.problem)}`
        : "Reading the default teams from the API…"

  return (
    <section className="border-t border-border">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">Default team per kind</h3>
          <Label htmlFor="ticket-team-defaults-project" className="sr-only">
            Project
          </Label>
          {/* Held while the rows are edited: another project's set would drop them unasked. */}
          <Select
            value={project?.id ?? ""}
            onValueChange={(id) => {
              setChosenProjectId(id)
              setAnswered(null)
              setRefused(null)
            }}
            disabled={projects.length === 0 || editing}
          >
            <SelectTrigger id="ticket-team-defaults-project" className="w-64">
              <SelectValue placeholder="Pick a project" />
            </SelectTrigger>
            <SelectContent>
              {projects.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          {editing && (
            <Button variant="outline" size="sm" disabled={saving} onClick={() => setEdits(null)}>
              Discard
            </Button>
          )}
          <Button size="sm" disabled={!canEdit || !editing || saving} onClick={save}>
            <FloppyDisk className="h-4 w-4" />
            Save defaults
          </Button>
        </div>
      </div>
      <p className="px-4 pb-3 text-sm text-muted-foreground">A ticket opened without a team goes to its kind&apos;s team here. A retired team gives a new ticket none; tickets already open keep their team.</p>
      <Table className="min-w-[520px]">
        <TableHeader>
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableHead>Kind</TableHead>
            <TableHead>Team</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <EmptyRow colSpan={2} message={emptyMessage} />
          ) : (
            rows.map((row, index) => (
              <TableRow key={row.kind} aria-label={row.label}>
                <TableCell className="text-sm">{row.label}</TableCell>
                <TableCell>
                  <Select value={row.teamId} onValueChange={(teamId) => change(index, teamId)} disabled={!canEdit || saving}>
                    <SelectTrigger className="w-64" aria-label={`Team for ${row.label}`} aria-invalid={refused?.kind === row.kind}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_TEAM}>No team</SelectItem>
                      {optionsFor(row).map((team) => (
                        <SelectItem key={team.id} value={team.id}>
                          {team.status === "Active" ? team.name : `${team.name} · ${team.status}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {refused?.kind === row.kind && <p className="mt-1 text-xs text-destructive">{refused.message}</p>}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </section>
  )
}
