"use client"

// Settings › Commercial › Ticket charges (#291 C3): the product each ticket
// kind's work is charged at when a completion names none — what a completed
// re-collection or service is priced at on the next billing run. A project's
// set is read and replaced whole through the client (lib/api/ticket-charges.ts),
// since it is the project's configuration and no row of a workspace's table;
// the products are the products module's, offered as a completion's
// "Charged at" offers them (lib/data/ticket-charges.ts). On the Pilot alone:
// fixture mode keeps no charges.
import { useMemo, type ReactNode } from "react"
import { toast } from "sonner"

import type { TicketCharges } from "@waste/contracts/tickets"
import { useTicketTypeChoices } from "@/components/settings/use-ticket-type-choices"
import { AssetPanelShell, EmptyRow, RecordsSection } from "@/components/settings/asset-management-settings"
import { ProjectPicker, useProjectSetting, type ProjectPick } from "@/components/settings/use-project-setting"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useApiSession } from "@/components/waste/api-session-store"
import { useModuleRecords, useServerResolver } from "@/components/waste/business-record-store"
import { problemSentence } from "@/lib/api/problem"
import { isLocalRefusal } from "@/lib/api/records/adapter"
import { accessUnknownSentence } from "@/lib/api/session"
import { readTicketCharges, replaceTicketCharges } from "@/lib/api/ticket-charges"
import { PRODUCTS_MODULE } from "@/lib/data/commercial"
import { NO_ONE } from "@/lib/data/properties"
import { chargeRowsOf, picksOf, ticketChargesBody, ticketWorkProductOptions, typesPicked, type TicketChargePicks } from "@/lib/data/ticket-charges"

/** The picks stand by the server's ids: what the set reads and is written in. */
const asIs = (id: string) => id

/** The pane, a tab of Settings › Tickets (#548 of #544): `tabs` is the page's tab strip, drawn in this pane's header, and the project is the page's, shared with the Deadlines and Default teams tabs. */
export function TicketChargesSettings({ tabs, pick: shared }: { tabs?: ReactNode; pick: ProjectPick }) {
  const resolve = useServerResolver()
  const products = useModuleRecords(PRODUCTS_MODULE.workspaceId, PRODUCTS_MODULE.moduleId, [])
  const session = useApiSession()
  const setting = useProjectSetting<TicketCharges, TicketChargePicks>({ name: "ticket-charges", readable: true, read: readTicketCharges }, shared)
  const { project, base, saving } = setting
  // A product names its projects by the web's ids.
  const projectWebId = project === null ? undefined : resolve.byServerId(project.id)?.id

  // The products a kind may be charged at, valued by the server's ids the set is written in.
  const options = useMemo(
    () => (projectWebId === undefined ? [] : ticketWorkProductOptions(products.records, projectWebId).map((option) => ({ ...option, value: resolve.serverIdOf(option.value) ?? option.value }))),
    [products.records, projectWebId, resolve],
  )
  const saved = useMemo(() => (base === null ? null : picksOf(base, asIs)), [base])
  const picks = setting.draft ?? saved ?? {}
  // Every kind, then each type (#548 of #544): the active ones, and any the saved set names.
  const types = useTicketTypeChoices()
  const rows = useMemo(() => chargeRowsOf(types, typesPicked(saved ?? {})), [types, saved])
  const changed = saved !== null && rows.some(({ key }) => (picks[key] ?? NO_ONE) !== (saved[key] ?? NO_ONE))

  const save = () => {
    if (project === null) return
    const body = ticketChargesBody(project.id, picks, asIs, rows)
    if (isLocalRefusal(body)) {
      toast.error("Ticket charges were not saved", { description: body.message })
      return
    }
    setting.save(
      (client) => replaceTicketCharges(client, body),
      {
        saved: (charges) => ({ title: "Ticket charges saved", description: `${charges.charges.length === 0 ? "No ticket kind or type is" : charges.charges.length === 1 ? "One ticket kind or type is" : `${charges.charges.length} ticket kinds and types are`} charged in ${project.name}.` }),
        failed: "Ticket charges were not saved",
      },
      (charges) => charges,
    )
  }

  const pick = (key: string, value: string) => setting.edit({ ...picks, [key]: value })

  const emptyMessage =
    accessUnknownSentence(session) ??
    (project === null
      ? "No project to set charges for."
      : setting.problem !== null
        ? `The ticket charges could not be read from the API: ${problemSentence(setting.problem)}`
        : base === null
          ? "Reading the ticket charges from the API…"
          : undefined)

  return (
    <AssetPanelShell
      tabs={tabs}
      title="Ticket charges"
      description="The product a completed re-collection or service of each ticket kind or type is charged at when its completion names none, a type's own winning over its kind's. A kind left at None waits for the office's product on the billable event; a type left as its kind is charged at its kind's."
      toolbar={
        <div className="flex flex-wrap items-center gap-2">
          <ProjectPicker id="ticket-charges-project" setting={setting} disabled={saving} />
        </div>
      }
    >
      <RecordsSection
        shown={rows.length}
        total={rows.length}
        actions={
          <Button size="sm" disabled={!changed || saving} onClick={save}>
            {saving ? "Saving…" : "Save charges"}
          </Button>
        }
      >
        <div className="overflow-x-auto">
          <Table className="min-w-[640px]" data-testid="ticket-charges">
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Ticket kind or type</TableHead>
                <TableHead>Charged at</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {emptyMessage !== undefined ? (
                <EmptyRow colSpan={2} message={emptyMessage} hint="The products are the project's own, from Settings › Commercial › Products." />
              ) : (
                rows.map(({ key, label, ticketTypeId }) => (
                  <TableRow key={key}>
                    <TableCell className="font-medium">{label}</TableCell>
                    <TableCell>
                      <Select value={picks[key] ?? NO_ONE} onValueChange={(value) => pick(key, value)} disabled={saving}>
                        <SelectTrigger aria-label={`${label} charged at`} className="w-80">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NO_ONE}>{ticketTypeId === null ? "None: the office prices it" : "As its kind"}</SelectItem>
                          {options.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                          {/* A charge at a product no option offers — one sold by the month since, or not loaded — is kept by its id, never dropped unseen. */}
                          {picks[key] !== undefined && picks[key] !== NO_ONE && !options.some((option) => option.value === picks[key]) && (
                            <SelectItem value={picks[key]!}>{resolve.byServerId(picks[key]!)?.name ?? picks[key]}</SelectItem>
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
