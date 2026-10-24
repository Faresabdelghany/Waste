"use client"

// A role's permissions on the Pilot (#291): the access module's role record,
// its matrix held as a draft while boxes are ticked and saved whole, once, as
// `PUT /roles/:id/grants` through the store's command (`REPLACE_ROLE_GRANTS`)
// — never a request per tick. A system role's matrix is the platform's, which
// every seed restores to its charter, so it is shown read-only with the
// sentence the API refuses a change in (`roleMatrixOf`); a company that wants
// another reach makes a custom role, which New role may start from it.
import { useState } from "react"
import { toast } from "sonner"

import { RoleGone, RolePermissionsMatrix } from "@/components/settings/role-permissions"
import { useBusinessRecordStore } from "@/components/waste/business-record-store"
import { Button } from "@/components/ui/button"
import { REPLACE_ROLE_GRANTS } from "@/lib/api/records/organisation"
import type { BusinessRecord } from "@/lib/data/business-modules"
import type { RoleAccessMap } from "@/lib/data/role-permissions"
import { accessChanged, roleMatrixOf } from "@/lib/data/users-roles"

export function PilotRolePermissionsPanel({ record, onBack }: { record: BusinessRecord | undefined; onBack: () => void }) {
  if (record === undefined) return <RoleGone onBack={onBack} />
  // Keyed by the role, so another role's panel opens on its own matrix and never on a draft left from this one.
  return <PilotRoleMatrix key={record.id} record={record} onBack={onBack} />
}

function PilotRoleMatrix({ record, onBack }: { record: BusinessRecord; onBack: () => void }) {
  const { sendCommand } = useBusinessRecordStore()
  const matrix = roleMatrixOf(record)
  // Null while nothing is ticked: the panel shows the matrix as the store holds it, so a save's answer is what it shows next.
  const [draft, setDraft] = useState<RoleAccessMap | null>(null)
  const [saving, setSaving] = useState(false)
  const shown = draft ?? matrix.access
  const changed = draft !== null && accessChanged(matrix.access, draft)

  if (matrix.readOnlyBecause !== null) {
    return (
      <RolePermissionsMatrix
        title={matrix.name}
        access={matrix.access}
        onBack={onBack}
        notice={
          <p data-testid="role-permissions-kept" className="rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            {matrix.readOnlyBecause}.
          </p>
        }
      />
    )
  }

  // A promise chain rather than try/finally, which the React Compiler skips. A refusal is the store's toast in the API's words.
  const save = () => {
    setSaving(true)
    void sendCommand("configure", "access", record.id, REPLACE_ROLE_GRANTS, { access: shown })
      .then((outcome) => {
        if (outcome.kind !== "done") return
        setDraft(null)
        toast.success(`${outcome.record.name}'s permissions saved`, { description: "A holder's next request to the API is judged by them." })
      })
      .finally(() => setSaving(false))
  }

  return (
    <RolePermissionsMatrix
      title={matrix.name}
      access={shown}
      onAccessChange={saving ? undefined : setDraft}
      onBack={onBack}
      notice={
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2">
          <p className="text-sm text-muted-foreground">
            {changed ? "Unsaved changes: the role allows what it did until they are saved." : "Tick what the role allows, then save the whole matrix at once."}
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" disabled={!changed || saving} onClick={() => setDraft(null)}>
              Discard
            </Button>
            <Button type="button" size="sm" disabled={!changed || saving} onClick={save}>
              {saving ? "Saving…" : "Save permissions"}
            </Button>
          </div>
        </div>
      }
    />
  )
}
