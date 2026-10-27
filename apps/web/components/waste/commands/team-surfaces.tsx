"use client"
// A service provider's team on the Pilot (#291 C24): Add user invites an
// account through `POST /users` on a provider's role into the signed-in
// provider's own team, which the API holds it to, and a member's details
// switch the account off and on again where the role allows `edit` — never
// the viewer's own, which the API keeps for another manager or the office.
// The API's refusal (a role wider than the inviter's, an address taken) is
// the store's toast in its words, over the form still holding what was
// typed. The module is a provider's account's alone (`providersOnly`): the
// office invites and switches accounts in Settings › Users & roles. The form
// is lib/data/provider-workspace.ts's.
import { useState } from "react"
import { Plus } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { BusinessRecordFormDialog } from "@/components/waste/business-record-form-dialog"
import { useApiSession } from "@/components/waste/api-session-store"
import { savedRow, useBusinessRecordStore, useModuleRecords, useServerModuleState, whenSaved } from "@/components/waste/business-record-store"
import type { PrimarySurfaceProps, RowSurfaceProps } from "@/components/waste/commands/command-surfaces"
import { useCommandRunner, useModuleReady, useOpenRecord } from "@/components/waste/commands/use-command-support"
import { useCommandOffered, useProviderWebId, useProviderWorkspace } from "@/components/waste/provider-account"
import { DEACTIVATE_USER, REACTIVATE_USER } from "@/lib/api/records/organisation"
import type { BusinessFormValues } from "@/lib/data/business-form-types"
import { getModuleDefinition } from "@/lib/data/business-modules"
import { createTeamMemberRecord, TEAM_MODULE, teamInviteForm, teamRoleOptions } from "@/lib/data/provider-workspace"

const NO_RECORDS: never[] = []
const fixturesOf = (location: typeof TEAM_MODULE) => getModuleDefinition(location)?.records ?? NO_RECORDS

/** Add user: a provider's account invites into its own team. */
export function InviteTeamMemberSurface({ label }: PrimarySurfaceProps) {
  const { upsertRecord } = useBusinessRecordStore()
  const team = useModuleRecords(TEAM_MODULE.workspaceId, TEAM_MODULE.moduleId, fixturesOf(TEAM_MODULE))
  const workspace = useProviderWorkspace()
  const ownProvider = useProviderWebId(workspace?.providerId)
  const openRecord = useOpenRecord(TEAM_MODULE.moduleId)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  if (workspace === null || ownProvider === undefined) return null
  const schema = teamInviteForm(teamRoleOptions(team.records))

  const submit = (values: BusinessFormValues) => {
    if (saving) return
    const record = createTeamMemberRecord(values, ownProvider, Date.now())
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
      <Button size="sm" disabled={!team.ready} onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" weight="bold" />
        <span className="hidden sm:inline">{label}</span>
        <span className="sm:hidden">Action</span>
      </Button>
      {open && <BusinessRecordFormDialog schema={schema} open onOpenChange={setOpen} onSubmit={submit} relationOptions={(field) => field.options ?? []} submitting={saving} />}
    </>
  )
}

/** A member's details: switched off while invited or active, on again once deactivated — never the viewer's own account. */
export function TeamMemberCommandsSurface({ record }: RowSurfaceProps) {
  const moduleReady = useModuleReady(TEAM_MODULE)
  const { busy, run } = useCommandRunner(TEAM_MODULE, record.id)
  const { me } = useApiSession()
  const offered = useCommandOffered(TEAM_MODULE)
  const serverId = useServerModuleState(TEAM_MODULE.workspaceId, TEAM_MODULE.moduleId)?.serverIds.get(record.id)
  const deactivated = record.status.toLowerCase() === "deactivated"
  const command = deactivated ? REACTIVATE_USER : DEACTIVATE_USER
  if (me?.serviceProvider == null || serverId === me.user.id || !offered(command)) return null

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
