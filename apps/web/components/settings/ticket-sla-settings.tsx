"use client"

// Settings › Tickets › Deadlines (O4 of #290): one project's targets at a
// time — the hours a ticket of a priority has from opening to its due date,
// for every kind, one kind or one ticket type — read from and saved whole to the API's
// `/projects/:id/ticket-sla` under `configure.templates`. A ticket opened
// without a due date takes one from them; a ticket already open keeps its
// own. The rows and the body they become are lib/data/ticket-sla.ts's. Offered
// on the Pilot alone, in place of the fixtures' Tickets & communication.

import { useRef, type ReactNode } from "react"
import { FloppyDisk, Plus, Trash } from "@phosphor-icons/react/dist/ssr"

import type { TicketSla } from "@waste/contracts/ticket-sla"
import { useTicketTypeChoices } from "@/components/settings/use-ticket-type-choices"
import { AssetPanelShell, EmptyRow, RecordsSection } from "@/components/settings/settings-pane-kit"
import { ProjectPicker, useProjectSetting, type ProjectPick } from "@/components/settings/use-project-setting"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useApiSession } from "@/components/platform/api-session-store"
import { get, put } from "@/lib/api/client"
import { problemSentence } from "@/lib/api/problem"
import { accessUnknownSentence } from "@/lib/api/session"
import { typesListed } from "@/lib/data/ticket-scope"
import { isSlaRefusal, newSlaRow, SLA_PRIORITY_OPTIONS, slaAccessOf, slaBodyOf, slaRowsOf, slaSavedSentence, slaScopeOptions, typesNamedBy, type SlaRefusal, type SlaRow } from "@/lib/data/ticket-sla"
import { notShownSentence, readSentence } from "@/lib/api/read-state"

/** The pane, a tab of Settings › Tickets (#548 of #544): `tabs` is the page's tab strip, drawn in this pane's header, and the project is the page's, shared with the Default teams and Charges tabs. */
export function TicketSlaSettings({ tabs, pick }: { tabs?: ReactNode; pick: ProjectPick }) {
  const session = useApiSession()
  const access = slaAccessOf(session.me?.role.grants)
  const setting = useProjectSetting<TicketSla, SlaRow[], SlaRefusal>({ name: "ticket-sla", readable: access.view, read: (asking, projectId) => get<TicketSla>(asking, `/projects/${projectId}/ticket-sla`) }, pick)
  const { project, base, refusal, saving } = setting
  const editing = setting.draft !== null
  const rows = base === null ? [] : (setting.draft ?? slaRowsOf(base))
  // Every kind, each kind, and each type (#548 of #544): the active ones, and any the saved set names.
  const types = useTicketTypeChoices()
  const listedTypes = typesListed(types, base === null ? [] : typesNamedBy(base))
  const scopeOptions = slaScopeOptions(listedTypes)
  const rowsMax = scopeOptions.length * SLA_PRIORITY_OPTIONS.length
  const minted = useRef(0)

  const change = (next: SlaRow[]) => base !== null && setting.edit(next)
  const changeRow = (index: number, values: Partial<SlaRow>) => change(rows.map((row, at) => (at === index ? { ...row, ...values } : row)))
  const addRow = () => {
    minted.current += 1
    change([...rows, newSlaRow(rows, `new-${minted.current}`, listedTypes)])
  }

  const save = () => {
    if (project === null || base === null) return
    const body = slaBodyOf(rows)
    if (isSlaRefusal(body)) return setting.refuse(body)
    setting.save((client, projectId) => put<TicketSla>(client, `/projects/${projectId}/ticket-sla`, body), { saved: (sla) => ({ title: "SLA saved", description: slaSavedSentence(project.name, sla.targets.length) }), failed: "The SLA was not saved" }, (sla) => sla)
  }

  // Until `/me` answers, the grants are unknown: never said to be the role's.
  const emptyMessage = accessUnknownSentence(session) ?? (!access.view
    ? notShownSentence("ticket SLA", { is: true })
    : project === null
      ? "No project to set an SLA for."
      : (readSentence({ problem: setting.problem && problemSentence(setting.problem), answered: base !== null }, "SLA") ?? `${project.name} has no SLA: its tickets open without a due date unless someone gives one.`))

  return (
    <AssetPanelShell
      tabs={tabs}
      title="Ticket SLA"
      description="How long a ticket has from opening to its due date, by priority, for every kind, one kind or one ticket type."
      toolbar={
        <div className="flex flex-wrap items-center gap-2">
          <ProjectPicker id="ticket-sla-project" setting={setting} disabled={editing} />
          <Button variant="outline" size="sm" disabled={!access.edit || base === null || rows.length >= rowsMax} onClick={addRow}>
            <Plus className="h-4 w-4" weight="bold" />
            Add target
          </Button>
          {editing && <span className="text-xs text-muted-foreground">Save or discard the changes to pick another project.</span>}
        </div>
      }
    >
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
              Save SLA
            </Button>
          </>
        }
      >
        <div className="overflow-x-auto">
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Kind or type</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Due within</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <EmptyRow colSpan={4} message={emptyMessage} hint={access.edit && base !== null ? "Add a target for each priority your contract promises." : ""} />
              ) : (
                rows.map((row, index) => {
                  const refused = refusal?.index === index ? refusal : null
                  return (
                    <TableRow key={row.key} aria-label={`Target ${index + 1}`}>
                      <TableCell>
                        <Select value={row.kind} onValueChange={(kind) => changeRow(index, { kind })} disabled={!access.edit}>
                          <SelectTrigger className="w-80 max-w-full" aria-label="Kind or type" aria-invalid={refused?.field === "kind"}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {scopeOptions.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Select value={row.priority} onValueChange={(priority) => changeRow(index, { priority })} disabled={!access.edit}>
                          <SelectTrigger className="w-40" aria-label="Priority" aria-invalid={refused?.field === "kind"}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {SLA_PRIORITY_OPTIONS.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Input
                            className="h-9 w-24"
                            inputMode="numeric"
                            aria-label="Hours"
                            aria-invalid={refused?.field === "hours"}
                            value={row.hours}
                            disabled={!access.edit}
                            onChange={(event) => changeRow(index, { hours: event.target.value })}
                          />
                          <span className="text-sm text-muted-foreground">hours</span>
                        </div>
                        {refused !== null && <p className="mt-1 text-xs text-destructive">{refused.message}</p>}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          aria-label={`Remove target ${index + 1}`}
                          disabled={!access.edit}
                          onClick={() => change(rows.filter((_, at) => at !== index))}
                        >
                          <Trash className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </div>
      </RecordsSection>
    </AssetPanelShell>
  )
}
