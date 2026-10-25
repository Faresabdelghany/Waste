"use client"

// Settings › Commercial › Ticket charges (#291 C3): the product each ticket
// kind's work is charged at when a completion names none — what a completed
// re-collection or service is priced at on the next billing run. A project's
// set is read and replaced whole through the client (lib/api/ticket-charges.ts),
// since it is the project's configuration and no row of a workspace's table;
// the products are the products module's, offered as a completion's
// "Charged at" offers them (lib/data/ticket-charges.ts). On the Pilot alone:
// fixture mode keeps no charges, and says so.
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import type { TicketKind } from "@waste/domain/resolution/vocabulary"

import { AssetPanelShell, EmptyRow, RecordsSection } from "@/components/settings/asset-management-settings"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useApiClient, useApiConfigured } from "@/components/waste/api-session-store"
import { useModuleRecords, useServerResolver } from "@/components/waste/business-record-store"
import { problemSentence, type Problem } from "@/lib/api/problem"
import { isLocalRefusal } from "@/lib/api/records/adapter"
import { problemOfError } from "@/lib/api/records/server-records"
import { readTicketCharges, replaceTicketCharges } from "@/lib/api/ticket-charges"
import { getModuleDefinition } from "@/lib/data/business-modules"
import { PRODUCTS_MODULE } from "@/lib/data/commercial"
import { NO_ONE } from "@/lib/data/properties"
import { picksOf, TICKET_KIND_ROWS, ticketChargesBody, ticketWorkProductOptions, type TicketChargePicks } from "@/lib/data/ticket-charges"
import { isSoftDeleted } from "@waste/domain/record-visibility"

const ORGANISATION_FIXTURES = getModuleDefinition({ workspaceId: "configure", moduleId: "organization" })?.records ?? []

/** The picks stand by the server's ids: what the set reads and is written in. */
const asIs = (id: string) => id

/** A project's charges as read: the picks, or why they could not be. */
type Read = { projectId: string; picks: TicketChargePicks } | { projectId: string; problem: Problem }

export function TicketChargesSettings() {
  const configured = useApiConfigured()
  const client = useApiClient()
  const resolve = useServerResolver()
  const organisation = useModuleRecords("configure", "organization", ORGANISATION_FIXTURES)
  const products = useModuleRecords(PRODUCTS_MODULE.workspaceId, PRODUCTS_MODULE.moduleId, [])

  const projects = organisation.records.filter((record) => !isSoftDeleted(record) && record.id.startsWith("project-"))
  const [chosenProjectId, setChosenProjectId] = useState<string | null>(null)
  const project = projects.find((record) => record.id === chosenProjectId) ?? projects[0] ?? null
  const projectServerId = project === null ? undefined : resolve.serverIdOf(project.id)

  const [read, setRead] = useState<Read | null>(null)
  const [picks, setPicks] = useState<TicketChargePicks>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!configured || client === null || projectServerId === undefined) return
    let live = true
    readTicketCharges(client, projectServerId).then(
      (charges) => {
        if (!live) return
        const now = picksOf(charges, asIs)
        setRead({ projectId: projectServerId, picks: now })
        setPicks(now)
      },
      (error: unknown) => {
        if (live) setRead({ projectId: projectServerId, problem: problemOfError(error) })
      },
    )
    return () => {
      live = false
    }
  }, [configured, client, projectServerId])

  // The products a kind may be charged at, valued by the server's ids the set is written in.
  const options = useMemo(
    () => (project === null ? [] : ticketWorkProductOptions(products.records, project.id).map((option) => ({ ...option, value: resolve.serverIdOf(option.value) ?? option.value }))),
    [products.records, project, resolve],
  )
  const shown = read !== null && read.projectId === projectServerId ? read : null
  const saved = shown !== null && "picks" in shown ? shown.picks : null
  const changed = saved !== null && TICKET_KIND_ROWS.some(({ kind }) => (picks[kind] ?? NO_ONE) !== (saved[kind] ?? NO_ONE))

  const save = async () => {
    if (client === null || projectServerId === undefined || project === null) return
    const body = ticketChargesBody(projectServerId, picks, asIs)
    if (isLocalRefusal(body)) {
      toast.error("Ticket charges were not saved", { description: body.message })
      return
    }
    setSaving(true)
    try {
      const charges = await replaceTicketCharges(client, body)
      const now = picksOf(charges, asIs)
      setRead({ projectId: projectServerId, picks: now })
      setPicks(now)
      toast.success("Ticket charges saved", { description: `${charges.charges.length === 0 ? "No ticket kind is" : charges.charges.length === 1 ? "One ticket kind is" : `${charges.charges.length} ticket kinds are`} charged in ${project.name}.` })
    } catch (error) {
      toast.error("Ticket charges were not saved", { description: problemSentence(problemOfError(error)) })
    } finally {
      setSaving(false)
    }
  }

  const pick = (kind: TicketKind, value: string) => setPicks((current) => ({ ...current, [kind]: value }))

  const emptyMessage = !configured
    ? "Ticket charges are kept by the API: on the Pilot this pane sets the product each ticket kind is charged at."
    : project === null
      ? "No project to set charges for."
      : shown === null
        ? "Reading the ticket charges from the API…"
        : "problem" in shown
          ? `The ticket charges could not be read from the API: ${problemSentence(shown.problem)}`
          : undefined

  return (
    <AssetPanelShell
      heading="Commercial"
      title="Ticket charges"
      description="The product a completed re-collection or service of each ticket kind is charged at when its completion names none. A kind left at None waits for the office's product on the billable event."
      action={
        <Button size="sm" disabled={!changed || saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save charges"}
        </Button>
      }
      toolbar={
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="ticket-charges-project" className="text-sm text-muted-foreground">
            Project
          </Label>
          <Select value={project?.id ?? ""} onValueChange={setChosenProjectId} disabled={projects.length === 0 || saving}>
            <SelectTrigger id="ticket-charges-project" className="w-64">
              <SelectValue placeholder="Pick a project" />
            </SelectTrigger>
            <SelectContent>
              {projects.map((record) => (
                <SelectItem key={record.id} value={record.id}>
                  {record.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      }
    >
      <RecordsSection shown={TICKET_KIND_ROWS.length} total={TICKET_KIND_ROWS.length}>
        <div className="overflow-x-auto">
          <Table className="min-w-[640px]" data-testid="ticket-charges">
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Ticket kind</TableHead>
                <TableHead>Charged at</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {emptyMessage !== undefined ? (
                <EmptyRow colSpan={2} message={emptyMessage} hint="The products are the project's own, from Settings › Commercial › Products." />
              ) : (
                TICKET_KIND_ROWS.map(({ kind, label }) => (
                  <TableRow key={kind}>
                    <TableCell className="font-medium">{label}</TableCell>
                    <TableCell>
                      <Select value={picks[kind] ?? NO_ONE} onValueChange={(value) => pick(kind, value)} disabled={saving}>
                        <SelectTrigger aria-label={`${label} charged at`} className="w-80">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NO_ONE}>None: the office prices it</SelectItem>
                          {options.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                          {/* A charge at a product no option offers — one sold by the month since, or not loaded — is kept by its id, never dropped unseen. */}
                          {picks[kind] !== undefined && picks[kind] !== NO_ONE && !options.some((option) => option.value === picks[kind]) && (
                            <SelectItem value={picks[kind]!}>{resolve.byServerId(picks[kind]!)?.name ?? picks[kind]}</SelectItem>
                          )}
                        </SelectContent>
                      </Select>
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
