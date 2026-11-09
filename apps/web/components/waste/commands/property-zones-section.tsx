"use client"
// A property's notification zones in its details (O29 of #290, row 1.13):
// the Planning Areas of purpose `notification` its point lies in today,
// re-read when the point moves. The sentences are lib/data/property-zones.ts'.
import { useRowHistory } from "@/components/platform/use-command-support"
import type { BusinessRecord, ModuleLocation } from "@/lib/data/business-modules"
import { zonesReadable, zonesSentence } from "@/lib/data/property-zones"
import { propertyZones } from "@/lib/api/property-details"
import { readSentence } from "@/lib/api/read-state"
import { useGrants } from "@/components/platform/use-grants"

export function PropertyZonesSection({ record, module }: { record: BusinessRecord; module: ModuleLocation }) {
  const grants = useGrants()
  const readable = zonesReadable(grants)
  const point = record.facts.Coordinates ?? ""
  const zones = useRowHistory(module.workspaceId, module.moduleId, record, readable ? `read|${point}` : "not-granted", readable ? propertyZones : NO_ZONES)
  const read = zones.rows?.[0] ?? null

  return (
    <section className="space-y-2" data-testid="property-zones" aria-label="Notification zones">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Notification zones</h3>
      <p className="text-sm text-muted-foreground">
        {readSentence({ viewed: readable, problem: zones.problem, answered: read !== null }, "notification zones") ?? (read === null ? null : zonesSentence(read, point !== ""))}
      </p>
    </section>
  )
}

const NO_ZONES = async () => []
