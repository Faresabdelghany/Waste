"use client"

// The fixtures' Settings form (fixture-settings-controls.ts): its values are
// saved in this browser alone, under SETTINGS_STORAGE_KEY. They are held for
// the page, not the pane, so a change left unsaved on one pane is still there
// after a look at another, and one Save keeps every pane's.

import { useEffect, useSyncExternalStore, type ReactNode } from "react"
import { CheckCircle, Gear, Warning } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import { AssetPanelShell } from "@/components/settings/asset-management-settings"
import { CommercialDefaultsExtras } from "@/components/settings/commercial-settings"
import { FIXTURE_SETTINGS_GROUPS, fixtureSettingDefaults, type SettingControl, type SettingsGroup } from "@/components/settings/fixture-settings-controls"
import type { SettingsPaneProps } from "@/components/settings/settings-pane-views"
import { ThemeCustomizer } from "@/components/settings/theme-customizer"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { useApiConfigured, useApiSession } from "@/components/waste/api-session-store"
import { profileOf, type AccountProfile } from "@/lib/data/account-profile"
import { migrateLegacyId } from "@/lib/data/legacy-ids"
import { readPersisted, SETTINGS_STORAGE_KEY } from "@/lib/storage-keys"
import { cn } from "@/lib/utils"

type SettingValue = string | boolean

type FormState = {
  values: Record<string, SettingValue>
  dirty: readonly string[]
  /** The saves this page made, the last first. */
  saved: ReadonlyArray<{ at: string; controls: readonly string[] }>
}

const INITIAL: FormState = { values: fixtureSettingDefaults(), dirty: [], saved: [] }
let state = INITIAL
let loaded = false
const listeners = new Set<() => void>()

function setState(next: FormState) {
  state = next
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The values this browser saved over the defaults: a control renamed since (`migrateLegacyId`) under its new id, a value of no control or of another type dropped. */
function mergeStored(defaults: Record<string, SettingValue>, raw: string): Record<string, SettingValue> {
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaults
  const stored = Object.entries(parsed).map(([controlId, value]) => {
    const renamed = migrateLegacyId(controlId)
    return renamed !== controlId && !(renamed in parsed) ? ([renamed, value] as const) : ([controlId, value] as const)
  })
  const kept = stored.filter(([controlId, value]) => {
    const fixed = defaults[controlId]
    return fixed !== undefined && typeof value === typeof fixed && (typeof value === "string" || typeof value === "boolean")
  })
  return { ...defaults, ...Object.fromEntries(kept) }
}

function useFormState(): FormState {
  const current = useSyncExternalStore(subscribe, () => state, () => INITIAL)
  useEffect(() => {
    if (loaded) return
    loaded = true
    try {
      const stored = readPersisted(window.localStorage, SETTINGS_STORAGE_KEY)
      if (stored) setState({ ...state, values: mergeStored(INITIAL.values, stored) })
    } catch {
      // Keep the defaults when local storage is unavailable or holds something unreadable.
    }
  }, [])
  return current
}

function change(controlId: string, value: SettingValue) {
  setState({ ...state, values: { ...state.values, [controlId]: value }, dirty: state.dirty.includes(controlId) ? state.dirty : [...state.dirty, controlId] })
}

function save() {
  const controls = state.dirty
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(state.values))
  } catch {
    toast.error("Settings could not be saved", { description: "Local storage is unavailable. Your changes are still visible in this session." })
    return
  }
  setState({ ...state, dirty: [], saved: [{ at: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), controls }, ...state.saved] })
  toast.success("Settings saved", { description: `${controls.length} change${controls.length === 1 ? "" : "s"} saved on this device.` })
}

/** A fixture pane's groups of controls, under the pane's frame, with `before` and `after` around them and a bar saving them on this device where one can be set. */
function FixtureSettingsForm({ groups, action, before, after }: { groups: readonly SettingsGroup[]; action?: ReactNode; before?: ReactNode; after?: ReactNode }) {
  const { values, dirty, saved } = useFormState()
  // A pane of read lines alone — the Pilot's account profile — has nothing to save on this device.
  const editable = groups.some((group) => group.controls.some((control) => control.type === "input" || control.type === "select" || control.type === "switch"))
  const last = saved[0]

  return (
    <AssetPanelShell action={action}>
      {before}
      {groups.map((group, index) => (
        <div key={group.title} className="space-y-4">
          <h3 className="text-sm font-semibold text-foreground">{group.title}</h3>
          <div className="divide-y divide-border border-y border-border/60">
            {group.controls.map((control) => (
              <ControlRow key={control.id} control={control} value={values[control.id]} />
            ))}
          </div>
          {index < groups.length - 1 && <Separator />}
        </div>
      ))}
      {after}
      {editable && (
        <div className="sticky bottom-0 flex items-center justify-between gap-3 border-t border-border bg-background py-4">
          <p className="text-xs text-muted-foreground">
            {dirty.length > 0
              ? `${dirty.length} unsaved change${dirty.length === 1 ? "" : "s"} · save to keep ${dirty.length === 1 ? "it" : "them"} on this device.`
              : last
                ? `Saved on this device at ${last.at} · ${last.controls.length} change${last.controls.length === 1 ? "" : "s"}.`
                : null}
          </p>
          <Button disabled={dirty.length === 0} onClick={save}>
            Save changes
          </Button>
        </div>
      )}
    </AssetPanelShell>
  )
}

function ControlRow({ control, value }: { control: SettingControl; value: SettingValue | undefined }) {
  const labelId = `${control.id}-label`
  return (
    <div className="grid gap-4 px-4 py-4 md:grid-cols-[minmax(0,1fr)_minmax(260px,0.8fr)] md:items-center">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span id={labelId} className="text-sm font-medium text-foreground">
            {control.label}
          </span>
          <Badge variant="outline" className="rounded-full px-2 py-0 text-[10px] font-normal">
            {control.scope}
          </Badge>
        </div>
      </div>
      <div className="md:justify-self-stretch">
        {control.type === "input" && (
          <Input id={control.id} type={control.inputType ?? "text"} value={String(value ?? control.value)} className="h-9 text-sm" aria-labelledby={labelId} onChange={(event) => change(control.id, event.target.value)} />
        )}
        {control.type === "select" && (
          <Select value={String(value ?? control.value)} onValueChange={(next) => change(control.id, next)}>
            <SelectTrigger id={control.id} className="h-9 text-sm" aria-labelledby={labelId}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {control.options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {control.type === "switch" && (
          <div className="flex items-center justify-end">
            <Switch id={control.id} checked={Boolean(value ?? control.checked)} aria-labelledby={labelId} onCheckedChange={(checked) => change(control.id, checked)} />
          </div>
        )}
        {control.type === "status" && (
          <div className="flex flex-wrap items-center gap-2" aria-labelledby={labelId}>
            <StatusIndicator tone={control.tone} value={control.value} />
          </div>
        )}
        {control.type === "text" && (
          <p id={control.id} className="text-sm text-foreground" aria-labelledby={labelId}>
            {control.value}
          </p>
        )}
      </div>
    </div>
  )
}

function StatusIndicator({ tone, value }: { tone: Extract<SettingControl, { type: "status" }>["tone"]; value: string }) {
  const Icon = tone === "healthy" ? CheckCircle : tone === "danger" ? Warning : tone === "warning" ? Warning : Gear
  const className = tone === "healthy" ? "text-success" : tone === "danger" ? "text-destructive-foreground" : tone === "warning" ? "text-warning-foreground" : "text-muted-foreground"
  return (
    <span className={cn("inline-flex items-center gap-2 text-xs font-medium", className)}>
      <Icon className="h-4 w-4" weight={tone === "healthy" || tone === "danger" ? "fill" : "regular"} />
      {value}
    </span>
  )
}

/** A fixture pane that is its groups alone. */
export function FixtureSettingsPane({ paneId }: SettingsPaneProps) {
  return <FixtureSettingsForm groups={FIXTURE_SETTINGS_GROUPS[paneId] ?? []} />
}

/** Commercial defaults: its groups, then the registries and parameters the fixtures' products carry. */
export function CommercialDefaultsSettings() {
  return <FixtureSettingsForm groups={FIXTURE_SETTINGS_GROUPS.pricing ?? []} after={<CommercialDefaultsExtras />} />
}

/**
 * Account & appearance: the theme, then the account's groups. On the Pilot
 * (#282) its Profile is the person signed in, as `/me` answered — each line
 * read, since no control here writes them — and its personal defaults, which
 * this browser saves and nothing reads, are left out (#487).
 */
export function AccountSettings() {
  const configured = useApiConfigured()
  const { me, session } = useApiSession()
  const profile = configured ? profileOf(me, session?.email) : null
  const groups = FIXTURE_SETTINGS_GROUPS.account ?? []
  return (
    <FixtureSettingsForm
      groups={profile === null ? groups : signedInGroups(groups, profile)}
      action={
        profile === null ? (
          <Avatar className="h-6 w-6">
            <AvatarImage src="/avatar-profile.jpg" />
            <AvatarFallback>OL</AvatarFallback>
          </Avatar>
        ) : (
          // The person signed in, by their initials: no photo is theirs on the Pilot (#282).
          <Avatar className="h-6 w-6">
            <AvatarFallback>{profile.initials}</AvatarFallback>
          </Avatar>
        )
      }
      before={<ThemeCustomizer />}
    />
  )
}

function signedInGroups(groups: readonly SettingsGroup[], profile: AccountProfile): SettingsGroup[] {
  const controls: SettingControl[] = [
    { id: "account-name", label: "Full name", description: "Shown in assignments, approvals, comments, and audit history, as your account holds it.", scope: "Personal", type: "text", value: profile.name },
    { id: "account-email", label: "Email address", description: "The address you sign in with.", scope: "Personal", type: "text", value: profile.email },
    { id: "account-role", label: "Primary role", description: "What you may see and do; an administrator sets it.", scope: "Personal", type: "status", value: profile.role, tone: "healthy" },
    { id: "account-projects", label: "Projects", description: "The projects you work in.", scope: "Personal", type: "text", value: profile.projects },
  ]
  return groups.filter((group) => group.id !== "defaults").map((group) => (group.id === "profile" ? { ...group, controls } : group))
}
