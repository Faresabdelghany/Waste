"use client"
// Service Providers › Activities on the Pilot (#474): Log activity, and what
// an Activity's details offer. Log activity opens the form its side is
// given (`activityOpenForm`): the office names the provider and may raise a
// follow-up; a provider's account opens a proposal or a note for its own
// provider, which the dialog stamps. A proposal is opened on a route of its
// group, from the routes the account reads. A row's details offer the
// commands its kind takes from where it stands, from the side looking
// (`activityCommandsOffered`), each a press that asks a reason — a rejection
// always — and, while it is open and its side's, a correction. The API's
// refusal is the store's toast in its own words: an approval the scheme's
// rules refuse says why, and the proposal stays pending.
import { useState } from "react"
import { Plus } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { useApiSession } from "@/components/waste/api-session-store"
import { BusinessRecordFormDialog } from "@/components/waste/business-record-form-dialog"
import { savedRow, useBusinessRecordStore, useServerModuleState, whenSaved } from "@/components/waste/business-record-store"
import type { PrimarySurfaceProps, RowSurfaceProps } from "@/components/waste/commands/command-surfaces"
import { useCommandRunner, useModuleReady, useOpenRecord } from "@/components/waste/commands/use-command-support"
import { useCommandOffered, useProviderWebId } from "@/components/waste/provider-account"
import { ROUTES_MODULE } from "@/lib/api/records/routes"
import type { BusinessFormOption, BusinessFormValues } from "@/lib/data/business-form-types"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { ORGANISATION_MODULE } from "@/lib/data/containers"
import {
  activityCommandsOffered,
  activityCorrectable,
  activityCorrectionForm,
  activityOpenForm,
  ACTIVITY_KIND_KEY,
  correctionValuesOf,
  createActivityRecord,
  PROVIDER_ACTIVITIES_MODULE,
  reasonForm,
  type ActivityOffer,
} from "@/lib/data/provider-activities"
import { SERVICE_PROVIDERS_MODULE, serviceAreaKindOf } from "@/lib/data/provider-money"
import { PATCH_RECORD } from "@/lib/data/provider-workspace"
import type { ServiceProviderActivityKind } from "@waste/domain/service-providers/vocabulary"
import type { ActivitySide } from "@waste/domain/service-providers/activities"

const { workspaceId, moduleId } = PROVIDER_ACTIVITIES_MODULE
const SERVICE_AREAS_MODULE = { workspaceId: "service-providers", moduleId: "service-areas" } as const

const optionsOf = (records: readonly BusinessRecord[] | undefined, keep: (record: BusinessRecord) => boolean, label: (record: BusinessRecord) => string = (record) => record.name): BusinessFormOption[] =>
  (records ?? []).filter(keep).map((record) => ({ value: record.id, label: label(record) }))

/** The side the account signed in is on, and its provider's web id where it is a provider's. */
function useSide(): { side: ActivitySide; providerWebId: string | undefined } {
  const { me } = useApiSession()
  const providerId = me?.serviceProvider?.id
  const providerWebId = useProviderWebId(providerId)
  return { side: providerId === undefined ? "office" : "provider", providerWebId }
}

/** Log activity: the form its side is given, over the routes, the awards, and for the office the providers and the projects it reads. */
export function LogActivitySurface({ label }: PrimarySurfaceProps) {
  const { side, providerWebId } = useSide()
  const moduleReady = useModuleReady(PROVIDER_ACTIVITIES_MODULE)
  const routes = useServerModuleState(ROUTES_MODULE.workspaceId, ROUTES_MODULE.moduleId)
  const areas = useServerModuleState(SERVICE_AREAS_MODULE.workspaceId, SERVICE_AREAS_MODULE.moduleId)
  const providers = useServerModuleState(SERVICE_PROVIDERS_MODULE.workspaceId, SERVICE_PROVIDERS_MODULE.moduleId)
  const organisation = useServerModuleState(ORGANISATION_MODULE.workspaceId, ORGANISATION_MODULE.moduleId)
  const { upsertRecord } = useBusinessRecordStore()
  const openRecord = useOpenRecord(moduleId)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  const schema = activityOpenForm(side, {
    // A proposal is about a scheme's group: the routes generation wrote, never the office's ad-hoc ones.
    routes: optionsOf(routes?.records, (record) => typeof record.submittedValues?.schemeId === "string" && record.submittedValues.schemeId !== "", (record) => [record.name, record.context].filter(Boolean).join(" · ")),
    serviceAreas: optionsOf(areas?.records, (record) => serviceAreaKindOf(record) === "service-area"),
    providers: optionsOf(providers?.records, () => true),
    projects: optionsOf(organisation?.records, (record) => record.recordKind === "Project"),
  })

  const submit = (values: BusinessFormValues) => {
    if (saving) return
    const record = createActivityRecord(values, Date.now(), side === "provider" && providerWebId !== undefined ? { serviceProviderId: providerWebId } : {})
    setSaving(true)
    whenSaved(
      upsertRecord(workspaceId, moduleId, record),
      (saved) => {
        setOpen(false)
        openRecord(record.id)
        toast.success("Activity logged", { description: savedRow(saved, record).name })
      },
      () => setSaving(false),
    )
  }

  return (
    <>
      <Button size="sm" disabled={!moduleReady} onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" weight="bold" />
        <span className="hidden sm:inline">{label}</span>
        <span className="sm:hidden">Action</span>
      </Button>
      {open && <BusinessRecordFormDialog schema={schema} open onOpenChange={setOpen} onSubmit={submit} relationOptions={(field) => field.options ?? []} submitting={saving} />}
    </>
  )
}

/** An Activity's commands and its correction, in its details. */
export function ActivityCommandsSurface({ record }: RowSurfaceProps) {
  const { side } = useSide()
  const moduleReady = useModuleReady(PROVIDER_ACTIVITIES_MODULE)
  const offered = useCommandOffered(PROVIDER_ACTIVITIES_MODULE)
  const { upsertRecord } = useBusinessRecordStore()
  const { busy, run, save } = useCommandRunner(PROVIDER_ACTIVITIES_MODULE, record.id)
  const [asking, setAsking] = useState<ActivityOffer | null>(null)
  const [correcting, setCorrecting] = useState(false)
  const kind = record.submittedValues?.[ACTIVITY_KIND_KEY] as ServiceProviderActivityKind | undefined
  const offers = activityCommandsOffered(record, side).filter((offer) => offered(offer.command))
  const correctable = kind !== undefined && activityCorrectable(record, side) && offered(PATCH_RECORD)

  const send = (offer: ActivityOffer, values: BusinessFormValues) =>
    run(offer.command, values, (outcome) => {
      setAsking(null)
      toast.success(offer.done, { description: outcome.record.name })
    })

  const correct = (values: BusinessFormValues) =>
    save(upsertRecord(workspaceId, moduleId, { ...record, name: record.name, submittedValues: { ...record.submittedValues, ...values } }), (saved) => {
      if (saved === undefined) return
      setCorrecting(false)
      toast.success("Activity corrected", { description: savedRow(saved, record).name })
    })

  return (
    <section className="space-y-3" data-testid="activity-commands">
      <h3 className="text-sm font-semibold">Activity</h3>
      {!moduleReady && <p className="text-sm text-muted-foreground">The activities are being read from the API; their commands follow.</p>}
      {offers.length === 0 && !correctable && moduleReady && <p className="text-sm text-muted-foreground">Nothing for you to do here.</p>}
      <div className="flex flex-wrap gap-2">
        {offers.map((offer) => (
          <Button key={offer.command} variant={offer.command === "approve" ? "default" : "outline"} size="sm" disabled={!moduleReady || busy} onClick={() => setAsking(offer)}>
            {offer.label}
          </Button>
        ))}
        {correctable && (
          <Button variant="ghost" size="sm" disabled={!moduleReady || busy} onClick={() => setCorrecting(true)}>
            Correct
          </Button>
        )}
      </div>
      {asking !== null && (
        <BusinessRecordFormDialog schema={reasonForm(asking)} open onOpenChange={(isOpen) => !isOpen && setAsking(null)} onSubmit={(values) => send(asking, values)} relationOptions={() => []} submitting={busy} />
      )}
      {correcting && kind !== undefined && (
        <BusinessRecordFormDialog
          schema={activityCorrectionForm(kind)}
          open
          onOpenChange={(isOpen) => !isOpen && setCorrecting(false)}
          onSubmit={correct}
          relationOptions={(field) => field.options ?? []}
          initialValueOverrides={correctionValuesOf(record)}
          submitting={busy}
        />
      )}
    </section>
  )
}
