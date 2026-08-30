"use client"

// Scheme detail section for declarative stop matching (issue #19): shows the
// rule a rule-mode scheme stores (fractions + vehicle type per service day,
// inside its planning area) and the containers it currently resolves to —
// live against the record store, so a container added to the area shows up
// here (and in the next generation) without editing the scheme. Renders
// nothing for manual-mode schemes.

import { useModuleRecords } from "@/components/wastehero/scheme-route-map"
import type { BusinessRecord } from "@/lib/data/business-modules"
import {
  effectiveDayRules,
  matchPlansFromValues,
  resolveStopMatches,
  stopRuleSummary,
  stopSelectionMode,
} from "@/lib/route-schemes/matching"
import {
  SERVICE_DAY_SHORT_LABELS,
  serviceDaysFromValues,
} from "@/lib/route-schemes/recurrence"
import { stringValue } from "@/lib/route-schemes/validation"

export function SchemeStopMatchingSection({ record }: { record: BusinessRecord }) {
  const containers = useModuleRecords("resources", "containers")
  const areas = useModuleRecords("plan", "areas")

  if (stopSelectionMode(record.submittedValues) !== "rule") return null

  const values = record.submittedValues ?? {}
  const serviceDays = serviceDaysFromValues(values)
  if (serviceDays.length === 0) return null

  const areaId = stringValue(values, "planningAreaId")
  const areaName = areas.find((area) => area.id === areaId)?.name
  const plans = matchPlansFromValues(values)
  const dayRules = effectiveDayRules(serviceDays, plans)
  const dayResults = dayRules.map(({ day, rule }) => ({
    day,
    rule,
    result: resolveStopMatches({
      rule,
      areaId,
      projectIds: record.projectIds,
      containers,
    }),
  }))
  // With one shared rule every day resolves identically — render it once.
  const shownResults = plans.sameAllDays ? dayResults.slice(0, 1) : dayResults

  return (
    <section className="space-y-4">
      <h3 className="text-sm font-semibold">Matched stops</h3>
      <p className="text-xs text-muted-foreground">
        This scheme matches its stops by rule
        {areaName ? (
          <>
            {" "}
            inside <span className="font-medium text-foreground">{areaName}</span>
          </>
        ) : null}
        . The list below is resolved live — generation picks up newly matching
        containers without editing the scheme.
      </p>
      {!areaId && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          No planning area is set on this scheme — the rule cannot match any
          containers until one is.
        </p>
      )}
      <div className="space-y-3">
        {shownResults.map(({ day, rule, result }) => (
          <div
            key={day}
            className="space-y-2 rounded-xl border border-border/60 p-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-semibold text-foreground">
                {plans.sameAllDays ? "Every service day" : SERVICE_DAY_SHORT_LABELS[day]}
                <span className="ml-2 font-normal text-muted-foreground">
                  {stopRuleSummary(rule)}
                </span>
              </span>
              <span className="font-mono text-muted-foreground">
                {result.matched.length} matching
              </span>
            </div>
            {result.matched.length === 0 ? (
              <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                No containers currently match — generated routes for this day
                would have no stops.
              </p>
            ) : (
              <ul className="max-h-40 space-y-1 overflow-y-auto pr-1 text-xs">
                {result.matched.map((profile) => {
                  const container = containers.find(
                    (candidate) => candidate.id === profile.id,
                  )
                  return (
                    <li key={profile.id} className="flex items-baseline gap-2">
                      <span className="font-medium text-foreground">
                        {profile.name}
                      </span>
                      <span className="truncate text-muted-foreground">
                        {profile.fractions.join(" · ")}
                        {profile.containerType ? ` · ${profile.containerType}` : ""}
                        {container?.facts?.Address
                          ? ` · ${container.facts.Address}`
                          : ""}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
            {result.excluded.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {result.excluded.length} matching-fraction container
                {result.excluded.length === 1 ? "" : "s"} excluded:{" "}
                {result.excluded
                  .slice(0, 3)
                  .map((exclusion) => `${exclusion.name} (${exclusion.reason})`)
                  .join(", ")}
                {result.excluded.length > 3
                  ? ` and ${result.excluded.length - 3} more`
                  : ""}
              </p>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
