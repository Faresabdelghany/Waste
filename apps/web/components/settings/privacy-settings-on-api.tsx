"use client"

// Settings › Administration › Privacy, audit & retention on the Pilot
// (#487): what the API holds of it today. The company's whole history is the
// audit log's read without a row (`GET /audit-events`, under `view` on
// `configure.privacy`), newest first, a page at a time, each request one
// entry naming the rows it touched (`companyHistoryEntriesOf`). Beside it, the
// two controls the platform truly enforces, and each project's privacy policy
// (#291 C19): the days its positions and its photos and signatures are kept
// and why it records positions, read with the project (`configure.organization`)
// and written whole through `PUT /projects/:id/privacy-policy` under `edit` on
// `configure.privacy` (lib/data/privacy-policy.ts), the worker's purges
// reading it the next night. Fixture mode keeps the browser's pane
// (`configure.privacy`).

import { useState } from "react"
import { ArrowClockwise, PencilSimple } from "@phosphor-icons/react/dist/ssr"
import type { AuditEvent } from "@waste/contracts/audit"
import { toast } from "sonner"

import { AssetPanelShell, EmptyRow } from "@/components/settings/asset-management-settings"
import { useReport } from "@/components/insight/use-report"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useApiClient, useApiSession } from "@/components/waste/api-session-store"
import { useBusinessRecordStore, useModuleRecords, useServerModuleState, useServerResolver } from "@/components/waste/business-record-store"
import { allows } from "@/lib/api/grants"
import { problemSentence } from "@/lib/api/problem"
import { typed } from "@/lib/api/records/adapter"
import { COMPANY_HISTORY_MODULE, companyHistoryPage } from "@/lib/api/records/audit"
import { shownOn } from "@/lib/api/records/clock"
import { problemOfError } from "@/lib/api/records/server-records"
import type { Problem } from "@/lib/api/problem"
import { PRIVACY_POLICY_MODULE, replacePrivacyPolicy } from "@/lib/api/privacy"
import { companyHistoryEntriesOf } from "@/lib/data/audit-history"
import { getModuleDefinition, type BusinessRecord } from "@/lib/data/business-modules"
import { GPS_PURPOSE_OPTIONS, gpsPurposeLabel, privacyPolicyFormOf, privacyPolicyFromForm, privacyPolicyOf, retentionLabel, retentionRefusalOf, type PrivacyPolicyForm } from "@/lib/data/privacy-policy"
import { isSoftDeleted } from "@waste/domain/record-visibility"

const ORGANISATION_FIXTURES = getModuleDefinition({ workspaceId: "configure", moduleId: "organization" })?.records ?? []

/** What the platform enforces whatever a setting says: each true of the code, never a policy of the browser's. */
export const ENFORCED_PRIVACY_CONTROLS = [
  {
    label: "Immutable audit history",
    description: "The database writes every change's history itself; no account, an administrator's included, can edit or delete it.",
  },
  {
    label: "Financial-record protection",
    description: "Issued invoices, credit notes, payments and accounting export lines are ledgers: a correction is a new document, never an edit.",
  },
] as const

/** The pages read after the first, by `Load older`. */
type Older = { events: AuditEvent[]; nextCursor: string | null; loading: boolean; problem: Problem | null }

export function PrivacySettingsOnApi() {
  const { me } = useApiSession()
  const client = useApiClient()
  const resolve = useServerResolver()
  const granted = allows(me?.role.grants, COMPANY_HISTORY_MODULE, "view")
  const [reading, setReading] = useState(0)
  const [older, setOlder] = useState<Older | null>(null)
  const first = useReport(granted ? `company-history:${reading}` : null, (asking) => companyHistoryPage(asking))

  const events = [...(first.shown?.items ?? []), ...(older?.events ?? [])]
  const nextCursor = older === null ? (first.shown?.nextCursor ?? null) : older.nextCursor
  const timezoneOf = (event: AuditEvent) => {
    const project = event.projectId === null ? undefined : resolve.byServerId(event.projectId)
    return project === undefined ? undefined : typed(project, "timezone")
  }
  const entries = companyHistoryEntriesOf(events, {
    nameOf: (serverId) => resolve.byServerId(serverId)?.name,
    when: (recordedAt, event) => shownOn(recordedAt, timezoneOf(event)),
  })

  const readAgain = () => {
    setOlder(null)
    setReading((count) => count + 1)
  }
  const loadOlder = () => {
    if (client === null || nextCursor === null) return
    setOlder((current) => ({ events: current?.events ?? [], nextCursor, loading: true, problem: null }))
    companyHistoryPage(client, nextCursor).then(
      (page) => setOlder((current) => ({ events: [...(current?.events ?? []), ...page.items], nextCursor: page.nextCursor, loading: false, problem: null })),
      (error: unknown) => setOlder((current) => ({ events: current?.events ?? [], nextCursor, loading: false, problem: problemOfError(error) })),
    )
  }

  return (
    <AssetPanelShell
      heading="Administration"
      title="Privacy, audit & retention"
      description="How long each project keeps personal data and why it records positions, who changed what across the company, and the controls the platform enforces."
      toolbar={null}
    >
      <RetentionPolicies />

      <section className="space-y-3 rounded-xl border border-border/60 p-4" aria-labelledby="privacy-enforced">
        <h3 id="privacy-enforced" className="text-sm font-semibold">
          Enforced by the platform
        </h3>
        <ul className="space-y-2">
          {ENFORCED_PRIVACY_CONTROLS.map((control) => (
            <li key={control.label}>
              <p className="text-sm font-medium">{control.label}</p>
              <p className="text-xs text-muted-foreground">{control.description}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3 rounded-xl border border-border/60 p-4" aria-labelledby="privacy-history">
        <div className="flex items-center justify-between gap-2">
          <h3 id="privacy-history" className="text-sm font-semibold">
            Audit history
          </h3>
          {granted && (
            <Button variant="outline" size="sm" onClick={readAgain} disabled={first.loading}>
              <ArrowClockwise className="h-4 w-4" />
              Refresh
            </Button>
          )}
        </div>
        {!granted && <p className="text-sm text-muted-foreground">The audit history is not shown to your role.</p>}
        {granted && first.problem !== null && <p className="text-sm text-muted-foreground">The audit history could not be read: {problemSentence(first.problem)}</p>}
        {granted && first.problem === null && first.shown === null && <p className="text-sm text-muted-foreground">Reading the audit history…</p>}
        {first.shown !== null && entries.length === 0 && <p className="text-sm text-muted-foreground">No change has been recorded.</p>}
        {entries.length > 0 && (
          <ol aria-label="Audit history" className={first.loading ? "divide-y divide-border/60 border-y border-border/60 opacity-60" : "divide-y divide-border/60 border-y border-border/60"}>
            {entries.map((entry) => (
              <li key={entry.key} className="space-y-1.5 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{entry.who}</span>
                  <span>{entry.when}</span>
                </div>
                {entry.lines.map((line, index) => (
                  <div key={index} className="space-y-1">
                    <p className="text-sm">{line.what}</p>
                    {line.changes.length > 0 && (
                      <dl className="space-y-0.5 text-xs">
                        {line.changes.map((change) => (
                          <div key={change.label} className="flex flex-wrap gap-x-2">
                            <dt className="text-muted-foreground">{change.label}</dt>
                            <dd>
                              {change.before ?? "—"} → {change.after ?? "—"}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </div>
                ))}
                {entry.reason !== null && <p className="text-xs text-muted-foreground">Reason: {entry.reason}</p>}
              </li>
            ))}
          </ol>
        )}
        {older?.problem != null && <p className="text-sm text-muted-foreground">Older changes could not be read: {problemSentence(older.problem)}</p>}
        {nextCursor !== null && !first.loading && (
          <Button variant="outline" size="sm" onClick={loadOlder} disabled={older?.loading === true}>
            Load older changes
          </Button>
        )}
      </section>
    </AssetPanelShell>
  )
}

/** Each project's privacy policy (#291 C19), and its edit where the role may write the privacy module. */
function RetentionPolicies() {
  const { me } = useApiSession()
  const organisation = useModuleRecords("configure", "organization", ORGANISATION_FIXTURES)
  const projects = organisation.records.filter((record) => !isSoftDeleted(record) && record.id.startsWith("project-")).sort((a, b) => a.name.localeCompare(b.name))
  const editable = allows(me?.role.grants, PRIVACY_POLICY_MODULE, "edit")
  const [editing, setEditing] = useState<BusinessRecord | null>(null)
  const emptyMessage = organisation.pending
    ? "Reading the projects from the API…"
    : organisation.notGranted
      ? "The projects are not shown to your role."
      : organisation.problem
        ? `The projects could not be read from the API: ${organisation.problem.detail ?? organisation.problem.title}`
        : "No projects yet."

  return (
    <section className="space-y-3 rounded-xl border border-border/60 p-4" aria-labelledby="privacy-retention">
      <div className="space-y-1">
        <h3 id="privacy-retention" className="text-sm font-semibold">
          Retention and GPS purpose
        </h3>
        <p className="text-xs text-muted-foreground">How long each project keeps its drivers&apos; positions and its stops&apos; photos and signatures, removed by the nightly purge, and why it records positions. A project with no days of its own keeps the deployment&apos;s setting.</p>
      </div>
      <div className="overflow-x-auto">
        <Table className="min-w-[640px]" aria-label="Retention by project">
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead>Project</TableHead>
              <TableHead>Positions kept</TableHead>
              <TableHead>Photos and signatures kept</TableHead>
              <TableHead>GPS purpose</TableHead>
              {editable && <TableHead className="w-16 text-right">Edit</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {projects.length === 0 ? (
              <EmptyRow colSpan={editable ? 5 : 4} message={emptyMessage} hint="Projects are created under Company & projects." />
            ) : (
              projects.map((project) => {
                const policy = privacyPolicyOf(project)
                return (
                  <TableRow key={project.id}>
                    <TableCell className="font-medium">{project.name}</TableCell>
                    <TableCell className="text-sm">{retentionLabel(policy.positionRetentionDays)}</TableCell>
                    <TableCell className="text-sm">{retentionLabel(policy.proofRetentionDays)}</TableCell>
                    <TableCell className="text-sm">{gpsPurposeLabel(policy.gpsPurpose)}</TableCell>
                    {editable && (
                      <TableCell className="text-right">
                        <Button variant="ghost" size="icon" aria-label={`Edit ${project.name}'s privacy policy`} disabled={!organisation.ready} onClick={() => setEditing(project)}>
                          <PencilSimple className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>
      {editing !== null && <PolicyDialog key={editing.id} project={editing} onClose={() => setEditing(null)} />}
    </section>
  )
}

function PolicyDialog({ project, onClose }: { project: BusinessRecord; onClose: () => void }) {
  const client = useApiClient()
  const state = useServerModuleState("configure", "organization")
  const { refreshModule } = useBusinessRecordStore()
  const [form, setForm] = useState<PrivacyPolicyForm>(() => privacyPolicyFormOf(privacyPolicyOf(project)))
  const [saving, setSaving] = useState(false)
  const body = privacyPolicyFromForm(form)
  const serverId = state?.serverIds.get(project.id)
  const positionsRefusal = retentionRefusalOf("positions", form.positionRetentionDays)
  const proofsRefusal = retentionRefusalOf("proofs", form.proofRetentionDays)

  const save = () => {
    if (client === null || serverId === undefined || body === null) return
    setSaving(true)
    replacePrivacyPolicy(client, serverId, body).then(
      () => {
        toast.success("Privacy policy saved", { description: `${project.name}'s data is purged by it from tonight.` })
        void refreshModule("configure", "organization")
        onClose()
      },
      (error: unknown) => {
        setSaving(false)
        toast.error("The policy was not saved", { description: problemSentence(problemOfError(error)) })
      },
    )
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            save()
          }}
        >
          <DialogHeader>
            <DialogTitle>{project.name}&apos;s privacy policy</DialogTitle>
            <DialogDescription>Leave a period empty to keep the deployment&apos;s setting for it.</DialogDescription>
          </DialogHeader>
          <div className="my-4 grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="policy-positions">Positions kept (days)</Label>
              <Input id="policy-positions" inputMode="numeric" value={form.positionRetentionDays} aria-invalid={positionsRefusal !== null} onChange={(event) => setForm({ ...form, positionRetentionDays: event.target.value })} />
              {positionsRefusal !== null && <p className="text-xs text-destructive">{positionsRefusal}</p>}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="policy-proofs">Photos and signatures kept (days)</Label>
              <Input id="policy-proofs" inputMode="numeric" value={form.proofRetentionDays} aria-invalid={proofsRefusal !== null} onChange={(event) => setForm({ ...form, proofRetentionDays: event.target.value })} />
              {proofsRefusal !== null && <p className="text-xs text-destructive">{proofsRefusal}</p>}
              <p className="text-xs text-muted-foreground">A stop an open ticket names keeps its evidence until the ticket closes.</p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="policy-purpose">GPS purpose</Label>
              <Select value={form.gpsPurpose === "" ? "none" : form.gpsPurpose} onValueChange={(value) => setForm({ ...form, gpsPurpose: value === "none" ? "" : (value as PrivacyPolicyForm["gpsPurpose"]) })}>
                <SelectTrigger id="policy-purpose" aria-label="GPS purpose">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not declared</SelectItem>
                  {GPS_PURPOSE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || body === null || serverId === undefined}>
              Save policy
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

