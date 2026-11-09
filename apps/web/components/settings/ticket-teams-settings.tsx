"use client"

// Settings › Tickets › Default teams (O30 of #290, row 7.20): one project's
// default team per kind and per ticket type, read from and saved whole to
// `/projects/:id/ticket-team-defaults` as the Deadlines tab does its targets.
// A ticket opened without a team takes its type's default, else its kind's;
// a ticket already open keeps its team. The teams themselves are added,
// edited and retired on Settings › Users & roles' Teams tab; this tab reads
// them through the record store, which on the Pilot reaches `/teams` through
// lib/api/records/ticket-teams.ts. Offered on the Pilot alone.

import type { ReactNode } from "react"
import { FloppyDisk } from "@phosphor-icons/react/dist/ssr"

import type { TicketTeamDefaults } from "@waste/contracts/ticket-teams"
import { useTicketTypeChoices } from "@/components/settings/use-ticket-type-choices"
import { AssetPanelShell, EmptyRow, RecordsSection } from "@/components/settings/settings-pane-kit"
import { ProjectPicker, useProjectSetting, type ProjectPick } from "@/components/settings/use-project-setting"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useApiSession } from "@/components/platform/api-session-store"
import { useModuleRecords, useServerModuleState } from "@/components/platform/business-record-store"
import { get, put } from "@/lib/api/client"
import { problemSentence } from "@/lib/api/problem"
import { webIdOf } from "@/lib/records/fields"
import { isTicketTeamRecord } from "@/lib/api/records/ticket-teams"
import { accessUnknownSentence } from "@/lib/api/session"
import { NO_TEAM, teamDefaultRowsOf, teamDefaultsBodyOf, ticketTeamsAccessOf, TICKET_TEAM_PREFIX, TICKET_TEAMS_MODULE, type TeamDefaultRow } from "@/lib/data/ticket-teams"
import { isSoftDeleted } from "@/lib/prototype/record-visibility"

/**
 * The pane, a tab of Settings › Tickets (#548 of #544): `tabs` is the page's tab strip, drawn in this pane's header, and the project is the page's, shared with the Deadlines and Charges tabs.
 * `onOpenTeams` opens Settings › Users & roles at its Teams tab, offered while the company has no active team to name.
 */
export function TicketDefaultTeamsSettings({ tabs, pick, onOpenTeams }: { tabs?: ReactNode; pick: ProjectPick; onOpenTeams?: () => void }) {
  const session = useApiSession()
  const access = ticketTeamsAccessOf(session.me?.role.grants)
  const teamRecords = useModuleRecords(TICKET_TEAMS_MODULE.workspaceId, TICKET_TEAMS_MODULE.moduleId)
  const teamIds = useServerModuleState(TICKET_TEAMS_MODULE.workspaceId, TICKET_TEAMS_MODULE.moduleId)?.serverIds
  const teams = teamRecords.records.filter((record) => isTicketTeamRecord(record) && !isSoftDeleted(record))
  // No team takes tickets yet: each kind's picker offers "No team" alone, so the way to the teams is said here.
  const noActiveTeam = teamRecords.ready && !teams.some((team) => team.status === "Active")
  const serverIdOf = (webId: string) => teamIds?.get(webId)
  const webIdOfTeam = (serverId: string) => [...(teamIds ?? [])].find(([, id]) => id === serverId)?.[0] ?? webIdOf(TICKET_TEAM_PREFIX, serverId)

  const setting = useProjectSetting<TicketTeamDefaults, TeamDefaultRow[], { key: string; message: string }>(
    { name: "ticket-team-defaults", readable: access.view, read: (asking, projectId) => get<TicketTeamDefaults>(asking, `/projects/${projectId}/ticket-team-defaults`) },
    pick,
  )
  const { project, base, refusal: refused, saving } = setting
  const editing = setting.draft !== null
  const types = useTicketTypeChoices()
  const rows = base === null ? [] : (setting.draft ?? teamDefaultRowsOf(base, webIdOfTeam, types))
  // A team that takes tickets, and the one a kind already names whatever its status, so the row reads what is saved.
  const optionsFor = (row: TeamDefaultRow) => teams.filter((team) => team.status === "Active" || team.id === row.teamId)

  const change = (index: number, teamId: string) => base !== null && setting.edit(rows.map((row, at) => (at === index ? { ...row, teamId } : row)))

  const save = () => {
    if (project === null || base === null) return
    const body = teamDefaultsBodyOf(rows, serverIdOf)
    if ("message" in body) return setting.refuse(body)
    setting.save(
      (client, projectId) => put<TicketTeamDefaults>(client, `/projects/${projectId}/ticket-team-defaults`, body),
      { saved: () => ({ title: "Default teams saved", description: `Tickets opened in ${project.name} from now on go to these teams.` }), failed: "The default teams were not saved" },
      (defaults) => defaults,
    )
  }

  const emptyMessage =
    accessUnknownSentence(session) ??
    (!access.view
      ? "The default teams are not shown to your role."
      : project === null
        ? "No project to set default teams for."
        : setting.problem !== null
          ? `The default teams could not be read from the API: ${problemSentence(setting.problem)}`
          : "Reading the default teams from the API…")

  return (
    <AssetPanelShell
      tabs={tabs}
      title="Default teams"
      description="Each project's default team per kind and per ticket type: the team a ticket opened without one waits with."
      toolbar={
        <div className="flex flex-wrap items-center gap-2">
          <ProjectPicker id="ticket-team-defaults-project" setting={setting} disabled={editing} />
        </div>
      }
    >
      {noActiveTeam && (
        <div role="note" className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/40 px-4 py-3 text-sm">
          <span className="text-muted-foreground">The company has no active team yet.</span>
          {onOpenTeams !== undefined && (
            <Button variant="outline" size="sm" onClick={onOpenTeams}>
              Open Teams
            </Button>
          )}
        </div>
      )}
      <RecordsSection
        shown={rows.length}
        total={rows.length}
        actions={
          <>
            {editing && (
              <Button variant="outline" size="sm" disabled={saving} onClick={setting.discard}>
                Discard
              </Button>
            )}
            <Button size="sm" disabled={!access.edit || !editing || saving} onClick={save}>
              <FloppyDisk className="h-4 w-4" />
              Save defaults
            </Button>
          </>
        }
      >
        <div className="overflow-x-auto">
          <Table className="min-w-[520px]">
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Kind or type</TableHead>
                <TableHead>Team</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <EmptyRow colSpan={2} message={emptyMessage} />
              ) : (
                rows.map((row, index) => (
                  <TableRow key={row.key} aria-label={row.label}>
                    <TableCell className="text-sm">{row.label}</TableCell>
                    <TableCell>
                      <Select value={row.teamId} onValueChange={(teamId) => change(index, teamId)} disabled={!access.edit || saving}>
                        <SelectTrigger className="w-64" aria-label={`Team for ${row.label}`} aria-invalid={refused?.key === row.key}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NO_TEAM}>{row.ticketTypeId === null ? "No team" : "As its kind"}</SelectItem>
                          {optionsFor(row).map((team) => (
                            <SelectItem key={team.id} value={team.id}>
                              {team.status === "Active" ? team.name : `${team.name} · ${team.status}`}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {refused?.key === row.key && <p className="mt-1 text-xs text-destructive">{refused.message}</p>}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </RecordsSection>
    </AssetPanelShell>
  )
}
