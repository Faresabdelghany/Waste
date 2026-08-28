"use client"

// Route map preview for Route Schemes (spec FR-15, ticket #6): one route line
// per service day in its stable day color, a pin per stop, an All days /
// per-day filter, and a legend row per day (stops + fraction mix). Rendered by
// the Guided Setup wizard's Route map step and by the scheme detail view.

import { useState } from "react"

import { useBusinessRecordStore } from "@/components/wastehero/business-record-store"
import {
  businessWorkspaces,
  type BusinessRecord,
  type WorkspaceId,
} from "@/lib/data/business-modules"
import {
  MAP_VIEWBOX,
  SCHEME_DAY_COLORS,
  dayPolylinePoints,
  stopPosition,
} from "@/lib/route-schemes/map"
import {
  SERVICE_DAY_SHORT_LABELS,
  parseServiceDays,
  type ServiceDay,
} from "@/lib/route-schemes/recurrence"
import {
  dayPlansFromValues,
  effectiveDayPlans,
  type SchemeDayPlan,
} from "@/lib/route-schemes/validation"
import { cn } from "@/lib/utils"

/** Store-merged records of one module — fixtures plus user-created. */
export function useModuleRecords(workspaceId: WorkspaceId, moduleId: string) {
  const { getRecords } = useBusinessRecordStore()
  const fixtureRecords =
    businessWorkspaces[workspaceId]?.modules.find(
      (candidate) => candidate.id === moduleId,
    )?.records ?? []
  return getRecords(workspaceId, moduleId, fixtureRecords)
}

function fractionMix(
  containerIds: readonly string[],
  containers: readonly BusinessRecord[],
): string {
  const counts = new Map<string, number>()
  for (const id of containerIds) {
    const fraction = containers.find((container) => container.id === id)?.facts?.[
      "Waste fractions"
    ]
    if (fraction) counts.set(fraction, (counts.get(fraction) ?? 0) + 1)
  }
  return (
    Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([fraction, count]) => `${count} ${fraction}`)
      .join(" · ") || "No containers"
  )
}

export function SchemeRouteMap({
  plans,
  containers,
}: {
  plans: readonly SchemeDayPlan[]
  containers: readonly BusinessRecord[]
}) {
  const [focusDay, setFocusDay] = useState<ServiceDay | "all">("all")
  const shownPlans = plans.filter(
    (plan) => focusDay === "all" || plan.day === focusDay,
  )

  return (
    <div className="space-y-3">
      {plans.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setFocusDay("all")}
            className={cn(
              "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              focusDay === "all"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            All days
          </button>
          {plans.map((plan) => (
            <button
              key={plan.day}
              type="button"
              onClick={() => setFocusDay(plan.day)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                focusDay === plan.day
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: SCHEME_DAY_COLORS[plan.day] }}
              />
              {SERVICE_DAY_SHORT_LABELS[plan.day]}
            </button>
          ))}
        </div>
      )}

      <div className="relative overflow-hidden rounded-xl border border-border">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/route-map-copenhagen.png"
          alt="Copenhagen route map"
          className="h-[320px] w-full object-cover opacity-45 grayscale dark:opacity-30"
        />
        {/* The viewBox is stretched to fill the container, so lines use
            non-scaling strokes and pins are screen-space HTML dots — both
            would otherwise deform with the container's aspect ratio. */}
        <svg
          viewBox={`0 0 ${MAP_VIEWBOX.width} ${MAP_VIEWBOX.height}`}
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
        >
          {shownPlans.map((plan) => {
            const linePoints = dayPolylinePoints(plan.containerIds)
            if (!linePoints) return null
            return (
              <polyline
                key={plan.day}
                points={linePoints}
                fill="none"
                stroke={SCHEME_DAY_COLORS[plan.day]}
                strokeWidth="1.75"
                vectorEffect="non-scaling-stroke"
                opacity="0.9"
              />
            )
          })}
        </svg>
        {shownPlans.map((plan) =>
          plan.containerIds.map((containerId, index) => {
            const { x, y } = stopPosition(containerId)
            return (
              <span
                key={`${plan.day}-${containerId}-${index}`}
                className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background"
                style={{
                  left: `${(x / MAP_VIEWBOX.width) * 100}%`,
                  top: `${(y / MAP_VIEWBOX.height) * 100}%`,
                  backgroundColor: SCHEME_DAY_COLORS[plan.day],
                }}
              />
            )
          }),
        )}
        <div className="absolute bottom-2 right-2 rounded bg-background/90 px-2 py-1 text-[10px] text-muted-foreground">
          Pin positions are illustrative — stop order follows the picked order.
        </div>
      </div>

      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border/60">
        {plans.map((plan) => (
          <div key={plan.day} className="flex items-center gap-3 px-3 py-2 text-xs">
            <span
              className="size-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: SCHEME_DAY_COLORS[plan.day] }}
            />
            <span className="w-10 font-semibold">
              {SERVICE_DAY_SHORT_LABELS[plan.day]}
            </span>
            <span className="font-mono">
              {plan.containerIds.length} stop
              {plan.containerIds.length === 1 ? "" : "s"}
            </span>
            <span className="truncate text-muted-foreground">
              {fractionMix(plan.containerIds, containers)}
            </span>
          </div>
        ))}
        {plans.length === 0 && (
          <p className="px-3 py-4 text-center text-xs text-muted-foreground">
            Pick service days first.
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * The same map as a scheme detail section, reading the record's service days
 * and per-day plans back from submittedValues. Renders nothing for schemes
 * without structured service days (legacy free-text fixtures).
 */
export function SchemeRecordRouteMapSection({ record }: { record: BusinessRecord }) {
  const { getRecords } = useBusinessRecordStore()
  const containersModule = businessWorkspaces.resources?.modules.find(
    (module) => module.id === "containers",
  )
  const containers = getRecords(
    "resources",
    "containers",
    containersModule?.records ?? [],
  )

  const serviceDays = parseServiceDays(
    typeof record.submittedValues?.serviceDays === "string"
      ? record.submittedValues.serviceDays
      : "",
  )
  if (serviceDays.length === 0) return null

  const plans = effectiveDayPlans(
    serviceDays,
    dayPlansFromValues(record.submittedValues),
  )
  return (
    <section className="space-y-4">
      <h3 className="text-sm font-semibold">Route map</h3>
      <SchemeRouteMap plans={plans} containers={containers} />
    </section>
  )
}
