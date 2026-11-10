// A property's notification zones (O29 of #290, row 1.13) as its details
// read them: the Planning Areas of purpose `notification` whose boundary in
// force today contains the property's point, from `GET /properties/:id/zones`
// (`propertyZones`, lib/api/property-details.ts).
// Two zones may overlap, so a property can lie in several; a property with no
// point yet lies in none until it is placed. The collection days are not read
// from here: they come from the property's subscriptions and the schemes that
// collect them.
import type { PlanningAreasAt } from "@waste/contracts/planning-areas"

import { type Grants, mayOn } from "@/lib/modules/grants"

/** Whether the role reads a property's zones: the property's own grant, the API's for the read. */
export const zonesReadable = (grants: Grants | null): boolean => mayOn(grants, "customers.properties", "view")

/** What the details say of the zones: their names in code order, or why there are none. */
export function zonesSentence(read: Pick<PlanningAreasAt, "on" | "items">, placed: boolean): string {
  if (!placed) return "No point yet: place the property to read its notification zone."
  if (read.items.length === 0) return `No notification zone holds this property on ${read.on}.`
  const names = read.items.map((zone) => `${zone.name} (${zone.code})`).join(", ")
  return `${read.items.length === 1 ? "Notification zone" : "Notification zones"} on ${read.on}: ${names}.`
}
