// A Property's tanks on the Pilot (M11 of #293): the register the API keeps
// at `/tank-installations` — each tank the Container that stands for it in the
// plan — read and written from the Property's details, and the inspections
// the office records under each. Nothing is reckoned here: the last emptying
// and the day the next is due are the API's answer (`lastEmptying`, `dueOn`,
// the reading generation plans from), told in these sentences. The Driver
// App says a stop's tank in `tankSummary` and takes its litres through
// `litresOf`.
import type { TankEmptying, TankInspection, TankInspectionCreate, TankInstallation, TankInstallationCreate, TankInstallationPatch } from "@waste/contracts/tanks"
import type { TankInspectionOutcome, TankKind, TankOutlet } from "@waste/domain/registry/vocabulary"

import { TANK_INTERVAL_MONTHS_MAX } from "./tank-words"

import { command, create, listAll, patch, type ApiClient } from "../api/client"
import { allows, type Grants } from "../api/grants"
import type { LocalRefusal } from "../api/records/adapter"
import type { BusinessRecord } from "./business-modules"
import { thousands } from "./tank-words"

export { LITRES_MAX, litresOf, TANK_INSPECTION_OUTCOME_LABELS, TANK_INTERVAL_MONTHS_MAX, TANK_KIND_LABELS, TANK_OUTLET_LABELS, tankSummary } from "./tank-words"

/** When the next emptying is due, against the project's today. */
export function dueSentence(tank: Pick<TankInstallation, "dueOn">, today: string): string {
  if (tank.dueOn === null) return "Due now: never emptied"
  if (tank.dueOn < today) return `Overdue since ${tank.dueOn}`
  if (tank.dueOn === today) return "Due today"
  return `Next emptying due ${tank.dueOn}`
}

/** The last emptying: its container's latest completed stop with the litres recorded there, else the register's day before the platform, else none. */
export function lastEmptyingSentence(tank: { lastEmptying: TankEmptying | null; lastEmptiedOn: string | null }): string {
  const { lastEmptying } = tank
  if (lastEmptying !== null) return `Last emptied ${lastEmptying.on}${lastEmptying.volumeLitres === null ? "" : ` · ${thousands.format(lastEmptying.volumeLitres)} L`}`
  if (tank.lastEmptiedOn !== null) return `Last emptied ${tank.lastEmptiedOn}, before the platform`
  return "Never emptied"
}

/** Whether the role reads the register: it is the Property's, under its module. */
export const tanksReadable = (grants: Grants | undefined): boolean => allows(grants, "customers.properties", "view")
/** Whether the role writes it: a tank and an inspection alike. */
export const tanksEditable = (grants: Grants | undefined): boolean => allows(grants, "customers.properties", "edit")

const wholeNumber = (value: string): number | undefined => (/^\d+$/.test(value.trim()) ? Number(value.trim()) : undefined)

/** What the Register tank form holds: the container by server id, the rest as typed. */
export type TankTyped = { containerId: string; kind: string; volumeLitres: string; outlet: string; emptyingIntervalMonths: string; lastEmptiedOn: string; validFrom: string; notes: string }

/** The tank's body, or the refusal at the field the office has to fix first. */
export function tankBodyOf(typed: TankTyped, propertyServerId: string): TankInstallationCreate | LocalRefusal {
  if (typed.containerId === "") return { path: "containerId", message: "Pick the container that stands for the tank" }
  const volumeLitres = wholeNumber(typed.volumeLitres)
  if (volumeLitres === undefined || volumeLitres < 1) return { path: "volumeLitres", message: "What the tank holds, in whole litres" }
  const months = wholeNumber(typed.emptyingIntervalMonths)
  if (months === undefined || months < 1 || months > TANK_INTERVAL_MONTHS_MAX) return { path: "emptyingIntervalMonths", message: "Between 1 and 120 whole months" }
  if (typed.validFrom === "") return { path: "validFrom", message: "Pick the tank's first day in the register" }
  if (typed.lastEmptiedOn !== "" && typed.lastEmptiedOn > typed.validFrom) return { path: "lastEmptiedOn", message: "A last emptying before the platform comes before the tank's first day" }
  const notes = typed.notes.trim()
  return {
    propertyId: propertyServerId,
    containerId: typed.containerId,
    kind: typed.kind as TankKind,
    volumeLitres,
    outlet: typed.outlet as TankOutlet,
    emptyingIntervalMonths: months,
    validFrom: typed.validFrom,
    ...(typed.lastEmptiedOn === "" ? {} : { lastEmptiedOn: typed.lastEmptiedOn }),
    ...(notes === "" ? {} : { notes }),
  }
}

/** What the Record inspection form holds. */
export type InspectionTyped = { inspectedOn: string; outcome: string; findings: string; nextInspectionOn: string }

/** The inspection's body, or the refusal at the field the office has to fix first. */
export function inspectionBodyOf(typed: InspectionTyped): TankInspectionCreate | LocalRefusal {
  if (typed.inspectedOn === "") return { path: "inspectedOn", message: "Pick the day the tank was inspected" }
  if (typed.nextInspectionOn !== "" && typed.nextInspectionOn <= typed.inspectedOn) return { path: "nextInspectionOn", message: "The next inspection comes after this one" }
  const findings = typed.findings.trim()
  return {
    inspectedOn: typed.inspectedOn,
    outcome: typed.outcome as TankInspectionOutcome,
    ...(findings === "" ? {} : { findings }),
    ...(typed.nextInspectionOn === "" ? {} : { nextInspectionOn: typed.nextInspectionOn }),
  }
}

/** A Property's tanks, every one, oldest first: a property has a handful. */
export const tanksOfProperty = (client: ApiClient, propertyServerId: string): Promise<TankInstallation[]> => listAll<TankInstallation>(client, "/tank-installations", { propertyId: propertyServerId })

/** A tank's inspections, oldest first. */
export const inspectionsOf = (client: ApiClient, tankId: string): Promise<TankInspection[]> => listAll<TankInspection>(client, `/tank-installations/${tankId}/inspections`)

export const registerTank = async (client: ApiClient, body: TankInstallationCreate): Promise<TankInstallation> => (await create<TankInstallation>(client, "/tank-installations", body)).body

export const changeTank = (client: ApiClient, tankId: string, body: TankInstallationPatch): Promise<TankInstallation> => patch<TankInstallation>(client, `/tank-installations/${tankId}`, body)

export const recordInspection = (client: ApiClient, tankId: string, body: TankInspectionCreate): Promise<TankInspection> => command<TankInspection>(client, `/tank-installations/${tankId}/inspections`, body)

/**
 * The containers a tank at the Property may name: those whose record says
 * they serve it today — located, under its `Property` fact; not yet located,
 * under `Serves at` — by label. The API judges the placement on the tank's
 * first day again, and says so where it does not serve there.
 */
export function containersAtProperty(containers: readonly BusinessRecord[], property: Pick<BusinessRecord, "name">): BusinessRecord[] {
  const serves = (container: BusinessRecord) => container.facts.Property === property.name || (container.facts["Serves at"]?.startsWith(`${property.name},`) ?? false)
  return containers.filter(serves).sort((a, b) => a.name.localeCompare(b.name))
}
