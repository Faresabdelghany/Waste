// Route Scheme guided-setup validation and per-day service plans (spec
// docs/specs/ROUTE_SCHEMES.md, FR-5/FR-14). Pure data logic — no UI, store,
// or fixture dependencies — so the wizard's review step and the record
// creation path share one definition of "is this scheme Validated or Draft",
// and the generation engine can read a scheme's per-day plans back from its
// submittedValues.

import {
  SERVICE_DAYS,
  SERVICE_DAY_SHORT_LABELS,
  parseServiceDays,
  sortServiceDays,
  type ServiceDay,
} from "./recurrence"

/** Container selection carried by the wizard: one shared list, or one per day. */
export type SchemeDayPlans = {
  sameAllDays: boolean
  sharedContainerIds: string[]
  containersByDay: Partial<Record<ServiceDay, string[]>>
}

export type SchemeDayPlan = { day: ServiceDay; containerIds: string[] }

export const EMPTY_DAY_PLANS: SchemeDayPlans = {
  sameAllDays: true,
  sharedContainerIds: [],
  containersByDay: {},
}

const shortDays = (days: readonly ServiceDay[]): string =>
  sortServiceDays(days)
    .map((day) => SERVICE_DAY_SHORT_LABELS[day])
    .join(", ")

/** One generated route per service day: that day and its stop list (FR-14). */
export function effectiveDayPlans(
  serviceDays: readonly ServiceDay[],
  plans: SchemeDayPlans,
): SchemeDayPlan[] {
  return sortServiceDays(serviceDays).map((day) => ({
    day,
    containerIds: plans.sameAllDays
      ? plans.sharedContainerIds
      : (plans.containersByDay[day] ?? []),
  }))
}

/** "Wed 11 · Sun 11" — the review-step and record-fact counts line. */
export function dayPlanCountSummary(plans: readonly SchemeDayPlan[]): string {
  if (plans.length === 0) return "No service days"
  return plans
    .map((plan) => `${SERVICE_DAY_SHORT_LABELS[plan.day]} ${plan.containerIds.length}`)
    .join(" · ")
}

export type SchemeValidationInput = {
  serviceDays: ServiceDay[]
  effectiveFrom: string
  effectiveTo: string
  plans: SchemeDayPlans
  plannedVehicleId?: string
  plannedDriverId?: string
}

/** What FR-5(d) needs to know about an already-existing scheme. */
export type SchemeDefaultsSource = {
  schemeName: string
  serviceDays: readonly ServiceDay[]
  plannedVehicleId?: string
  plannedDriverId?: string
}

export type SchemeValidationResult = {
  status: "Validated" | "Draft"
  issues: string[]
}

/**
 * The blocking checks of FR-5, in spec order: (a) ≥1 service day,
 * (b) effective from/to set with to ≥ from, (c) every service day has ≥1
 * container (per-day mode names the empty days), (d) the default vehicle or
 * driver is not already the default on another scheme sharing a service day.
 * All pass → Validated; any fail → Draft with the issues named.
 */
export function validateScheme(
  input: SchemeValidationInput,
  otherSchemes: readonly SchemeDefaultsSource[] = [],
): SchemeValidationResult {
  const issues: string[] = []

  if (input.serviceDays.length === 0) issues.push("Pick at least one service day")

  if (!input.effectiveFrom || !input.effectiveTo) {
    issues.push("Set the effective from and to dates")
  } else if (input.effectiveTo < input.effectiveFrom) {
    issues.push("Effective to must be on or after effective from")
  }

  if (input.serviceDays.length > 0) {
    const emptyDays = effectiveDayPlans(input.serviceDays, input.plans)
      .filter((plan) => plan.containerIds.length === 0)
      .map((plan) => plan.day)
    if (emptyDays.length > 0) {
      issues.push(
        input.plans.sameAllDays
          ? "Pick at least one container"
          : `Pick containers for ${shortDays(emptyDays)}`,
      )
    }
  }

  for (const other of otherSchemes) {
    const sharedDays = input.serviceDays.filter((day) => other.serviceDays.includes(day))
    if (sharedDays.length === 0) continue
    const sharing = `(shares ${shortDays(sharedDays)})`
    if (input.plannedVehicleId && input.plannedVehicleId === other.plannedVehicleId) {
      issues.push(
        `Default vehicle is already the default on "${other.schemeName}" ${sharing}`,
      )
    }
    if (input.plannedDriverId && input.plannedDriverId === other.plannedDriverId) {
      issues.push(
        `Default driver is already the default on "${other.schemeName}" ${sharing}`,
      )
    }
  }

  return { status: issues.length === 0 ? "Validated" : "Draft", issues }
}

type StoredValues = Record<string, string | boolean | undefined>

const stringValue = (values: StoredValues, key: string): string | undefined => {
  const value = values[key]
  return typeof value === "string" && value ? value : undefined
}

/**
 * Reads what FR-5(d) needs from an existing scheme record's submittedValues
 * (the `route-studio.schemes` field ids, shared by quick create and the
 * wizard). Returns null for schemes that cannot conflict: no structured
 * service days (legacy free-text records) or no default assignment at all.
 */
export function schemeDefaultsFromValues(
  schemeName: string,
  values: StoredValues | undefined,
): SchemeDefaultsSource | null {
  if (!values) return null
  const serviceDays = parseServiceDays(
    typeof values.serviceDays === "string" ? values.serviceDays : "",
  )
  if (serviceDays.length === 0) return null
  const plannedVehicleId = stringValue(values, "plannedVehicleId")
  const plannedDriverId = stringValue(values, "plannedDriverId")
  if (!plannedVehicleId && !plannedDriverId) return null
  return { schemeName, serviceDays, plannedVehicleId, plannedDriverId }
}

/**
 * The submittedValues shape carrying a scheme's container plans: the shared
 * list under `containerIds` (comma-separated, matching the guided-route
 * convention) and the per-day lists under `containersByDay` as JSON.
 */
export function dayPlansToValues(plans: SchemeDayPlans): {
  sameAllDays: boolean
  containerIds: string
  containersByDay: string
} {
  return {
    sameAllDays: plans.sameAllDays,
    containerIds: plans.sharedContainerIds.join(","),
    containersByDay: JSON.stringify(plans.containersByDay),
  }
}

const isServiceDay = (value: string): value is ServiceDay =>
  (SERVICE_DAYS as readonly string[]).includes(value)

export function dayPlansFromValues(values: StoredValues | undefined): SchemeDayPlans {
  if (!values) return EMPTY_DAY_PLANS
  const sharedContainerIds =
    typeof values.containerIds === "string" && values.containerIds
      ? values.containerIds.split(",").filter(Boolean)
      : []
  const containersByDay: Partial<Record<ServiceDay, string[]>> = {}
  if (typeof values.containersByDay === "string" && values.containersByDay) {
    try {
      const parsed: unknown = JSON.parse(values.containersByDay)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [day, ids] of Object.entries(parsed)) {
          if (!isServiceDay(day) || !Array.isArray(ids)) continue
          containersByDay[day] = ids.filter(
            (id): id is string => typeof id === "string" && Boolean(id),
          )
        }
      }
    } catch {
      // Hand-edited or corrupted storage: fall back to no per-day plans.
    }
  }
  return {
    sameAllDays: values.sameAllDays !== false,
    sharedContainerIds,
    containersByDay,
  }
}
