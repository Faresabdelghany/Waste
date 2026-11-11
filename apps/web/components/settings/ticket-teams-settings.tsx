"use client"

// Settings › Tickets › Default teams (O30 of #290, row 7.20): one project's
// default team per kind and per ticket type, read from
// `/projects/:id/ticket-team-defaults`. Each row reads its team and is edited
// on its own (#606): the row's pencil opens the team's picker, and its save
// puts the project's set back with that one row moved. A ticket opened
// without a team takes its type's default, else its kind's; a ticket already
// open keeps its team. A type's row is the setting its own form edits
// (ticket-types-settings.tsx). The teams themselves are added, edited and
// retired on Settings › Users & roles' Teams tab. Offered on the Pilot alone.

import type { ReactNode } from "react"
import { PencilSimple } from "@phosphor-icons/react/dist/ssr"

import type { TicketTeamDefaults } from "@waste/contracts/ticket-teams"
import { useTicketTypeChoices } from "@/components/settings/use-ticket-type-choices"
import { AssetPanelShell, EmptyRow, RecordsSection } from "@/components/settings/settings-pane-kit"
import { ProjectPicker, useProjectSetting, type ProjectPick } from "@/components/settings/use-project-setting"
import { useTicketTeams } from "@/components/settings/use-ticket-teams"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useApiSession } from "@/components/platform/api-session-store"
import { problemSentence } from "@/lib/api/problem"
import { accessUnknownSentence } from "@/lib/api/session"
import { moveDefaultTeam, readTeamDefaults } from "@/lib/api/ticket-team-defaults"
import type { BusinessFormOption } from "@/lib/data/business-form-types"
import { DEFAULT_TEAM_NOT_SAVED, defaultTeamSaved, NO_TEAM, pickedTeamOf, teamChoicesOf, teamDefaultRowsOf, teamShownOf, ticketTeamsAccessOf, type TeamDefaultRow } from "@/lib/data/ticket-teams"
import { notShownSentence, readSentence } from "@/lib/api/read-state"
import { useGrants } from "@/components/platform/use-grants"

/** The row whose team is being picked, and the pick: held as the project's draft, so a save the API takes closes it and a refusal leaves it open. */
type TeamEdit = { row: TeamDefaultRow; teamId: string }

/**
 * The pane, a tab of Settings › Tickets (#548 of #544): `tabs` is the page's tab strip, drawn in this pane's header, and the project is the page's, shared with the Types, Deadlines and Charges tabs.
 * `onOpenTeams` opens Settings › Users & roles at its Teams tab, offered while the company has no active team to name.
 */
export function TicketDefaultTeamsSettings({ tabs, pick, onOpenTeams }: { tabs?: ReactNode; pick: ProjectPick; onOpenTeams?: () => void }) {
  const session = useApiSession()
  const access = ticketTeamsAccessOf(useGrants())
  const { teams, read: teamsRead, reading: teamsReading, serverIdOf, webIdOf } = useTicketTeams()
  // No team takes tickets yet: every row's picker offers no team alone, so the way to the teams is said here.
  const noActiveTeam = teamsRead && !teams.some((team) => team.status === "Active")

  const setting = useProjectSetting<TicketTeamDefaults, TeamEdit, string>({ name: "ticket-team-defaults", readable: access.view, read: readTeamDefaults }, pick)
  const { project, base, saving } = setting
  const editing = setting.draft
  const types = useTicketTypeChoices()
  const rows = base === null ? [] : teamDefaultRowsOf(base, webIdOf, types)

  const save = () => {
    if (project === null || editing === null) return
    const picked = pickedTeamOf(editing.teamId, serverIdOf)
    if ("message" in picked) return setting.refuse(picked.message)
    const { row } = editing
    const told = defaultTeamSaved(row.label, project.name, teamShownOf({ ...row, teamId: editing.teamId }, teams, teamsReading))
    setting.save((client, projectId) => moveDefaultTeam(client, projectId, row, picked.teamId), { saved: () => told, failed: DEFAULT_TEAM_NOT_SAVED }, (defaults) => defaults)
  }

  const emptyMessage =
    accessUnknownSentence(session) ??
    (!access.view
      ? notShownSentence("default teams")
      : project === null
        ? "No project to set default teams for."
        : readSentence({ problem: setting.problem && problemSentence(setting.problem), answered: false }, "default teams"))

  return (
    <AssetPanelShell
      tabs={tabs}
      title="Default teams"
      description="Each project's default team per kind and per ticket type: the team a ticket opened without one waits with."
      toolbar={
        <div className="flex flex-wrap items-center gap-2">
          <ProjectPicker id="ticket-team-defaults-project" setting={setting} />
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
      <RecordsSection shown={rows.length} total={rows.length}>
        <div className="overflow-x-auto">
          <Table className="min-w-[520px]">
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Kind or type</TableHead>
                <TableHead>Team</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <EmptyRow colSpan={3} message={emptyMessage} />
              ) : (
                rows.map((row) => (
                  <TableRow key={row.key} aria-label={row.label}>
                    <TableCell className="text-sm font-medium text-foreground">{row.label}</TableCell>
                    <TableCell className={row.teamId === NO_TEAM ? "text-sm text-muted-foreground" : "text-sm"}>{teamShownOf(row, teams, teamsReading)}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Edit team for ${row.label}`} disabled={!access.edit} onClick={() => setting.edit({ row, teamId: row.teamId })}>
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
      {editing !== null && (
        <DefaultTeamDialog
          edit={editing}
          choices={teamChoicesOf(editing.row.ticketTypeId !== null, teams, editing.row.teamId)}
          refusal={setting.refusal}
          saving={saving}
          onPick={(teamId) => setting.edit({ ...editing, teamId })}
          onSave={save}
          onClose={setting.discard}
        />
      )}
    </AssetPanelShell>
  )
}

/** One row's team, picked and saved on its own; held open while its save is out, and after a refusal. */
function DefaultTeamDialog({ edit, choices, refusal, saving, onPick, onSave, onClose }: { edit: TeamEdit; choices: readonly BusinessFormOption[]; refusal: string | null; saving: boolean; onPick: (teamId: string) => void; onSave: () => void; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Default team for {edit.row.label}</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            onSave()
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="default-team">Team</Label>
            <DefaultTeamSelect id="default-team" value={edit.teamId} choices={choices} onChange={onPick} disabled={saving} invalid={refusal !== null} />
            {refusal !== null && <p className="text-xs text-destructive">{refusal}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || edit.teamId === edit.row.teamId}>
              Save team
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** The picker a kind's or a type's default team is chosen with, over `teamChoicesOf`'s choices: the tab's dialog and a ticket type's page draw the same one. */
export function DefaultTeamSelect({ id, value, choices, onChange, disabled = false, invalid = false }: { id: string; value: string; choices: readonly BusinessFormOption[]; onChange: (teamId: string) => void; disabled?: boolean; invalid?: boolean }) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} aria-invalid={invalid}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {choices.map((choice) => (
          <SelectItem key={choice.value} value={choice.value}>
            {choice.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
