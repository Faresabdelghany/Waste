"use client"
// A property's notification zones in its details (O29 of #290, row 1.13):
// the Planning Areas of purpose `notification` its point lies in today,
// re-read when the point moves. The sentences are lib/data/property-zones.ts'.
import { useApiSession } from "@/components/waste/api-session-store"
import { useRowHistory } from "@/components/waste/commands/use-command-support"
import type { BusinessRecord, ModuleLocation } from "@/lib/data/business-modules"
import { propertyZones, zonesReadable, zonesSentence } from "@/lib/data/property-zones"

export function PropertyZonesSection({ record, module }: { record: BusinessRecord; module: ModuleLocation }) {
  const { me } = useApiSession()
  const readable = zonesReadable(me?.role.grants)
  const point = record.facts.Coordinates ?? ""
  const zones = useRowHistory(module.workspaceId, module.moduleId, record, readable ? `read|${point}` : "not-granted", readable ? propertyZones : NO_ZONES)
  const read = zones.rows?.[0] ?? null

  return (
    <section className="space-y-2" data-testid="property-zones" aria-label="Notification zones">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Notification zones</h3>
      <p className="text-sm text-muted-foreground">
        {!readable
          ? "The notification zones are not shown to your role."
          : zones.problem !== null
            ? `The notification zones could not be read from the API: ${zones.problem}`
            : read === null
              ? "Reading the notification zones from the API…"
              : zonesSentence(read, point !== "")}
      </p>
    </section>
  )
}

const NO_ZONES = async () => []
