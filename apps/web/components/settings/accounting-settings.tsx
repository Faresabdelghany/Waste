"use client"

// Settings › Commercial › Accounting (#291 C7w): a project's mapping onto the
// office's chart of accounts, which its accounting exports book to — the
// accounts with their numbers in Erhvervsstyrelsen's standard chart, the four
// defaults, the first day exports book, a code per VAT rate and the account
// its VAT goes to, and a product's own revenue account. Read and replaced
// whole through the client (lib/api/records/accounting.ts), since it is the
// project's configuration and no row of a workspace's table; what is typed is
// judged first by lib/data/accounting-settings.ts. On the Pilot alone: fixture
// mode keeps no mapping, and says so.
import { useEffect, useMemo, useState } from "react"
import { Plus, Trash } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import { AssetPanelShell, EmptyRow, RecordsSection } from "@/components/settings/asset-management-settings"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useApiClient, useApiConfigured } from "@/components/waste/api-session-store"
import { useModuleRecords, useServerResolver } from "@/components/waste/business-record-store"
import { problemSentence, type Problem } from "@/lib/api/problem"
import { isLocalRefusal } from "@/lib/api/records/adapter"
import { readAccountingSettings, replaceAccountingSettings } from "@/lib/api/records/accounting"
import { problemOfError } from "@/lib/api/records/server-records"
import { ACCOUNTING_DEFAULTS, accountingSettingsBody, draftOf, type AccountingDraft } from "@/lib/data/accounting-settings"
import { getModuleDefinition } from "@/lib/data/business-modules"
import { PRODUCTS_MODULE } from "@/lib/data/commercial"
import { NO_ONE } from "@/lib/data/properties"
import { isSoftDeleted } from "@waste/domain/record-visibility"

const ORGANISATION_FIXTURES = getModuleDefinition({ workspaceId: "configure", moduleId: "organization" })?.records ?? []

/** A project's mapping as read: the draft it started from, or why it could not be read. */
type Read = { projectId: string; draft: AccountingDraft } | { projectId: string; problem: Problem }

export function AccountingSettingsPane() {
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
  const [draft, setDraft] = useState<AccountingDraft | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!configured || client === null || projectServerId === undefined) return
    let live = true
    readAccountingSettings(client, projectServerId).then(
      (settings) => {
        if (!live) return
        const now = draftOf(settings)
        setRead({ projectId: projectServerId, draft: now })
        setDraft(now)
      },
      (error: unknown) => {
        if (live) setRead({ projectId: projectServerId, problem: problemOfError(error) })
      },
    )
    return () => {
      live = false
    }
  }, [configured, client, projectServerId])

  // The project's products, valued by the server's ids the mapping names them by.
  const productOptions = useMemo(
    () =>
      project === null
        ? []
        : products.records
            .filter((record) => !isSoftDeleted(record) && (record.projectIds ?? []).includes(project.id))
            .flatMap((record) => {
              const serverId = resolve.serverIdOf(record.id)
              return serverId === undefined ? [] : [{ value: serverId, label: record.name }]
            }),
    [products.records, project, resolve],
  )

  const shown = read !== null && read.projectId === projectServerId ? read : null
  const saved = shown !== null && "draft" in shown ? shown.draft : null
  const changed = saved !== null && draft !== null && JSON.stringify(saved) !== JSON.stringify(draft)
  const numbers = (draft?.accounts ?? []).map((account) => account.number.trim()).filter((number) => number !== "")

  const save = async () => {
    if (client === null || projectServerId === undefined || project === null || draft === null) return
    const body = accountingSettingsBody(projectServerId, draft)
    if (isLocalRefusal(body)) {
      toast.error("The mapping was not saved", { description: body.message })
      return
    }
    setSaving(true)
    try {
      const settings = await replaceAccountingSettings(client, body)
      const now = draftOf(settings)
      setRead({ projectId: projectServerId, draft: now })
      setDraft(now)
      toast.success("Accounting mapping saved", { description: `${settings.accounts.length === 1 ? "One account" : `${settings.accounts.length} accounts`} mapped for ${project.name}.` })
    } catch (error) {
      toast.error("The mapping was not saved", { description: problemSentence(problemOfError(error)) })
    } finally {
      setSaving(false)
    }
  }

  const edit = (change: (current: AccountingDraft) => AccountingDraft) => setDraft((current) => (current === null ? current : change(current)))

  const emptyMessage = !configured
    ? "The accounting mapping is kept by the API: on the Pilot this pane maps a project's invoices and payments onto the office's chart."
    : project === null
      ? "No project to map."
      : shown === null || draft === null
        ? "Reading the mapping from the API…"
        : "problem" in shown
          ? `The mapping could not be read from the API: ${problemSentence(shown.problem)}`
          : undefined

  const accountSelect = (value: string, onChange: (value: string) => void, label: string, none: string) => (
    <Select value={value === "" ? NO_ONE : value} onValueChange={onChange} disabled={saving}>
      <SelectTrigger aria-label={label} className="w-64">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_ONE}>{none}</SelectItem>
        {numbers.map((number) => (
          <SelectItem key={number} value={number}>
            {number} · {draft?.accounts.find((account) => account.number.trim() === number)?.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  return (
    <AssetPanelShell
      heading="Commercial"
      title="Accounting"
      description="The office's chart of accounts a project's accounting exports book to: each invoice and credit note to receivables, revenue and VAT, each payment to the bank and receivables. Each account carries its number in Erhvervsstyrelsen's standard chart, which a SAF-T file maps it to."
      action={
        <Button size="sm" disabled={!changed || saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save mapping"}
        </Button>
      }
      toolbar={
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="accounting-project" className="text-sm text-muted-foreground">
            Project
          </Label>
          <Select value={project?.id ?? ""} onValueChange={setChosenProjectId} disabled={projects.length === 0 || saving}>
            <SelectTrigger id="accounting-project" className="w-64">
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
      {emptyMessage !== undefined || draft === null ? (
        <RecordsSection shown={0} total={0}>
          <Table>
            <TableBody>
              <EmptyRow colSpan={1} message={emptyMessage ?? ""} hint="The accounts are the office's own, as its bookkeeping system names them." />
            </TableBody>
          </Table>
        </RecordsSection>
      ) : (
        <div className="space-y-6" data-testid="accounting-mapping">
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Accounts</h3>
              <Button size="sm" variant="outline" disabled={saving} onClick={() => edit((current) => ({ ...current, accounts: [...current.accounts, { number: "", name: "", standardAccount: "" }] }))}>
                <Plus className="size-4" /> Add account
              </Button>
            </div>
            <Table data-testid="accounting-accounts">
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead>Number</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Standard chart</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {draft.accounts.length === 0 ? (
                  <EmptyRow colSpan={4} message="No accounts yet." hint="Add the receivables, bank, unmatched payments, revenue and VAT accounts the exports book to." />
                ) : (
                  draft.accounts.map((account, index) => (
                    <TableRow key={index}>
                      {(["number", "name", "standardAccount"] as const).map((field) => (
                        <TableCell key={field}>
                          <Input
                            aria-label={`Account ${index + 1} ${field === "standardAccount" ? "standard chart" : field}`}
                            value={account[field]}
                            disabled={saving}
                            onChange={(event) => {
                              const value = event.target.value
                              edit((current) => ({ ...current, accounts: current.accounts.map((row, at) => (at === index ? { ...row, [field]: value } : row)) }))
                            }}
                          />
                        </TableCell>
                      ))}
                      <TableCell>
                        <Button size="icon" variant="ghost" aria-label={`Remove account ${index + 1}`} disabled={saving} onClick={() => edit((current) => ({ ...current, accounts: current.accounts.filter((_, at) => at !== index) }))}>
                          <Trash className="size-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Defaults</h3>
            <dl className="grid gap-3 sm:grid-cols-2">
              {ACCOUNTING_DEFAULTS.map(({ key, label, hint }) => (
                <div key={key} className="space-y-1">
                  <dt className="text-sm">{label}</dt>
                  <dd className="space-y-1">
                    {accountSelect(draft.defaults[key], (value) => edit((current) => ({ ...current, defaults: { ...current.defaults, [key]: value } })), label, "None")}
                    <p className="text-xs text-muted-foreground">{hint}</p>
                  </dd>
                </div>
              ))}
              <div className="space-y-1">
                <dt className="text-sm">First day exports book</dt>
                <dd className="space-y-1">
                  <Input type="date" aria-label="First day exports book" className="w-64" value={draft.exportsFrom} disabled={saving} onChange={(event) => edit((current) => ({ ...current, exportsFrom: event.target.value }))} />
                  <p className="text-xs text-muted-foreground">Rows dated before it were booked by other means. Empty books from the first.</p>
                </dd>
              </div>
            </dl>
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">VAT codes</h3>
              <Button size="sm" variant="outline" disabled={saving} onClick={() => edit((current) => ({ ...current, vatCodes: [...current.vatCodes, { vatPercent: "", code: "", account: NO_ONE }] }))}>
                <Plus className="size-4" /> Add rate
              </Button>
            </div>
            <Table data-testid="accounting-vat-codes">
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead>Rate (%)</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>VAT account</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {draft.vatCodes.length === 0 ? (
                  <EmptyRow colSpan={4} message="No VAT codes yet." hint="An export books no document whose VAT rate has no code." />
                ) : (
                  draft.vatCodes.map((row, index) => (
                    <TableRow key={index}>
                      <TableCell>
                        <Input aria-label={`Rate ${index + 1}`} inputMode="numeric" className="w-24" value={row.vatPercent} disabled={saving} onChange={(event) => { const value = event.target.value; edit((current) => ({ ...current, vatCodes: current.vatCodes.map((code, at) => (at === index ? { ...code, vatPercent: value } : code)) })) }} />
                      </TableCell>
                      <TableCell>
                        <Input aria-label={`Code ${index + 1}`} className="w-32" value={row.code} disabled={saving} onChange={(event) => { const value = event.target.value; edit((current) => ({ ...current, vatCodes: current.vatCodes.map((code, at) => (at === index ? { ...code, code: value } : code)) })) }} />
                      </TableCell>
                      <TableCell>{accountSelect(row.account, (value) => edit((current) => ({ ...current, vatCodes: current.vatCodes.map((code, at) => (at === index ? { ...code, account: value } : code)) })), `VAT account ${index + 1}`, "Pick an account")}</TableCell>
                      <TableCell>
                        <Button size="icon" variant="ghost" aria-label={`Remove rate ${index + 1}`} disabled={saving} onClick={() => edit((current) => ({ ...current, vatCodes: current.vatCodes.filter((_, at) => at !== index) }))}>
                          <Trash className="size-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Product accounts</h3>
              <Button size="sm" variant="outline" disabled={saving || productOptions.length === 0} onClick={() => edit((current) => ({ ...current, productAccounts: [...current.productAccounts, { productId: NO_ONE, account: NO_ONE }] }))}>
                <Plus className="size-4" /> Add product
              </Button>
            </div>
            <Table data-testid="accounting-product-accounts">
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead>Product</TableHead>
                  <TableHead>Revenue account</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {draft.productAccounts.length === 0 ? (
                  <EmptyRow colSpan={3} message="Every product books to the default revenue account." hint="Give a product its own account where the office books its revenue apart." />
                ) : (
                  draft.productAccounts.map((row, index) => (
                    <TableRow key={index}>
                      <TableCell>
                        <Select value={row.productId === "" ? NO_ONE : row.productId} onValueChange={(value) => edit((current) => ({ ...current, productAccounts: current.productAccounts.map((entry, at) => (at === index ? { ...entry, productId: value } : entry)) }))} disabled={saving}>
                          <SelectTrigger aria-label={`Product ${index + 1}`} className="w-64">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NO_ONE}>Pick a product</SelectItem>
                            {productOptions.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                            {/* A product no option offers — not loaded, or another role's — is kept by its id, never dropped unseen. */}
                            {row.productId !== NO_ONE && !productOptions.some((option) => option.value === row.productId) && <SelectItem value={row.productId}>{resolve.byServerId(row.productId)?.name ?? row.productId}</SelectItem>}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>{accountSelect(row.account, (value) => edit((current) => ({ ...current, productAccounts: current.productAccounts.map((entry, at) => (at === index ? { ...entry, account: value } : entry)) })), `Revenue account ${index + 1}`, "Pick an account")}</TableCell>
                      <TableCell>
                        <Button size="icon" variant="ghost" aria-label={`Remove product ${index + 1}`} disabled={saving} onClick={() => edit((current) => ({ ...current, productAccounts: current.productAccounts.filter((_, at) => at !== index) }))}>
                          <Trash className="size-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </section>
        </div>
      )}
    </AssetPanelShell>
  )
}
