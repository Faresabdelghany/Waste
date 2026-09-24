"use client"

// PROTOTYPE — throwaway, not production.
// Three structurally different variants of the Route Scheme "Guided Setup"
// wizard, mounted as an overlay on the existing /route-studio?module=schemes
// page and switched via the ?variant= search param (A | B | C).
//   A — Guided stepper (the incumbent wizard pattern, plus a recurrence step)
//   B — Single-page form with a live summary rail (no steps)
//   C — Calendar-first: the recurrence preview IS the editor
// Draft state is shared across variants so you can flip mid-edit and compare.
// Nothing is persisted; "Create" shows a confirmation panel only.

import { useEffect, useMemo, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { ArrowLeft, ArrowRight, Check, X } from "lucide-react"

import { Stepper } from "@/components/project-wizard/Stepper"
import { businessWorkspaces, type BusinessRecord } from "@/lib/data/business-modules"
import { cn } from "@/lib/utils"

/* ----------------------------- fixture data ----------------------------- */

function moduleRecords(workspaceId: keyof typeof businessWorkspaces, moduleId: string): BusinessRecord[] {
  return (
    businessWorkspaces[workspaceId]?.modules.find((m) => m.id === moduleId)?.records ?? []
  )
}

/* ------------------------------ draft model ----------------------------- */

const DAY_KEYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const
type DayKey = (typeof DAY_KEYS)[number]
const DAY_LABELS: Record<DayKey, string> = {
  monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu",
  friday: "Fri", saturday: "Sat", sunday: "Sun",
}

type SchemeDraft = {
  name: string
  project: string
  frequency: "weekly" | "every-2-weeks" | "monthly"
  weekParity: "odd" | "even"
  serviceDays: DayKey[]
  effectiveFrom: string
  effectiveTo: string
  startTime: string
  vehicleId: string
  driverId: string
  containerIds: string[]
  /** When several service days are picked: one shared stop list, or a plan per day. */
  sameAllDays: boolean
  containersByDay: Partial<Record<DayKey, string[]>>
}

function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

const INITIAL_DRAFT: SchemeDraft = {
  name: "",
  project: "Copenhagen Central",
  frequency: "weekly",
  weekParity: "odd",
  serviceDays: ["sunday"],
  effectiveFrom: toISODate(new Date()),
  effectiveTo: "",
  startTime: "06:30",
  vehicleId: "",
  driverId: "",
  containerIds: [],
  sameAllDays: true,
  containersByDay: {},
}

const DAY_COLORS: Record<DayKey, string> = {
  monday: "#2563eb", tuesday: "#d97706", wednesday: "#db2777", thursday: "#7c3aed",
  friday: "#dc2626", saturday: "#0891b2", sunday: "#059669",
}

function sortedServiceDays(draft: SchemeDraft): DayKey[] {
  return [...draft.serviceDays].sort((a, b) => DAY_KEYS.indexOf(a) - DAY_KEYS.indexOf(b))
}

/** One generated route per service day: its day and its stop list. */
function effectiveDayPlans(draft: SchemeDraft): { day: DayKey; containerIds: string[] }[] {
  return sortedServiceDays(draft).map((day) => ({
    day,
    containerIds: draft.sameAllDays ? draft.containerIds : (draft.containersByDay[day] ?? []),
  }))
}

/* --------------------------- recurrence helpers ------------------------- */

function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  t.setUTCDate(t.getUTCDate() + 3 - ((t.getUTCDay() + 6) % 7))
  const w1 = new Date(Date.UTC(t.getUTCFullYear(), 0, 4))
  return 1 + Math.round(((+t - +w1) / 864e5 - 3 + ((w1.getUTCDay() + 6) % 7)) / 7)
}

function matchesDraft(date: Date, draft: SchemeDraft): boolean {
  const iso = toISODate(date)
  if (draft.effectiveFrom && iso < draft.effectiveFrom) return false
  if (draft.effectiveTo && iso > draft.effectiveTo) return false
  const dayKey = DAY_KEYS[(date.getDay() + 6) % 7]
  if (!draft.serviceDays.includes(dayKey)) return false
  if (draft.frequency === "every-2-weeks") {
    const parity = isoWeek(date) % 2 === 1 ? "odd" : "even"
    if (parity !== draft.weekParity) return false
  }
  // "Once a month" = the first occurrence of each selected weekday in the month.
  if (draft.frequency === "monthly" && date.getDate() > 7) return false
  return true
}

function nextServiceDates(draft: SchemeDraft, count: number): Date[] {
  const out: Date[] = []
  const cursor = new Date()
  cursor.setDate(cursor.getDate() + 1)
  for (let i = 0; i < 400 && out.length < count; i++) {
    if (matchesDraft(cursor, draft)) out.push(new Date(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }
  return out
}

const fmtDate = (d: Date) =>
  d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })

function recurrenceSentence(draft: SchemeDraft): string {
  if (draft.serviceDays.length === 0) return "No service days selected"
  const days = [...draft.serviceDays]
    .sort((a, b) => DAY_KEYS.indexOf(a) - DAY_KEYS.indexOf(b))
    .map((d) => DAY_LABELS[d])
    .join(", ")
  if (draft.frequency === "monthly") return `Once a month (first ${days} of the month)`
  return draft.frequency === "weekly"
    ? `Every week on ${days}`
    : `Every 2 weeks (${draft.weekParity} ISO weeks) on ${days}`
}

function draftIssues(draft: SchemeDraft): string[] {
  const issues: string[] = []
  if (!draft.name.trim()) issues.push("Name the scheme")
  if (draft.serviceDays.length === 0) issues.push("Pick at least one service day")
  if (!draft.effectiveFrom || !draft.effectiveTo) issues.push("Set the effective from and to dates")
  else if (draft.effectiveTo < draft.effectiveFrom) issues.push("Effective to must be after effective from")
  if (!draft.vehicleId) issues.push("Pick a default vehicle")
  if (!draft.driverId) issues.push("Pick a default driver")
  const plans = effectiveDayPlans(draft)
  const emptyDays = plans.filter((p) => p.containerIds.length === 0)
  if (plans.length > 0 && emptyDays.length === plans.length) {
    issues.push("Pick at least one container")
  } else if (emptyDays.length > 0) {
    issues.push(`Pick containers for ${emptyDays.map((p) => DAY_LABELS[p.day]).join(", ")}`)
  }
  return issues
}

function fractionSummary(ids: string[], containers: BusinessRecord[]): string {
  const counts = new Map<string, number>()
  for (const id of ids) {
    const f = containers.find((c) => c.id === id)?.facts["Waste fractions"]
    if (f) counts.set(f, (counts.get(f) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([f, n]) => `${n} ${f}`)
    .join(" · ") || "No containers"
}

/** Deterministic pseudo-position so a container always lands on the same map spot. */
function pseudoPos(id: string): { x: number; y: number } {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return { x: 10 + ((h % 997) / 997) * 80, y: 12 + ((Math.floor(h / 997) % 991) / 991) * 74 }
}

/* ------------------------------ shared bits ----------------------------- */

type VariantProps = {
  draft: SchemeDraft
  setDraft: (patch: Partial<SchemeDraft>) => void
  containers: BusinessRecord[]
  vehicles: BusinessRecord[]
  drivers: BusinessRecord[]
  onClose: () => void
}

function DayToggles({ draft, setDraft, size = "md" }: Pick<VariantProps, "draft" | "setDraft"> & { size?: "md" | "lg" }) {
  return (
    <div className="flex flex-wrap gap-2">
      {DAY_KEYS.map((day) => {
        const on = draft.serviceDays.includes(day)
        return (
          <button
            key={day}
            type="button"
            onClick={() =>
              setDraft({
                serviceDays: on
                  ? draft.serviceDays.filter((d) => d !== day)
                  : [...draft.serviceDays, day],
              })
            }
            className={cn(
              "rounded-full border font-medium transition-colors",
              size === "lg" ? "px-4 py-2 text-sm" : "px-3 py-1.5 text-xs",
              on
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background text-muted-foreground hover:border-primary/50",
            )}
          >
            {DAY_LABELS[day]}
          </button>
        )
      })}
    </div>
  )
}

function FrequencyToggles({ draft, setDraft }: Pick<VariantProps, "draft" | "setDraft">) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {(
        [
          ["weekly", "Every week"],
          ["every-2-weeks", "Every 2 weeks"],
          ["monthly", "Once a month"],
        ] as const
      ).map(([value, label]) => (
        <button
          key={value}
          type="button"
          onClick={() => setDraft({ frequency: value })}
          className={cn(
            "rounded-md border px-3 py-1.5 text-xs font-medium",
            draft.frequency === value
              ? "border-primary bg-primary/10 text-primary"
              : "border-border text-muted-foreground hover:border-primary/50",
          )}
        >
          {label}
        </button>
      ))}
      {draft.frequency === "every-2-weeks" && (
        <select
          value={draft.weekParity}
          onChange={(e) => setDraft({ weekParity: e.target.value as "odd" | "even" })}
          className="rounded-md border border-border bg-background px-2 py-1.5 text-xs"
        >
          <option value="odd">Odd ISO weeks</option>
          <option value="even">Even ISO weeks</option>
        </select>
      )}
    </div>
  )
}

function DatePreview({ draft, count = 6, className }: { draft: SchemeDraft; count?: number; className?: string }) {
  const dates = useMemo(() => nextServiceDates(draft, count), [draft, count])
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {dates.length === 0 ? (
        <span className="text-xs text-muted-foreground">No upcoming dates — pick a service day.</span>
      ) : (
        dates.map((d) => (
          <span
            key={d.toISOString()}
            className="rounded bg-primary/10 px-2 py-0.5 font-mono text-[11px] text-primary"
          >
            {fmtDate(d)}
          </span>
        ))
      )}
    </div>
  )
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  )
}

function SelectField({
  value, onChange, options, placeholder,
}: {
  value: string
  onChange: (v: string) => void
  options: { id: string; label: string }[]
  placeholder: string
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
    >
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

function ContainerPicker({
  draft, containers, picked, onPick, compact = false,
}: Pick<VariantProps, "draft" | "containers"> & {
  picked: string[]
  onPick: (ids: string[]) => void
  compact?: boolean
}) {
  const [search, setSearch] = useState("")
  const [fraction, setFraction] = useState("all")
  const fractions = useMemo(
    () => Array.from(new Set(containers.map((c) => c.facts["Waste fractions"]).filter(Boolean))),
    [containers],
  )
  const filtered = containers.filter((c) => {
    if (c.facts.Project !== draft.project) return false
    if (fraction !== "all" && c.facts["Waste fractions"] !== fraction) return false
    if (search && !`${c.name} ${c.facts.Address ?? ""}`.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })
  const visible = filtered.slice(0, compact ? 6 : 12)
  const allVisiblePicked = filtered.length > 0 && filtered.every((c) => picked.includes(c.id))
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search containers…"
          className="w-40 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs"
        />
        <select
          value={fraction}
          onChange={(e) => setFraction(e.target.value)}
          className="rounded-md border border-border bg-background px-2 py-1.5 text-xs"
        >
          <option value="all">All fractions</option>
          {fractions.map((f) => (
            <option key={f} value={f}>{f}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={() =>
            onPick(
              allVisiblePicked
                ? picked.filter((id) => !filtered.some((c) => c.id === id))
                : Array.from(new Set([...picked, ...filtered.map((c) => c.id)])),
            )
          }
          className="rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:border-primary/50"
        >
          {allVisiblePicked ? "Clear filtered" : `Add all filtered (${filtered.length})`}
        </button>
        <span className="ml-auto text-xs font-semibold text-primary">
          {picked.length} picked
        </span>
      </div>
      <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
        {visible.map((c) => {
          const isPicked = picked.includes(c.id)
          return (
            <button
              key={c.id}
              type="button"
              onClick={() =>
                onPick(isPicked ? picked.filter((id) => id !== c.id) : [...picked, c.id])
              }
              className="flex w-full items-center gap-3 bg-background px-3 py-2 text-left text-xs hover:bg-muted/50"
            >
              <span
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center rounded border",
                  isPicked ? "border-primary bg-primary text-primary-foreground" : "border-border",
                )}
              >
                {isPicked && <Check className="size-3" />}
              </span>
              <span className="font-mono font-medium">{c.name}</span>
              <span className="text-muted-foreground">{c.facts["Waste fractions"]}</span>
              <span className="text-muted-foreground">{c.facts["Container type"]}</span>
              <span className="ml-auto truncate text-muted-foreground">{c.facts.Address}</span>
            </button>
          )
        })}
        {visible.length === 0 && (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">
            No containers match the filters.
          </div>
        )}
      </div>
      {filtered.length > visible.length && (
        <div className="mt-1 text-[11px] text-muted-foreground">
          Showing {visible.length} of {filtered.length} — narrow with search, or add all filtered.
        </div>
      )}
    </div>
  )
}

function CreatedPanel({ draft, onClose }: { draft: SchemeDraft; onClose: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Check className="size-6" />
      </div>
      <div className="text-lg font-semibold">“{draft.name || "Untitled scheme"}” looks ready</div>
      <div className="max-w-md text-sm text-muted-foreground">
        {recurrenceSentence(draft)} ·{" "}
        {draft.sameAllDays
          ? `${draft.containerIds.length} containers every service day`
          : effectiveDayPlans(draft).map((p) => `${DAY_LABELS[p.day]} ${p.containerIds.length}`).join(" · ")}{" "}
        · prototype only, nothing was saved.
      </div>
      <button
        type="button"
        onClick={onClose}
        className="mt-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
      >
        Close prototype
      </button>
    </div>
  )
}

/* --------------- per-day containers step + route-map step ---------------- */

function ContainersStep(props: Pick<VariantProps, "draft" | "setDraft" | "containers">) {
  const { draft, setDraft } = props
  const days = sortedServiceDays(draft)
  const multiDay = days.length > 1
  const perDay = multiDay && !draft.sameAllDays
  const [activeDay, setActiveDay] = useState<DayKey>(days[0] ?? "monday")
  useEffect(() => {
    if (days.length > 0 && !days.includes(activeDay)) setActiveDay(days[0])
  }, [days, activeDay])

  const picked = perDay ? (draft.containersByDay[activeDay] ?? []) : draft.containerIds
  const onPick = (ids: string[]) =>
    perDay
      ? setDraft({ containersByDay: { ...draft.containersByDay, [activeDay]: ids } })
      : setDraft({ containerIds: ids })

  const enablePerDay = () => {
    const seeded = { ...draft.containersByDay }
    for (const d of days) if (!seeded[d]) seeded[d] = [...draft.containerIds]
    setDraft({ sameAllDays: false, containersByDay: seeded })
  }

  return (
    <div className="space-y-3">
      {multiDay && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setDraft({ sameAllDays: true })}
            className={cn(
              "rounded-md border px-3 py-1.5 text-xs font-medium",
              draft.sameAllDays
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:border-primary/50",
            )}
          >
            Same containers every day
          </button>
          <button
            type="button"
            onClick={enablePerDay}
            className={cn(
              "rounded-md border px-3 py-1.5 text-xs font-medium",
              !draft.sameAllDays
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:border-primary/50",
            )}
          >
            Different per day
          </button>
        </div>
      )}
      {perDay && (
        <div className="flex flex-wrap gap-1.5 border-b border-border pb-2">
          {days.map((d) => {
            const count = (draft.containersByDay[d] ?? []).length
            return (
              <button
                key={d}
                type="button"
                onClick={() => setActiveDay(d)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium",
                  d === activeDay ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
                )}
              >
                <span className="size-2 rounded-full" style={{ backgroundColor: DAY_COLORS[d] }} />
                {DAY_LABELS[d]}
                <span className={cn("font-mono", d === activeDay ? "opacity-80" : "")}>{count}</span>
              </button>
            )
          })}
        </div>
      )}
      {perDay && (
        <div className="text-xs text-muted-foreground">
          Picking the route for <span className="font-semibold text-foreground">{DAY_LABELS[activeDay]}</span> — each
          service day generates its own route with its own stops.
        </div>
      )}
      <ContainerPicker draft={draft} containers={props.containers} picked={picked} onPick={onPick} />
    </div>
  )
}

function RouteMapStep({ draft, containers }: Pick<VariantProps, "draft" | "containers">) {
  const plans = effectiveDayPlans(draft)
  const [focusDay, setFocusDay] = useState<DayKey | "all">("all")
  const shown = plans.filter((p) => focusDay === "all" || p.day === focusDay)
  return (
    <div className="space-y-3">
      {plans.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setFocusDay("all")}
            className={cn(
              "rounded-md px-3 py-1.5 text-xs font-medium",
              focusDay === "all" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
            )}
          >
            All days
          </button>
          {plans.map((p) => (
            <button
              key={p.day}
              type="button"
              onClick={() => setFocusDay(p.day)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium",
                focusDay === p.day ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
              )}
            >
              <span className="size-2 rounded-full" style={{ backgroundColor: DAY_COLORS[p.day] }} />
              {DAY_LABELS[p.day]}
            </button>
          ))}
        </div>
      )}
      <div className="relative overflow-hidden rounded-md border border-border">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/route-map-copenhagen.png"
          alt="Copenhagen route map"
          className="h-[320px] w-full object-cover opacity-45 grayscale dark:opacity-30"
        />
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
          {shown.map((p) => {
            const pts = p.containerIds.map((id) => pseudoPos(id))
            const color = DAY_COLORS[p.day]
            return (
              <g key={p.day}>
                {pts.length > 1 && (
                  <polyline
                    points={pts.map((pt) => `${pt.x},${pt.y}`).join(" ")}
                    fill="none"
                    stroke={color}
                    strokeWidth="0.55"
                    opacity="0.9"
                  />
                )}
                {pts.map((pt, i) => (
                  <circle key={i} cx={pt.x} cy={pt.y} r="1.1" fill={color} stroke="#fff" strokeWidth="0.35" />
                ))}
              </g>
            )
          })}
        </svg>
        <div className="absolute bottom-2 right-2 rounded bg-background/90 px-2 py-1 text-[10px] text-muted-foreground">
          Pin positions are illustrative — stop order follows the picked order.
        </div>
      </div>
      <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
        {plans.map((p) => (
          <div key={p.day} className="flex items-center gap-3 px-3 py-2 text-xs">
            <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: DAY_COLORS[p.day] }} />
            <span className="w-10 font-semibold">{DAY_LABELS[p.day]}</span>
            <span className="font-mono">{p.containerIds.length} stops</span>
            <span className="truncate text-muted-foreground">{fractionSummary(p.containerIds, containers)}</span>
          </div>
        ))}
        {plans.length === 0 && (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">Pick service days first.</div>
        )}
      </div>
    </div>
  )
}

/* ------------------------- Variant A — stepper -------------------------- */

const A_STEPS = ["Scheme & scope", "Recurrence", "Assignment", "Containers", "Route map", "Review & create"]

function VariantAStepper(props: VariantProps) {
  const { draft, setDraft, vehicles, drivers, onClose } = props
  const [step, setStep] = useState(0)
  const [maxStepReached, setMaxStepReached] = useState(0)
  const [created, setCreated] = useState(false)
  const goTo = (s: number) => { setStep(s); setMaxStepReached((m) => Math.max(m, s)) }
  const issues = draftIssues(draft)

  return (
    <Overlay onClose={onClose} width="max-w-[900px]">
      <div className="flex min-h-[540px]">
        <div className="w-56 shrink-0 border-r border-border p-6">
          <div className="mb-4 text-sm font-semibold">New route scheme</div>
          <Stepper currentStep={step} steps={A_STEPS} onStepClick={goTo} maxStepReached={maxStepReached} />
        </div>
        <div className="flex flex-1 flex-col p-6">
          {created ? (
            <CreatedPanel draft={draft} onClose={onClose} />
          ) : (
            <>
              <div className="mb-4 text-lg font-semibold">{A_STEPS[step]}</div>
              <div className="flex-1 space-y-5 overflow-y-auto pr-1">
                {step === 0 && (
                  <>
                    <div>
                      <FieldLabel>Scheme name</FieldLabel>
                      <input
                        value={draft.name}
                        onChange={(e) => setDraft({ name: e.target.value })}
                        placeholder="e.g. Sunday glass collection"
                        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <FieldLabel>Project</FieldLabel>
                      <SelectField
                        value={draft.project}
                        onChange={(v) => setDraft({ project: v, containerIds: [], containersByDay: {} })}
                        options={[
                          { id: "Copenhagen Central", label: "Copenhagen Central" },
                          { id: "Harbor Commercial", label: "Harbor Commercial" },
                        ]}
                        placeholder="Select project"
                      />
                    </div>
                  </>
                )}
                {step === 1 && (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <FieldLabel>Effective from</FieldLabel>
                        <input
                          type="date"
                          value={draft.effectiveFrom}
                          onChange={(e) => setDraft({ effectiveFrom: e.target.value })}
                          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                        />
                      </div>
                      <div>
                        <FieldLabel>Effective to</FieldLabel>
                        <input
                          type="date"
                          value={draft.effectiveTo}
                          min={draft.effectiveFrom || undefined}
                          onChange={(e) => setDraft({ effectiveTo: e.target.value })}
                          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                        />
                      </div>
                    </div>
                    <div>
                      <FieldLabel>Frequency</FieldLabel>
                      <FrequencyToggles draft={draft} setDraft={setDraft} />
                    </div>
                    <div>
                      <FieldLabel>Service days</FieldLabel>
                      <DayToggles draft={draft} setDraft={setDraft} size="lg" />
                    </div>
                    <div>
                      <FieldLabel>Planned start time</FieldLabel>
                      <input
                        type="time"
                        value={draft.startTime}
                        onChange={(e) => setDraft({ startTime: e.target.value })}
                        className="w-32 rounded-md border border-border bg-background px-3 py-2 text-sm"
                      />
                    </div>
                    <div className="rounded-md border border-border bg-muted/40 p-3">
                      <FieldLabel>Next dates</FieldLabel>
                      <DatePreview draft={draft} count={8} />
                    </div>
                  </>
                )}
                {step === 2 && (
                  <>
                    <div>
                      <FieldLabel>Default vehicle</FieldLabel>
                      <SelectField
                        value={draft.vehicleId}
                        onChange={(v) => setDraft({ vehicleId: v })}
                        options={vehicles.map((v) => ({ id: v.id, label: v.name }))}
                        placeholder="Select vehicle"
                      />
                    </div>
                    <div>
                      <FieldLabel>Default driver</FieldLabel>
                      <SelectField
                        value={draft.driverId}
                        onChange={(v) => setDraft({ driverId: v })}
                        options={drivers.map((d) => ({ id: d.id, label: d.name }))}
                        placeholder="Select driver"
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Defaults only — every generated route can be reassigned individually.
                    </p>
                  </>
                )}
                {step === 3 && <ContainersStep {...props} />}
                {step === 4 && <RouteMapStep draft={draft} containers={props.containers} />}
                {step === 5 && (
                  <div className="space-y-3">
                    {[
                      ["Scheme", `${draft.name || "Untitled"} · ${draft.project}`, 0],
                      ["Recurrence", `${recurrenceSentence(draft)} · ${draft.effectiveFrom || "no start"} → ${draft.effectiveTo || "no end"} · starts ${draft.startTime}`, 1],
                      ["Assignment", `${vehicles.find((v) => v.id === draft.vehicleId)?.name ?? "No vehicle"} · ${drivers.find((d) => d.id === draft.driverId)?.name ?? "No driver"}`, 2],
                      [
                        "Containers",
                        draft.sameAllDays
                          ? `${draft.containerIds.length} picked · same every day`
                          : effectiveDayPlans(draft).map((p) => `${DAY_LABELS[p.day]} ${p.containerIds.length}`).join(" · "),
                        3,
                      ],
                    ].map(([label, value, target]) => (
                      <div key={label as string} className="flex items-center justify-between rounded-md border border-border p-3 text-sm">
                        <div>
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
                          <div>{value}</div>
                        </div>
                        <button type="button" onClick={() => goTo(target as number)} className="text-xs font-medium text-primary">
                          Edit
                        </button>
                      </div>
                    ))}
                    {issues.length > 0 && (
                      <div className="rounded-md border border-amber-300/60 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
                        {issues.join(" · ")}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className="mt-5 flex justify-between border-t border-border pt-4">
                <button
                  type="button"
                  onClick={() => (step === 0 ? onClose() : setStep(step - 1))}
                  className="rounded-md border border-border px-4 py-2 text-sm font-medium"
                >
                  {step === 0 ? "Cancel" : "Back"}
                </button>
                {step < 5 ? (
                  <button
                    type="button"
                    onClick={() => goTo(step + 1)}
                    className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
                  >
                    Next
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={issues.length > 0}
                    onClick={() => setCreated(true)}
                    className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                  >
                    Create scheme
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </Overlay>
  )
}

/* ---------------------- Variant B — single-page form --------------------- */

function VariantBFlatForm(props: VariantProps) {
  const { draft, setDraft, vehicles, drivers, onClose } = props
  const [created, setCreated] = useState(false)
  const issues = draftIssues(draft)

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50 backdrop-blur-sm">
      <div className="flex h-full w-full max-w-[860px] flex-col overflow-hidden border-l border-border bg-background shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div>
            <div className="text-base font-semibold">New route scheme</div>
            <div className="text-xs text-muted-foreground">Everything on one page — fill in any order.</div>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted">
            <X className="size-4" />
          </button>
        </div>
        {created ? (
          <CreatedPanel draft={draft} onClose={onClose} />
        ) : (
          <div className="flex min-h-0 flex-1">
            <div className="min-w-0 flex-1 space-y-7 overflow-y-auto p-6">
              <section>
                <h3 className="mb-3 text-sm font-semibold">Scheme & scope</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <FieldLabel>Name</FieldLabel>
                    <input
                      value={draft.name}
                      onChange={(e) => setDraft({ name: e.target.value })}
                      placeholder="e.g. Sunday glass collection"
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <FieldLabel>Project</FieldLabel>
                    <SelectField
                      value={draft.project}
                      onChange={(v) => setDraft({ project: v, containerIds: [], containersByDay: {} })}
                      options={[
                        { id: "Copenhagen Central", label: "Copenhagen Central" },
                        { id: "Harbor Commercial", label: "Harbor Commercial" },
                      ]}
                      placeholder="Select project"
                    />
                  </div>
                </div>
              </section>
              <section>
                <h3 className="mb-3 text-sm font-semibold">Recurrence</h3>
                <div className="space-y-3">
                  <FrequencyToggles draft={draft} setDraft={setDraft} />
                  <DayToggles draft={draft} setDraft={setDraft} />
                </div>
              </section>
              <section>
                <h3 className="mb-3 text-sm font-semibold">Default assignment</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <FieldLabel>Vehicle</FieldLabel>
                    <SelectField
                      value={draft.vehicleId}
                      onChange={(v) => setDraft({ vehicleId: v })}
                      options={vehicles.map((v) => ({ id: v.id, label: v.name }))}
                      placeholder="Select vehicle"
                    />
                  </div>
                  <div>
                    <FieldLabel>Driver</FieldLabel>
                    <SelectField
                      value={draft.driverId}
                      onChange={(v) => setDraft({ driverId: v })}
                      options={drivers.map((d) => ({ id: d.id, label: d.name }))}
                      placeholder="Select driver"
                    />
                  </div>
                </div>
              </section>
              <section>
                <h3 className="mb-3 text-sm font-semibold">Containers</h3>
                <ContainerPicker
                  draft={draft}
                  containers={props.containers}
                  picked={draft.containerIds}
                  onPick={(ids) => setDraft({ containerIds: ids })}
                />
              </section>
            </div>
            <aside className="hidden w-72 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border bg-muted/30 p-5 lg:flex">
              <div>
                <FieldLabel>Live summary</FieldLabel>
                <div className="text-sm font-medium">{draft.name || "Untitled scheme"}</div>
                <div className="text-xs text-muted-foreground">{recurrenceSentence(draft)}</div>
              </div>
              <div>
                <FieldLabel>Next dates</FieldLabel>
                <DatePreview draft={draft} count={6} />
              </div>
              <div>
                <FieldLabel>Readiness</FieldLabel>
                <ul className="space-y-1.5 text-xs">
                  {issues.length === 0 ? (
                    <li className="font-medium text-primary">All checks pass — ready to create.</li>
                  ) : (
                    issues.map((i) => (
                      <li key={i} className="text-muted-foreground">○ {i}</li>
                    ))
                  )}
                </ul>
              </div>
              <button
                type="button"
                disabled={issues.length > 0}
                onClick={() => setCreated(true)}
                className="mt-auto rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                Create scheme
              </button>
            </aside>
          </div>
        )}
      </div>
    </div>
  )
}

/* ---------------------- Variant C — calendar-first ----------------------- */

function MonthGrid({ year, month, draft }: { year: number; month: number; draft: SchemeDraft }) {
  const first = new Date(year, month, 1)
  const label = first.toLocaleDateString("en-GB", { month: "long", year: "numeric" })
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const leading = (first.getDay() + 6) % 7
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const cells: (Date | null)[] = [
    ...Array.from({ length: leading }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => new Date(year, month, i + 1)),
  ]
  return (
    <div>
      <div className="mb-2 text-sm font-semibold">{label}</div>
      <div className="grid grid-cols-7 gap-1 text-center">
        {DAY_KEYS.map((d) => (
          <div key={d} className="pb-1 text-[10px] font-semibold uppercase text-muted-foreground">
            {DAY_LABELS[d][0]}
          </div>
        ))}
        {cells.map((d, i) => {
          if (!d) return <div key={`x${i}`} />
          const hit = d >= today && matchesDraft(d, draft)
          return (
            <div
              key={d.toISOString()}
              className={cn(
                "flex size-8 items-center justify-center rounded-full text-xs",
                hit ? "bg-primary font-semibold text-primary-foreground" : d < today ? "text-muted-foreground/40" : "text-foreground",
              )}
            >
              {d.getDate()}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function VariantCCalendarFirst(props: VariantProps) {
  const { draft, setDraft, vehicles, drivers, onClose } = props
  const [created, setCreated] = useState(false)
  const issues = draftIssues(draft)
  const now = new Date()
  const upcoming = nextServiceDates(draft, 3)

  return (
    <Overlay onClose={onClose} width="max-w-[1060px]">
      {created ? (
        <CreatedPanel draft={draft} onClose={onClose} />
      ) : (
        <div className="flex max-h-[80vh] min-h-[560px] flex-col">
          <div className="border-b border-border px-6 py-4">
            <div className="text-base font-semibold">New route scheme — pick the rhythm first</div>
            <div className="text-xs text-muted-foreground">
              Toggle days and frequency; the calendar shows exactly which dates will get a route.
            </div>
          </div>
          <div className="flex min-h-0 flex-1">
            <div className="min-w-0 flex-[3] overflow-y-auto p-6">
              <div className="mb-4 flex flex-wrap items-center gap-4">
                <FrequencyToggles draft={draft} setDraft={setDraft} />
                <DayToggles draft={draft} setDraft={setDraft} />
              </div>
              <div className="grid gap-8 sm:grid-cols-2">
                <MonthGrid year={now.getFullYear()} month={now.getMonth()} draft={draft} />
                <MonthGrid
                  year={now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear()}
                  month={(now.getMonth() + 1) % 12}
                  draft={draft}
                />
              </div>
              <div className="mt-5 rounded-md border border-border bg-muted/40 p-3 text-sm">
                <span className="font-medium">{recurrenceSentence(draft)}.</span>{" "}
                <span className="text-muted-foreground">
                  {upcoming.length > 0
                    ? `First routes: ${upcoming.map(fmtDate).join(" · ")}.`
                    : "Pick at least one service day."}
                </span>
              </div>
            </div>
            <aside className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border bg-muted/30 p-5">
              <div>
                <FieldLabel>Scheme name</FieldLabel>
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ name: e.target.value })}
                  placeholder="e.g. Sunday glass collection"
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
              </div>
              <div>
                <FieldLabel>Project</FieldLabel>
                <SelectField
                  value={draft.project}
                  onChange={(v) => setDraft({ project: v, containerIds: [], containersByDay: {} })}
                  options={[
                    { id: "Copenhagen Central", label: "Copenhagen Central" },
                    { id: "Harbor Commercial", label: "Harbor Commercial" },
                  ]}
                  placeholder="Select project"
                />
              </div>
              <div>
                <FieldLabel>Default vehicle</FieldLabel>
                <SelectField
                  value={draft.vehicleId}
                  onChange={(v) => setDraft({ vehicleId: v })}
                  options={vehicles.map((v) => ({ id: v.id, label: v.name }))}
                  placeholder="Select vehicle"
                />
              </div>
              <div>
                <FieldLabel>Default driver</FieldLabel>
                <SelectField
                  value={draft.driverId}
                  onChange={(v) => setDraft({ driverId: v })}
                  options={drivers.map((d) => ({ id: d.id, label: d.name }))}
                  placeholder="Select driver"
                />
              </div>
              <div>
                <FieldLabel>Containers</FieldLabel>
                <ContainerPicker
                  draft={draft}
                  containers={props.containers}
                  picked={draft.containerIds}
                  onPick={(ids) => setDraft({ containerIds: ids })}
                  compact
                />
              </div>
              <button
                type="button"
                disabled={issues.length > 0}
                onClick={() => setCreated(true)}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                Create scheme
              </button>
              {issues.length > 0 && (
                <div className="text-[11px] text-muted-foreground">{issues.join(" · ")}</div>
              )}
            </aside>
          </div>
        </div>
      )}
    </Overlay>
  )
}

/* ------------------------------- chrome ---------------------------------- */

function Overlay({ children, onClose, width }: { children: React.ReactNode; onClose: () => void; width: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className={cn("relative w-full overflow-hidden rounded-[20px] border border-border bg-background shadow-2xl", width)}>
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 z-10 rounded-md p-1.5 text-muted-foreground hover:bg-muted"
        >
          <X className="size-4" />
        </button>
        {children}
      </div>
    </div>
  )
}

const VARIANTS = [
  { key: "A", name: "Guided stepper" },
  { key: "B", name: "Single-page form" },
  { key: "C", name: "Calendar-first" },
] as const

export function SchemeWizardPrototype() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const variant = (searchParams.get("variant") ?? "").toUpperCase()

  const [draft, setDraftState] = useState<SchemeDraft>(INITIAL_DRAFT)
  const setDraft = (patch: Partial<SchemeDraft>) => setDraftState((d) => ({ ...d, ...patch }))

  const containers = useMemo(
    () => moduleRecords("resources", "containers").filter((c) => c.facts.Project && c.facts.Project !== "—"),
    [],
  )
  const vehicles = useMemo(
    () => moduleRecords("fleet", "vehicles").filter((v) => !v.id.startsWith("trailer-")),
    [],
  )
  const drivers = useMemo(() => moduleRecords("fleet", "drivers"), [])

  const setVariant = (key: string | null) => {
    const params = new URLSearchParams(searchParams.toString())
    if (key) params.set("variant", key)
    else params.delete("variant")
    router.replace(`${pathname}?${params.toString()}`)
  }
  const idx = VARIANTS.findIndex((v) => v.key === variant)
  const cycle = (dir: 1 | -1) => setVariant(VARIANTS[(idx + dir + VARIANTS.length) % VARIANTS.length].key)

  useEffect(() => {
    if (idx === -1) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return
      if (e.key === "ArrowLeft") cycle(-1)
      if (e.key === "ArrowRight") cycle(1)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, searchParams])

  if (process.env.NODE_ENV === "production" || idx === -1) return null

  const props: VariantProps = { draft, setDraft, containers, vehicles, drivers, onClose: () => setVariant(null) }

  return (
    <>
      {variant === "A" && <VariantAStepper {...props} />}
      {variant === "B" && <VariantBFlatForm {...props} />}
      {variant === "C" && <VariantCCalendarFirst {...props} />}
      <div className="fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-1 rounded-full border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-zinc-100 shadow-xl">
        <button type="button" onClick={() => cycle(-1)} className="rounded-full p-1.5 hover:bg-zinc-700" aria-label="Previous variant">
          <ArrowLeft className="size-4" />
        </button>
        <span className="min-w-44 px-2 text-center font-mono text-xs">
          PROTOTYPE · {variant} — {VARIANTS[idx].name}
        </span>
        <button type="button" onClick={() => cycle(1)} className="rounded-full p-1.5 hover:bg-zinc-700" aria-label="Next variant">
          <ArrowRight className="size-4" />
        </button>
      </div>
    </>
  )
}
