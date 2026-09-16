// Everything the guided setup derives from its draft and the records, in one
// pure function: the recurrence and next dates, the resolved collection
// groups with their estimates, the step-3 issues (product rules plus the
// engine's remaining blocking issues), the gates, and the rail summaries.
// Steps render this; nothing here touches React or the store.

import type { BusinessRecord } from "@/lib/data/business-modules"
import { calendarFromRecord, type CollectionCalendar } from "@/lib/route-schemes/calendar"
import { draftRecurrence, resolvedDraftGroups, validateGuidedScheme } from "@/lib/route-schemes/draft"
import {
  estimateLoadTonnes,
  estimateRoute,
  type ContainerWeightResolver,
  type RouteEstimate,
} from "@/lib/route-schemes/estimates"
import type { DriverProfile, VehicleProfile } from "@/lib/route-schemes/fleet-profiles"
import {
  checkCollectionGroups,
  withoutDuplicatedEngineIssues,
  type GroupCheckKind,
} from "@/lib/route-schemes/group-checks"
import {
  issuesByGroup,
  type CollectionGroup,
  type CollectionGroupDayPlan,
  type CollectionGroupResolution,
} from "@/lib/route-schemes/groups"
import { SCHEME_GROUP_COLORS } from "@/lib/route-schemes/map"
import {
  containerMatchProfile,
  resolveStopMatches,
  type ContainerMatchProfile,
} from "@/lib/route-schemes/matching"
import { occurrencePreview, type OccurrencePreview } from "@/lib/route-schemes/occurrences"
import type { GuidedSchemeData } from "@/lib/route-schemes/quick-create"
import {
  recurrenceCadenceLabel,
  serviceDaysRangeLabel,
  sortServiceDays,
  type SchemeRecurrence,
  type ServiceDay,
} from "@/lib/route-schemes/recurrence"
import type { SchemeValidationResult } from "@/lib/route-schemes/validation"

import { formatClockTime } from "@/lib/route-schemes/occurrences"
import type { WizardRecords } from "./use-wizard-records"

export type WizardGroupSummary = {
  group: CollectionGroup
  color: string
  vehicle: VehicleProfile | null
  driver: DriverProfile | null
  /** Every container the group's rule matches, before same-day tie-breaks. */
  matched: ContainerMatchProfile[]
  /** Stops on the group's fullest day after tie-breaks. */
  stops: number
  loadT: number
  estimate: RouteEstimate
}

export type WizardRoute = {
  day: ServiceDay
  summary: WizardGroupSummary
  plan: CollectionGroupDayPlan
  estimate: RouteEstimate
  loadT: number
}

export type WizardIssue = {
  kind: GroupCheckKind | "engine"
  text: string
  groupIds: string[]
  resourceId?: string
}

export type WizardModel = {
  calendar: CollectionCalendar | null
  calendarRecord: BusinessRecord | undefined
  recurrence: SchemeRecurrence | null
  occurrences: OccurrencePreview
  resolution: CollectionGroupResolution
  groups: WizardGroupSummary[]
  routesOn: (day: ServiceDay) => WizardRoute[]
  issues: WizardIssue[]
  validation: SchemeValidationResult
  totalContainers: number
  routesPerWeek: number
  serviceDays: ServiceDay[]
  step1Ok: boolean
  step2Ok: boolean
  step3Ok: boolean
  summaries: Record<1 | 2 | 3 | 4, string>
  nameOf: (records: readonly BusinessRecord[], id: string | undefined) => string | undefined
  vehicleById: (id: string | undefined) => VehicleProfile | null
  driverById: (id: string | undefined) => DriverProfile | null
  containerProfile: (id: string) => ContainerMatchProfile | undefined
  weightKg: ContainerWeightResolver
}

export function groupColor(index: number): string {
  return SCHEME_GROUP_COLORS[index % SCHEME_GROUP_COLORS.length]
}

export function buildWizardModel(data: GuidedSchemeData, records: WizardRecords): WizardModel {
  const nameOf = (list: readonly BusinessRecord[], id: string | undefined) =>
    id ? list.find((record) => record.id === id)?.name : undefined
  const calendarRecord = records.calendars.find((record) => record.id === data.calendarId)
  const calendar = calendarFromRecord(calendarRecord)
  const recurrence = draftRecurrence(data)
  const serviceDays = sortServiceDays(data.serviceDays)
  const occurrences = recurrence
    ? occurrencePreview({ recurrence, holidayPolicy: data.holidayPolicy, calendar })
    : { rows: [], ongoing: !data.effectiveTo, horizon: null, count: 0 }

  const vehicles = new Map(records.vehicleProfiles.map((profile) => [profile.id, profile]))
  const drivers = new Map(records.driverProfiles.map((profile) => [profile.id, profile]))
  const vehicleById = (id: string | undefined) => (id ? vehicles.get(id) ?? null : null)
  const driverById = (id: string | undefined) => (id ? drivers.get(id) ?? null : null)

  const profiles = new Map(
    records.containers.map((record) => [record.id, containerMatchProfile(record)]),
  )
  const containerProfile = (id: string) => profiles.get(id)
  const profilesOf = (ids: readonly string[]) =>
    ids.map(containerProfile).filter((profile): profile is ContainerMatchProfile => Boolean(profile))

  const resolution = resolvedDraftGroups(data, records.containers)
  const projectIds = data.projectId ? [data.projectId] : undefined

  const groups: WizardGroupSummary[] = data.groups.map((group, index) => {
    const vehicle = vehicleById(group.vehicleId)
    const matched =
      group.stopSource === "rule"
        ? resolveStopMatches({
            rule: {
              fractions: [...group.fractions],
              ...(group.ruleVehicleType ? { vehicleType: group.ruleVehicleType } : {}),
              ...(group.containerTypes && group.containerTypes.length > 0
                ? { containerTypes: [...group.containerTypes] }
                : {}),
            },
            areaId: data.planningAreaId,
            projectIds,
            containers: records.containers,
          }).matched
        : profilesOf(group.containerIds)
    const plans = resolution.plans.filter((plan) => plan.groupId === group.id)
    const fullest = plans.reduce<CollectionGroupDayPlan | null>(
      (best, plan) => (!best || plan.containerIds.length > best.containerIds.length ? plan : best),
      null,
    )
    const stopProfiles = fullest ? profilesOf(fullest.containerIds) : matched
    const loadT = estimateLoadTonnes(stopProfiles, records.weightKg)
    const stops = fullest ? fullest.containerIds.length : matched.length
    return {
      group,
      color: groupColor(index),
      vehicle,
      driver: driverById(group.driverId),
      matched,
      stops,
      loadT,
      estimate: estimateRoute({ stops, loadT, capacityT: vehicle?.capacityT }),
    }
  })
  const summaryById = new Map(groups.map((summary) => [summary.group.id, summary]))

  const routesOn = (day: ServiceDay): WizardRoute[] =>
    resolution.plans
      .filter((plan) => plan.day === day)
      .flatMap((plan) => {
        const summary = summaryById.get(plan.groupId)
        if (!summary) return []
        const loadT = estimateLoadTonnes(profilesOf(plan.containerIds), records.weightKg)
        return [
          {
            day,
            summary,
            plan,
            loadT,
            estimate: estimateRoute({
              stops: plan.containerIds.length,
              loadT,
              capacityT: summary.vehicle?.capacityT,
            }),
          },
        ]
      })

  const validation = validateGuidedScheme(
    data,
    records.schemes,
    calendar,
    records.allocations,
    records.containers,
    records.vehicles,
  )
  const engineIssues = withoutDuplicatedEngineIssues(validation.issues)
  const attributed = issuesByGroup(data.groups, engineIssues)
  const issues: WizardIssue[] = [
    ...checkCollectionGroups({
      groups: data.groups,
      serviceDays,
      vehicleLabelOf: (id) => vehicleById(id)?.callsign,
      driverNameOf: (id) => driverById(id)?.name,
    }).map((issue) => ({
      kind: issue.kind,
      text: issue.text,
      groupIds: issue.groupIds,
      ...(issue.resourceId ? { resourceId: issue.resourceId } : {}),
    })),
    ...engineIssues.map((text) => ({
      kind: "engine" as const,
      text,
      groupIds: [...attributed.entries()].filter(([, texts]) => texts.includes(text)).map(([id]) => id),
    })),
  ]

  const totalContainers = groups.reduce((sum, summary) => sum + summary.stops, 0)
  const routesPerWeek = data.groups.reduce(
    (sum, group) => sum + group.days.filter((day) => serviceDays.includes(day)).length,
    0,
  )

  const step1Ok = Boolean(data.schemeName.trim() && data.projectId && data.planningAreaId)
  const step2Ok = serviceDays.length > 0 && occurrences.rows.length > 0
  const step3Ok = issues.length === 0

  const summaries: WizardModel["summaries"] = {
    1: [nameOf(records.areas, data.planningAreaId), nameOf(records.calendars, data.calendarId)]
      .filter(Boolean)
      .join(" · "),
    2:
      recurrence && serviceDays.length > 0
        ? [
            recurrenceCadenceLabel(recurrence),
            serviceDaysRangeLabel(serviceDays),
            formatClockTime(data.plannedStartTime),
          ]
            .filter(Boolean)
            .join(" · ")
        : "",
    3:
      groups.length > 0
        ? `${groups.length} group${groups.length === 1 ? "" : "s"} · ${totalContainers.toLocaleString("en-GB")} containers`
        : "",
    4: groups.length > 0 ? `${routesPerWeek} routes per week` : "",
  }

  return {
    calendar,
    calendarRecord,
    recurrence,
    occurrences,
    resolution,
    groups,
    routesOn,
    issues,
    validation,
    totalContainers,
    routesPerWeek,
    serviceDays,
    step1Ok,
    step2Ok,
    step3Ok,
    summaries,
    nameOf,
    vehicleById,
    driverById,
    containerProfile,
    weightKg: records.weightKg,
  }
}
