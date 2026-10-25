"use client"

// Settings › Commercial › Work order charges (M14 of #293): the product each
// of the office's work orders — a delivery, a removal, a swap, a repair, a
// wash — is charged at when the driver completes it, on the next billing run.
// A project's set is read and replaced whole through the client
// (lib/api/work-order-charges.ts), since it is the project's configuration
// and no row of a workspace's table; the products are the products module's
// sold by the job (lib/data/work-order-charges.ts). On the Pilot alone:
// fixture mode keeps no work order charges, and says so.
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import type { WorkOrderService } from "@waste/domain/execution/vocabulary"

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
import { readWorkOrderCharges, replaceWorkOrderCharges } from "@/lib/api/work-order-charges"
import { getModuleDefinition } from "@/lib/data/business-modules"
import { PRODUCTS_MODULE } from "@/lib/data/commercial"
import { NO_ONE } from "@/lib/data/properties"
import { jobProductOptions, WORK_ORDER_ROWS, workOrderPicksOf, workOrderChargesBody, type WorkOrderChargePicks } from "@/lib/data/work-order-charges"
import { isSoftDeleted } from "@waste/domain/record-visibility"

const ORGANISATION_FIXTURES = getModuleDefinition({ workspaceId: "configure", moduleId: "organization" })?.records ?? []

/** The picks stand by the server's ids: what the set reads and is written in. */
const asIs = (id: string) => id

/** A project's charges as read: the picks, or why they could not be. */
type Read = { projectId: string; picks: WorkOrderChargePicks } | { projectId: string; problem: Problem }

export function WorkOrderChargesSettings() {
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
  const [picks, setPicks] = useState<WorkOrderChargePicks>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!configured || client === null || projectServerId === undefined) return
    let live = true
    readWorkOrderCharges(client, projectServerId).then(
      (set) => {
        if (!live) return
        const now = workOrderPicksOf(set, asIs)
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

  // The products a work order may be charged at, valued by the server's ids the set is written in.
  const options = useMemo(
    () => (project === null ? [] : jobProductOptions(products.records, project.id).map((option) => ({ ...option, value: resolve.serverIdOf(option.value) ?? option.value }))),
    [products.records, project, resolve],
  )
  const shown = read !== null && read.projectId === projectServerId ? read : null
  const saved = shown !== null && "picks" in shown ? shown.picks : null
  const changed = saved !== null && WORK_ORDER_ROWS.some(({ service }) => (picks[service] ?? NO_ONE) !== (saved[service] ?? NO_ONE))

  const save = async () => {
    if (client === null || projectServerId === undefined || project === null) return
    const body = workOrderChargesBody(projectServerId, picks, asIs)
    if (isLocalRefusal(body)) {
      toast.error("Work order charges were not saved", { description: body.message })
      return
    }
    setSaving(true)
    try {
      const set = await replaceWorkOrderCharges(client, body)
      const now = workOrderPicksOf(set, asIs)
      setRead({ projectId: projectServerId, picks: now })
      setPicks(now)
      toast.success("Work order charges saved", { description: `${set.charges.length === 0 ? "No work order is" : set.charges.length === 1 ? "One work order is" : `${set.charges.length} work orders are`} charged in ${project.name}.` })
    } catch (error) {
      toast.error("Work order charges were not saved", { description: problemSentence(problemOfError(error)) })
    } finally {
      setSaving(false)
    }
  }

  const pick = (service: WorkOrderService, value: string) => setPicks((current) => ({ ...current, [service]: value }))

  const emptyMessage = !configured
    ? "Work order charges are kept by the API: on the Pilot this pane sets the product each work order is charged at."
    : project === null
      ? "No project to set charges for."
      : shown === null
        ? "Reading the work order charges from the API…"
        : "problem" in shown
          ? `The work order charges could not be read from the API: ${problemSentence(shown.problem)}`
          : undefined

  return (
    <AssetPanelShell
      heading="Commercial"
      title="Work order charges"
      description="The product a completed delivery, removal, swap, repair or wash is charged at on the next billing run. A work order left at None is charged nothing."
      action={
        <Button size="sm" disabled={!changed || saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save charges"}
        </Button>
      }
      toolbar={
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="work-order-charges-project" className="text-sm text-muted-foreground">
            Project
          </Label>
          <Select value={project?.id ?? ""} onValueChange={setChosenProjectId} disabled={projects.length === 0 || saving}>
            <SelectTrigger id="work-order-charges-project" className="w-64">
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
      <RecordsSection shown={WORK_ORDER_ROWS.length} total={WORK_ORDER_ROWS.length}>
        <div className="overflow-x-auto">
          <Table className="min-w-[640px]" data-testid="work-order-charges">
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Work order</TableHead>
                <TableHead>Charged at</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {emptyMessage !== undefined ? (
                <EmptyRow colSpan={2} message={emptyMessage} hint="The products are the project's own sold by the job, from Settings › Commercial › Products." />
              ) : (
                WORK_ORDER_ROWS.map(({ service, label }) => (
                  <TableRow key={service}>
                    <TableCell className="font-medium">{label}</TableCell>
                    <TableCell>
                      <Select value={picks[service] ?? NO_ONE} onValueChange={(value) => pick(service, value)} disabled={saving}>
                        <SelectTrigger aria-label={`${label} charged at`} className="w-80">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NO_ONE}>None: charged nothing</SelectItem>
                          {options.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                          {/* A product no option offers — one sold by another unit since, or not loaded — is kept by its id, never dropped unseen. */}
                          {picks[service] !== undefined && picks[service] !== NO_ONE && !options.some((option) => option.value === picks[service]) && (
                            <SelectItem value={picks[service]!}>{resolve.byServerId(picks[service]!)?.name ?? picks[service]}</SelectItem>
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
