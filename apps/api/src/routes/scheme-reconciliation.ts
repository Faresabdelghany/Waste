// The cadence against the promise (O22 of #290, #290 row 2.10): what a Route
// Scheme reads as when the containers it collects were promised another
// service frequency. A warning and never a refusal, so it is a reading on the
// resource, `warnings`, which every read and every write answer carries
// (routes/scheme-groups.ts `schemesOf`): a write that leaves the scheme
// out of step with its agreements still succeeds and says so.
//
// The containers are the ones the scheme collects as the API knows them: a
// manual group's picks, and a rule group's latest match stamp — the set the
// last generation run matched, since the matcher is the worker's
// (`st_contains` on the boundary in force) — so a rule group no run has
// matched lends no container yet. Each container is collected on its groups'
// days, a parked group's none, which is how a weekly scheme serving a
// container Mon and Thu keeps a twice-a-week promise.
//
// The promise is the placement's: its `service_frequency` override, or its
// subscription's product's, the coalesce routes/containers.ts answers as
// `effectiveServiceFrequencyId`, read on the day the scheme is judged from —
// the day its period starts or today on the project's clock, whichever is
// later, and its last day in force for a scheme that has ended. The cadence
// is the one in force on that day: a season's (O17 of #290, `cadenceOn`) or
// the scheme's own. The interval
// is turned into collections per week by
// @waste/domain/service-frequencies `intervalCollectionsPerWeek` and the
// sentences are @waste/domain/route-schemes/validation's, the ones the
// browser's preview prints, so a warning reads the same wherever it is told.
//
// A page costs one statement for the projects' timezones and one per day the
// page's schemes are judged on (today, for a page of schemes in force).
import type { CollectionGroup, SchemeGeneration, SchemeSeason } from "@waste/contracts/route-schemes"
import type { Tx } from "@waste/db/client"
import { dayInTimezone } from "@waste/db/commands/days"
import { validOn } from "@waste/db/query/valid-on"
import { subscription } from "@waste/db/schema/agreements"
import { product, serviceFrequency } from "@waste/db/schema/catalogue"
import { container, containerServicePlacement } from "@waste/db/schema/containers"
import { project } from "@waste/db/schema/organisation"
import type { RecurrenceFrequency, ServiceDay } from "@waste/domain/planning/vocabulary"
import { addDays, cadenceOn } from "@waste/domain/route-schemes/recurrence"
import { schemeSeasonsOf } from "@waste/domain/route-schemes/scheme-seasons"
import { schemeFrequencyReconciliationWarnings, servedFrequencyPromises } from "@waste/domain/route-schemes/validation"
import { intervalCollectionsPerWeek } from "@waste/domain/service-frequencies"
import { and, eq, inArray, sql } from "drizzle-orm"

/** What the reconciliation reads of one scheme: its row's recurrence and period, its groups, and what its runs matched. */
export type SchemeToReconcile = {
  id: string
  projectId: string
  frequency: string
  validFrom: string
  validTo: string | null
  groups: readonly CollectionGroup[]
  generation: SchemeGeneration
  /** The scheme's seasons (O17 of #290): the cadence in force on the day judged may be a season's. */
  seasons?: readonly SchemeSeason[]
}

/** One container's promise on a day: its label, and its effective frequency's name and interval, null where it has none. */
type PromiseRow = {
  containerId: string
  label: string
  name: string | null
  collectionsPerWeek: number | null
  weeksBetween: number | null
  daysBetween: number | null
}

/** Each running group's days with the containers it collects: a manual group's picks, a rule group's latest match. */
function plansOf(scheme: SchemeToReconcile): Array<{ day: ServiceDay; containerIds: string[] }> {
  const matched = new Map(scheme.generation.groups.map((group) => [group.groupId, group.latest.containerIds]))
  return scheme.groups.flatMap((group) => {
    const containerIds = group.stopSource === "manual" ? group.containerIds : (matched.get(group.id) ?? [])
    return containerIds.length === 0 ? [] : group.days.map((day) => ({ day, containerIds }))
  })
}

/** The cadence the scheme runs at on the day: the season's in force there (O17 of #290), or its own. */
function frequencyOn(scheme: Pick<SchemeToReconcile, "frequency" | "validFrom" | "seasons">, day: string): RecurrenceFrequency {
  const seasons = schemeSeasonsOf(scheme.seasons ?? [])
  return cadenceOn({ frequency: scheme.frequency as RecurrenceFrequency, serviceDays: [], effectiveFrom: scheme.validFrom, effectiveTo: "", seasons }, day).frequency
}

/** The day a scheme is judged on: its start or today, whichever is later, held inside its period. */
export function reconciledOn(scheme: Pick<SchemeToReconcile, "validFrom" | "validTo">, today: string): string {
  const from = today > scheme.validFrom ? today : scheme.validFrom
  return scheme.validTo !== null && from >= scheme.validTo ? addDays(scheme.validTo, -1) : from
}

/** The promises of the containers asked for, as their placements in force on `day` say them. */
async function promisesOn(tx: Tx, companyId: string, day: string, containerIds: readonly string[]): Promise<PromiseRow[]> {
  if (containerIds.length === 0) return []
  return tx
    .select({
      containerId: container.id,
      label: container.label,
      name: serviceFrequency.name,
      collectionsPerWeek: serviceFrequency.collectionsPerWeek,
      weeksBetween: serviceFrequency.weeksBetween,
      daysBetween: serviceFrequency.daysBetween,
    })
    .from(containerServicePlacement)
    .innerJoin(container, and(eq(container.companyId, containerServicePlacement.companyId), eq(container.id, containerServicePlacement.containerId)))
    .innerJoin(subscription, and(eq(subscription.companyId, containerServicePlacement.companyId), eq(subscription.id, containerServicePlacement.subscriptionId)))
    .innerJoin(product, and(eq(product.companyId, subscription.companyId), eq(product.id, subscription.productId)))
    .leftJoin(
      serviceFrequency,
      and(
        eq(serviceFrequency.companyId, containerServicePlacement.companyId),
        eq(serviceFrequency.id, sql`coalesce(${containerServicePlacement.serviceFrequencyId}, ${product.serviceFrequencyId})`),
      ),
    )
    .where(and(eq(containerServicePlacement.companyId, companyId), inArray(containerServicePlacement.containerId, [...containerIds]), validOn(containerServicePlacement, day)))
}

/**
 * The warnings of every scheme asked for, by scheme id: the containers each
 * collects whose promise its cadence under- or over-serves. A scheme
 * collecting no container with a standing promise has none.
 */
export async function schemeWarningsOf(tx: Tx, companyId: string, schemes: readonly SchemeToReconcile[], now: () => Date): Promise<Map<string, string[]>> {
  const warnings = new Map<string, string[]>()
  const plans = new Map(schemes.map((scheme) => [scheme.id, plansOf(scheme)]))
  const reconciled = schemes.filter((scheme) => (plans.get(scheme.id) ?? []).length > 0)
  for (const scheme of schemes) warnings.set(scheme.id, [])
  if (reconciled.length === 0) return warnings

  const projectIds = [...new Set(reconciled.map((scheme) => scheme.projectId))]
  const zones = await tx
    .select({ id: project.id, timezone: project.timezone })
    .from(project)
    .where(and(eq(project.companyId, companyId), inArray(project.id, projectIds)))
  const instant = now()
  const todayOf = new Map(zones.map((zone) => [zone.id, dayInTimezone(instant, zone.timezone)]))

  const byDay = new Map<string, SchemeToReconcile[]>()
  for (const scheme of reconciled) {
    const today = todayOf.get(scheme.projectId)
    if (today === undefined) throw new Error(`schemeWarningsOf: no project ${scheme.projectId} in company ${companyId}`)
    const day = reconciledOn(scheme, today)
    byDay.set(day, [...(byDay.get(day) ?? []), scheme])
  }

  for (const [day, onDay] of byDay) {
    const containerIds = [...new Set(onDay.flatMap((scheme) => (plans.get(scheme.id) ?? []).flatMap((plan) => plan.containerIds)))]
    const rows = await promisesOn(tx, companyId, day, containerIds)
    const containers = rows.map((row) => ({ ...row, id: row.containerId }))
    for (const scheme of onDay) {
      const promises = servedFrequencyPromises(plans.get(scheme.id) ?? [], containers, (row) => {
        const promisedRate = intervalCollectionsPerWeek(row)
        return row.name === null || promisedRate === null ? null : { containerName: row.label, promisedName: row.name, promisedRate }
      })
      warnings.set(scheme.id, schemeFrequencyReconciliationWarnings({ frequency: frequencyOn(scheme, day), promises }))
    }
  }
  return warnings
}
