"use client"

// Settings › Operations › Ticket SLA (O4 of #290): one project's targets at a
// time — the hours a ticket of a priority has from opening to its due date,
// for every kind or for one kind — read from and saved whole to the API's
// `/projects/:id/ticket-sla` under `configure.templates`. A ticket opened
// without a due date takes one from them; a ticket already open keeps its
// own. The rows and the body they become are lib/data/ticket-sla.ts's. Offered
// on the Pilot alone, in place of the fixtures' Tickets & communication.

import { useRef, useState } from "react"
import { FloppyDisk, Plus, Trash } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import type { TicketSla } from "@waste/contracts/ticket-sla"
import { useReport } from "@/components/insight/use-report"
import { AssetPanelShell, EmptyRow, RecordsSection } from "@/components/settings/asset-management-settings"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useApiClient, useApiSession } from "@/components/waste/api-session-store"
import { get, put } from "@/lib/api/client"
import { problemSentence } from "@/lib/api/problem"
import { problemOfError } from "@/lib/api/records/server-records"
import { isSlaRefusal, newSlaRow, SLA_KIND_OPTIONS, SLA_PRIORITY_OPTIONS, slaAccessOf, slaBodyOf, slaRowsOf, type SlaRefusal, type SlaRow } from "@/lib/data/ticket-sla"

const SLA_ROWS_MAX = SLA_KIND_OPTIONS.length * SLA_PRIORITY_OPTIONS.length

export function TicketSlaSettings() {
  const client = useApiClient()
  const { me } = useApiSession()
  const projects = me?.projects ?? []
  const access = slaAccessOf(me?.role.grants)
  const [chosenProjectId, setChosenProjectId] = useState<string | null>(null)
  const project = projects.find((candidate) => candidate.id === chosenProjectId) ?? projects[0] ?? null

  const read = useReport<TicketSla>(project === null || !access.view ? null : `ticket-sla:${project.id}`, (asking) => get<TicketSla>(asking, `/projects/${project?.id}/ticket-sla`))
  // The set the last save answered, which stands for the project's until the next read of another project.
  const [answered, setAnswered] = useState<TicketSla | null>(null)
  const base = answered !== null && answered.projectId === project?.id ? answered : read.report
  // The rows as edited, held to the set they were edited from: a new read or a save starts them again.
  const [edits, setEdits] = useState<{ base: TicketSla; rows: SlaRow[] } | null>(null)
  const editing = edits !== null && edits.base === base
  const rows = base === null ? [] : editing ? edits.rows : slaRowsOf(base)
  const [refusal, setRefusal] = useState<SlaRefusal | null>(null)
  const [saving, setSaving] = useState(false)
  const minted = useRef(0)

  const change = (next: SlaRow[]) => {
    if (base === null) return
    setEdits({ base, rows: next })
    setRefusal(null)
  }
  const changeRow = (index: number, values: Partial<SlaRow>) => change(rows.map((row, at) => (at === index ? { ...row, ...values } : row)))
  const addRow = () => {
    minted.current += 1
    change([...rows, newSlaRow(rows, `new-${minted.current}`)])
  }

  const save = () => {
    if (client === null || project === null || base === null) return
    const body = slaBodyOf(rows)
    if (isSlaRefusal(body)) {
      setRefusal(body)
      return
    }
    setSaving(true)
    put<TicketSla>(client, `/projects/${project.id}/ticket-sla`, body)
      .then(
        (sla) => {
          setAnswered(sla)
          setEdits(null)
          toast.success("SLA saved", { description: `${project.name} has ${sla.targets.length === 1 ? "one target" : `${sla.targets.length} targets`}. Tickets opened from now on are due by them.` })
        },
        (error: unknown) => toast.error("The SLA was not saved", { description: problemSentence(problemOfError(error)) }),
      )
      .finally(() => setSaving(false))
  }

  const emptyMessage = !access.view
    ? "The ticket SLA is not shown to your role."
    : project === null
      ? "No project to set an SLA for."
      : read.problem !== null
        ? `The SLA could not be read from the API: ${problemSentence(read.problem)}`
        : base === null
          ? "Reading the SLA from the API…"
          : `${project.name} has no SLA: its tickets open without a due date unless someone gives one.`

  return (
    <AssetPanelShell
      heading="Operations"
      title="Ticket SLA"
      description="How long a ticket has from opening to its due date, by priority, for every kind or for one kind."
      action={
        <div className="flex items-center gap-2">
          {editing && (
            <Button variant="outline" size="sm" disabled={saving} onClick={() => setEdits(null)}>
              Discard
            </Button>
          )}
          <Button size="sm" disabled={!access.edit || !editing || saving} onClick={save}>
            <FloppyDisk className="h-4 w-4" />
            Save SLA
          </Button>
        </div>
      }
      toolbar={
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="ticket-sla-project" className="text-sm text-muted-foreground">
            Project
          </Label>
          {/* Held while the rows are edited: another project's set would drop them unasked. */}
          <Select
            value={project?.id ?? ""}
            onValueChange={(id) => {
              setChosenProjectId(id)
              setAnswered(null)
              setRefusal(null)
            }}
            disabled={projects.length === 0 || editing}
          >
            <SelectTrigger id="ticket-sla-project" className="w-64">
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
          <Button variant="outline" size="sm" disabled={!access.edit || base === null || rows.length >= SLA_ROWS_MAX} onClick={addRow}>
            <Plus className="h-4 w-4" weight="bold" />
            Add target
          </Button>
          {editing && <span className="text-xs text-muted-foreground">Save or discard the changes to pick another project.</span>}
        </div>
      }
    >
      <p className="border-b border-border px-4 py-3 text-sm text-muted-foreground">
        A ticket opened without a due date is due this many hours after it opens: its kind&apos;s target at its priority, else the one for every kind. Tickets already open keep their due date.
      </p>
      <RecordsSection shown={rows.length} total={rows.length}>
        <div className="overflow-x-auto">
          <Table className="min-w-[640px]">
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Kind</TableHead>
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
                          <SelectTrigger className="w-56" aria-label="Kind" aria-invalid={refused?.field === "kind"}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {SLA_KIND_OPTIONS.map((option) => (
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
