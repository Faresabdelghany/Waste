"use client"
// A service provider's team on the Pilot (#291 C24): Add user invites an
// account through `POST /users` on a provider's role — into the signed-in
// provider's own team, which the API holds it to, or for the office into the
// provider it picks — and a member's details switch the account off and on
// again. The API's refusal (a role wider than the inviter's, an address taken,
// a manager's own account) is the store's toast in its words, over the form
// still holding what was typed. The forms are lib/data/provider-workspace.ts's.
import { useState } from "react"
import { Plus } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { BusinessRecordFormDialog } from "@/components/waste/business-record-form-dialog"
import { getModuleDefinition } from "@/lib/data/business-modules"
import { savedRow, useBusinessRecordStore, useModuleRecords, whenSaved } from "@/components/waste/business-record-store"
import type { PrimarySurfaceProps, RowSurfaceProps } from "@/components/waste/commands/command-surfaces"
import { useCommandRunner, useModuleReady, useOpenRecord } from "@/components/waste/commands/use-command-support"
import { useProviderWebId, useProviderWorkspace } from "@/components/waste/provider-account"
import { DEACTIVATE_USER, REACTIVATE_USER } from "@/lib/api/records/organisation"
import type { BusinessFormValues } from "@/lib/data/business-form-types"
import { SERVICE_PROVIDERS_MODULE } from "@/lib/data/provider-money"
import { createTeamMemberRecord, TEAM_MODULE, teamInviteForm, teamRoleOptions } from "@/lib/data/provider-workspace"

const NO_RECORDS: never[] = []
const fixturesOf = (location: typeof TEAM_MODULE) => getModuleDefinition(location)?.records ?? NO_RECORDS

/** Add user: a provider's account invites into its own team; the office picks the provider. */
export function InviteTeamMemberSurface({ label }: PrimarySurfaceProps) {
  const { upsertRecord } = useBusinessRecordStore()
  const team = useModuleRecords(TEAM_MODULE.workspaceId, TEAM_MODULE.moduleId, fixturesOf(TEAM_MODULE))
  const providers = useModuleRecords(SERVICE_PROVIDERS_MODULE.workspaceId, SERVICE_PROVIDERS_MODULE.moduleId, fixturesOf(SERVICE_PROVIDERS_MODULE))
  const workspace = useProviderWorkspace()
  const ownProvider = useProviderWebId(workspace?.providerId)
  const openRecord = useOpenRecord(TEAM_MODULE.moduleId)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const schema = teamInviteForm(
    teamRoleOptions(team.records),
    workspace === null ? providers.records.map((record) => ({ value: record.id, label: record.name })) : null,
  )
  const ready = team.ready && (workspace !== null || providers.ready)

  const submit = (values: BusinessFormValues) => {
    const provider = ownProvider ?? (typeof values.serviceProviderId === "string" ? values.serviceProviderId : "")
    if (saving || provider === "") return
    const record = createTeamMemberRecord(values, provider, Date.now())
    setSaving(true)
    whenSaved(
      upsertRecord(TEAM_MODULE.workspaceId, TEAM_MODULE.moduleId, record),
      (saved) => {
        setOpen(false)
        openRecord(record.id)
        const row = savedRow(saved, record)
        toast.success("User invited", { description: `${row.name} is invited: they sign in with ${String(row.submittedValues?.email ?? "their address")} once their login is made.` })
      },
      () => setSaving(false),
    )
  }

  return (
    <>
      <Button size="sm" disabled={!ready} onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" weight="bold" />
        <span className="hidden sm:inline">{label}</span>
        <span className="sm:hidden">Action</span>
      </Button>
      {open && <BusinessRecordFormDialog schema={schema} open onOpenChange={setOpen} onSubmit={submit} relationOptions={(field) => field.options ?? []} submitting={saving} />}
    </>
  )
}

/** A member's details: switched off while invited or active, on again once deactivated. */
export function TeamMemberCommandsSurface({ record }: RowSurfaceProps) {
  const moduleReady = useModuleReady(TEAM_MODULE)
  const { busy, run } = useCommandRunner(TEAM_MODULE, record.id)
  const deactivated = record.status.toLowerCase() === "deactivated"

  const send = (name: string, done: string) =>
    run(name, undefined, (outcome) => {
      toast.success(done, { description: `${outcome.record.name} is ${outcome.record.status.toLowerCase()}.` })
    })

  return (
    <section className="space-y-4" data-testid="team-member-commands">
      <h3 className="text-sm font-semibold">Account</h3>
      {!moduleReady && <p className="text-sm text-muted-foreground">The team is being read from the API; its commands follow.</p>}
      <div className="flex flex-wrap gap-2">
        {deactivated ? (
          <Button variant="outline" size="sm" disabled={!moduleReady || busy} onClick={() => send(REACTIVATE_USER, "User reactivated")}>
            Reactivate
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled={!moduleReady || busy} onClick={() => send(DEACTIVATE_USER, "User deactivated")}>
            Deactivate
          </Button>
        )}
      </div>
    </section>
  )
}
