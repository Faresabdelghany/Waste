"use client"

// Route map preview for Route Schemes (spec FR-15, tickets #6/#17): one route
// line per DISTINCT day route — days sharing an identical stop list (the
// sameAllDays default) fold into a single line, pin set, and legend row
// labeled with all their days, so exact copies never stack and hide each
// other. Distinct routes keep per-day colors; a stop shared between distinct
// routes renders one neutral pin. All days / per-day filter on top. Rendered
// by the Guided Setup wizard's Route map step.

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
  groupIdenticalDayPlans,
  schemeMapPins,
  type SchemeMapDayGroup,
  type SchemeMapPlan,
} from "@/lib/route-schemes/map"
import {
  SERVICE_DAY_SHORT_LABELS,
  sortServiceDays,
  type ServiceDay,
} from "@/lib/route-schemes/recurrence"
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

function groupDaysLabel(group: SchemeMapDayGroup): string {
  const days = group.days.map((day) => SERVICE_DAY_SHORT_LABELS[day]).join(", ")
  return group.label ? `${group.label} · ${days}` : days
}

export function SchemeRouteMap({
  plans,
  containers,
}: {
  /** One entry per generated route (per collection group per day). */
  plans: readonly SchemeMapPlan[]
  containers: readonly BusinessRecord[]
}) {
  const [focusDay, setFocusDay] = useState<ServiceDay | "all">("all")
  const shownPlans = plans.filter(
    (plan) => focusDay === "all" || plan.day === focusDay,
  )
  const shownGroups = groupIdenticalDayPlans(shownPlans)
  const pins = schemeMapPins(shownGroups)
  const legendGroups = groupIdenticalDayPlans(plans)
  const days = sortServiceDays(Array.from(new Set(plans.map((plan) => plan.day))))

  return (
    <div className="space-y-3">
      {days.length > 1 && (
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
          {days.map((day) => (
            <button
              key={day}
              type="button"
              onClick={() => setFocusDay(day)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                focusDay === day
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: SCHEME_DAY_COLORS[day] }}
              />
              {SERVICE_DAY_SHORT_LABELS[day]}
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
          {shownGroups.map((group) => {
            const linePoints = dayPolylinePoints(group.containerIds)
            if (!linePoints) return null
            return (
              <polyline
                key={`${group.label ?? ""}-${group.days.join("-")}`}
                points={linePoints}
                fill="none"
                stroke={group.color}
                strokeWidth="1.75"
                vectorEffect="non-scaling-stroke"
                opacity="0.9"
              />
            )
          })}
        </svg>
        {pins.map((pin) => (
          <span
            key={pin.containerId}
            title={pin.days.map((day) => SERVICE_DAY_SHORT_LABELS[day]).join(", ")}
            className={cn(
              "absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background",
              pin.color === null && "bg-foreground",
            )}
            style={{
              left: `${(pin.x / MAP_VIEWBOX.width) * 100}%`,
              top: `${(pin.y / MAP_VIEWBOX.height) * 100}%`,
              ...(pin.color === null ? {} : { backgroundColor: pin.color }),
            }}
          />
        ))}
        <div className="absolute bottom-2 right-2 rounded bg-background/90 px-2 py-1 text-[10px] text-muted-foreground">
          Pin positions are illustrative — stop order follows the picked order.
        </div>
      </div>

      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border/60">
        {legendGroups.map((group) => (
          <div
            key={`${group.label ?? ""}-${group.days.join("-")}`}
            className="flex items-center gap-3 px-3 py-2 text-xs"
          >
            <span
              className="size-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: group.color }}
            />
            <span className="min-w-10 shrink-0 truncate font-semibold">
              {groupDaysLabel(group)}
            </span>
            <span className="shrink-0 font-mono">
              {group.containerIds.length} stop
              {group.containerIds.length === 1 ? "" : "s"}
            </span>
            <span className="truncate text-muted-foreground">
              {fractionMix(group.containerIds, containers)}
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
